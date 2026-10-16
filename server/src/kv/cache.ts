/**
 * A tiny read-through cache over the `CACHE` KV namespace.
 *
 * ## Why KV at all, when D1 is right there
 *
 * D1 stays the source of truth for everything — nothing in this file stores
 * anything you cannot rebuild by asking D1 (or Cloudflare Access) again. What
 * KV buys is the *read path*: a KV read is served from the colo the request
 * landed in, while a D1 read crosses the network to wherever the database
 * lives. For a value that is written once a day and read on every page load,
 * that is the difference between paying for the round trip once and paying for
 * it every time.
 *
 * So the rule for what belongs here is not "is it hot" but **"is a slightly
 * stale answer still a correct answer"**. KV is eventually consistent: a write
 * can take up to a minute to be visible everywhere, which is fine for a note
 * written by a morning cron and disastrous for a task ticked off thirty
 * seconds ago on another device. Task data is therefore never cached here — see the list
 * in `server/AGENTS.md` for what is, and why each one qualifies.
 *
 * ## Failure is not an error
 *
 * Every function below swallows its errors and logs. A cache is an
 * optimisation, and an optimisation that can fail the request it was meant to
 * speed up is worse than no cache: without the binding (tests, local dev
 * without `wrangler dev`) or with KV having a bad minute, every call here
 * quietly degrades to "miss" and the caller reads D1 exactly as it did before
 * this file existed. That is also why `Env.CACHE` is optional, like `LIVE` and
 * the queues.
 */

import type { Context } from "hono";
import type { Env } from "../types/env.js";

/**
 * KV's own floor for `expirationTtl`. Anything shorter is rejected outright,
 * so it is clamped rather than passed through — a caller asking for 10 seconds
 * should get a working 60-second cache, not a silently failing write.
 */
export const MIN_TTL_SECONDS = 60;

/**
 * Stored values are wrapped rather than written bare.
 *
 * `KVNamespace.get(key, "json")` answers `null` both for "no such key" and for
 * a key holding the literal `null`, and the difference matters: "there is no
 * briefing yet" is a real answer worth caching, and without the wrapper it would be
 * indistinguishable from a miss and re-read from D1 on every request.
 */
interface Envelope<T> {
  v: T;
}

/**
 * Read one value. `undefined` means "not cached" (missing, expired, unusable,
 * or KV is unavailable); a cached `null` comes back as `null`.
 */
export async function cacheGet<T>(env: Env, key: string): Promise<T | undefined> {
  if (!env.CACHE) return undefined;
  try {
    const stored = await env.CACHE.get<Envelope<T>>(key, "json");
    // A value written by an older schema version cannot land here — the
    // version is part of the key — so anything that is not an envelope is
    // corrupt, and treating it as a miss rewrites it on the way back.
    if (!stored || typeof stored !== "object" || !("v" in stored)) return undefined;
    return stored.v;
  } catch (error) {
    console.error(`KV read failed for "${key}":`, error);
    return undefined;
  }
}

/** Write one value with a TTL. Best effort — a failure is logged, not thrown. */
export async function cachePut<T>(env: Env, key: string, value: T, ttlSeconds: number): Promise<void> {
  if (!env.CACHE) return;
  try {
    await env.CACHE.put(key, JSON.stringify({ v: value } satisfies Envelope<T>), {
      expirationTtl: Math.max(MIN_TTL_SECONDS, Math.floor(ttlSeconds)),
    });
  } catch (error) {
    console.error(`KV write failed for "${key}":`, error);
  }
}

/**
 * Drop one key, so the next read goes to D1.
 *
 * Called from the write paths, and the reason every TTL in `ttl.ts` is also
 * short enough to be tolerable on its own: KV deletes are eventually
 * consistent too, so an invalidation is how the cache *usually* catches up and
 * the TTL is how it is *guaranteed* to.
 */
export async function cacheDelete(env: Env, key: string): Promise<void> {
  if (!env.CACHE) return;
  try {
    await env.CACHE.delete(key);
  } catch (error) {
    console.error(`KV delete failed for "${key}":`, error);
  }
}

/** `ExecutionContext.waitUntil`, narrowed to what the cache needs from it. */
export type WaitUntil = (promise: Promise<unknown>) => void;

/**
 * The `waitUntil` for this request, or `undefined` where there isn't one.
 *
 * Hono's `c.executionCtx` *throws* rather than returning undefined when the
 * context was built without one, which is the normal case in tests (a plain
 * `app.request()` passes no ExecutionContext). Catching that here keeps every
 * call site a one-liner instead of each having to know that.
 */
export function backgroundWrites(c: Context): WaitUntil | undefined {
  try {
    const ctx = c.executionCtx;
    return (promise) => ctx.waitUntil(promise);
  } catch {
    return undefined;
  }
}

/**
 * Read through the cache: hit, or run `load()` and write what it returns.
 *
 * `load` is never wrapped in a try/catch — a D1 failure is a real failure and
 * belongs to the caller, unlike a KV one.
 *
 * **Pass `waitUntil` from anything serving a request.** Without it the write
 * back is awaited, which puts a KV round trip on the response path of every
 * miss — and makes a miss *slower* than not caching at all, since the caller
 * now waits for the D1 read *and* the KV write where before it waited only for
 * the read. That is a real regression on exactly the requests that were
 * already the slow ones, and it is invisible in a hit-rate metric.
 *
 * The write cannot simply be left unawaited instead: a promise the Worker
 * runtime does not know about may be cancelled once the response is sent, so
 * the cache would quietly never populate. `waitUntil` is what keeps it alive
 * past the response. `cachePut` swallows its own errors, so the promise handed
 * over never rejects.
 */
export async function cached<T>(
  env: Env,
  key: string,
  ttlSeconds: number,
  load: () => Promise<T>,
  waitUntil?: WaitUntil,
): Promise<T> {
  const hit = await cacheGet<T>(env, key);
  if (hit !== undefined) return hit;

  const value = await load();
  const write = cachePut(env, key, value, ttlSeconds);
  if (waitUntil) waitUntil(write);
  else await write;
  return value;
}
