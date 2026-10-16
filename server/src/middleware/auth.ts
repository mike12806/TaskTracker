import { MiddlewareHandler } from "hono";
import type { Env } from "../types/env.js";
import { backgroundWrites, cacheDelete, cacheGet, cachePut } from "../kv/cache.js";
import type { WaitUntil } from "../kv/cache.js";
import { jwksKey, userKey } from "../kv/keys.js";
import { JWKS_TTL_SECONDS, USER_TTL_SECONDS } from "../kv/ttl.js";

type AppEnv = { Bindings: Env; Variables: { userId: number; userEmail: string; userName: string } };

interface JwtPayload {
  email?: string;
  name?: string;
  sub?: string;
  aud?: string[];
  exp?: number;
  iss?: string;
}

/** A JWK as Access publishes it — `kid` is what picks one out of the set. */
type SigningKey = JsonWebKey & { kid?: string };

interface Jwks {
  keys: SigningKey[];
}

interface CachedUser {
  id: number;
  email: string;
  name: string;
}

const UPSERT_USER_SQL =
  "INSERT INTO users (email, name, created_at, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) ON CONFLICT(email) DO UPDATE SET name = excluded.name, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') RETURNING id, email, name";

function decodeJwtPayload(token: string): JwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(payload) as JwtPayload;
  } catch {
    return null;
  }
}

/** Ask Cloudflare Access for the current signing keys. */
async function fetchJwks(certsUrl: string): Promise<Jwks | null> {
  const certsRes = await fetch(certsUrl);
  if (!certsRes.ok) return null;
  return (await certsRes.json()) as Jwks;
}

/**
 * The signing key for one `kid`, from KV when possible.
 *
 * Before this cache every single authenticated request made a subrequest to
 * `cdn-cgi/access/certs` before it could do anything else — the same three or
 * four keys, fetched again for every page load, on the critical path of every
 * response. They are public, identical for everyone, and rotate on the order of
 * weeks, which is about as good as a cache candidate gets.
 *
 * The rotation is handled by the miss rather than by the TTL: an unknown `kid`
 * re-fetches immediately, so the first request signed with a new key pays one
 * extra fetch and every request after it is served from KV. Without that, a
 * rotation would 401 every request until the hour ran out.
 */
async function signingKeyFor(
  env: Env,
  certsUrl: string,
  kid: string | undefined,
  waitUntil?: WaitUntil,
): Promise<SigningKey | null> {
  const key = jwksKey();
  const cachedJwks = await cacheGet<Jwks>(env, key);
  const fromCache = cachedJwks?.keys?.find((k) => k.kid === kid);
  if (fromCache) return fromCache;

  const fresh = await fetchJwks(certsUrl);
  if (!fresh?.keys) return null;
  const match = fresh.keys.find((k) => k.kid === kid) ?? null;

  // Only rewrite when the fetch actually taught us something. A `kid` that is
  // still unknown after a round trip is a bad token, not a rotation, and
  // rewriting the identical key set for each one would spend the per-key KV
  // write limit on requests that are going to be rejected anyway.
  if (match || cachedJwks === undefined) {
    // Off the response path — see `cached` in kv/cache.ts. This one is on
    // *every* request that misses, so awaiting it would put a KV write in
    // front of every reply for five minutes out of every five minutes.
    const write = cachePut(env, key, fresh, JWKS_TTL_SECONDS);
    if (waitUntil) waitUntil(write);
    else await write;
  }
  return match;
}

async function verifyJwt(
  env: Env,
  token: string,
  certsUrl: string,
  audience: string,
  waitUntil?: WaitUntil,
): Promise<JwtPayload | null> {
  const payload = decodeJwtPayload(token);
  if (!payload) return null;

  // Verify audience
  if (!payload.aud || !payload.aud.includes(audience)) return null;

  // Verify expiration
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;

  // Verify the signature against Access's published keys
  const parts = token.split(".");
  const header = JSON.parse(atob(parts[0].replace(/-/g, "+").replace(/_/g, "/"))) as { kid?: string; alg?: string };

  const matchingKey = await signingKeyFor(env, certsUrl, header.kid, waitUntil);
  if (!matchingKey) return null;

  const key = await crypto.subtle.importKey(
    "jwk",
    matchingKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const sig = Uint8Array.from(atob(parts[2].replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, data);
  if (!valid) return null;

  return payload;
}

/**
 * The `users` row for this identity, creating it on first sight.
 *
 * Auth is the one path every request takes, so what used to be here — an
 * unconditional upsert plus a select, two D1 round trips before a route
 * handler saw the request — was the most-repeated database work in the Worker,
 * and almost all of it rewrote a row with the values it already held.
 *
 * The cached copy is only trusted while the name still matches the one in the
 * JWT, so a user who renames their account still gets the upsert on their
 * very next request rather than waiting out the TTL. The row's `updated_at`
 * stops moving on every request as a result, which nothing reads; what it
 * recorded was the last time the user made a request, not the last time
 * anything about them changed.
 *
 * Auto-creation is unaffected: an email nobody has seen cannot be in the cache,
 * so it takes the same insert it always did.
 */
async function resolveUser(
  env: Env,
  email: string,
  name: string,
  waitUntil?: WaitUntil,
): Promise<CachedUser | null> {
  const key = userKey(email);

  const hit = await cacheGet<CachedUser>(env, key);
  if (hit && hit.name === name && hit.email === email) return hit;

  const user = await env.DB.prepare(UPSERT_USER_SQL).bind(email, name).first<CachedUser>();

  if (!user) {
    // Whatever went wrong, do not leave a cached identity behind that outlives
    // the row it describes.
    await cacheDelete(env, key);
    return null;
  }

  // Off the response path, same as the JWKS write above.
  const write = cachePut(env, key, user, USER_TTL_SECONDS);
  if (waitUntil) waitUntil(write);
  else await write;
  return user;
}

export const authMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  // Dev mode: bypass JWT verification for local development
  if (c.env.DEV_MODE === "true") {
    const email = c.req.header("X-Dev-Email") || "dev@example.com";
    const name = c.req.header("X-Dev-Name") || "Dev User";

    const user = await resolveUser(c.env, email, name, backgroundWrites(c));
    if (!user) {
      return c.json({ error: "Failed to resolve user" }, 500);
    }

    c.set("userId", user.id);
    c.set("userEmail", user.email);
    c.set("userName", user.name);
    await next();
    return;
  }

  // Try header first, fall back to CF Access cookie (same JWT)
  let jwt = c.req.header("Cf-Access-Jwt-Assertion");
  if (!jwt) {
    const cookieHeader = c.req.header("Cookie");
    if (cookieHeader) {
      const match = cookieHeader.match(/CF_Authorization=([^;]+)/);
      if (match) jwt = match[1];
    }
  }
  if (!jwt) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const certsUrl = `https://${c.env.CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`;
  const payload = await verifyJwt(c.env, jwt, certsUrl, c.env.CF_ACCESS_AUD, backgroundWrites(c));

  if (!payload || !payload.email) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const email = payload.email;
  const name = payload.name || email;

  const user = await resolveUser(c.env, email, name, backgroundWrites(c));
  if (!user) {
    return c.json({ error: "Failed to resolve user" }, 500);
  }

  c.set("userId", user.id);
  c.set("userEmail", user.email);
  c.set("userName", user.name);

  await next();
};
