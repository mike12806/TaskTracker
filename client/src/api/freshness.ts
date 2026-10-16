/**
 * Tracks whether the data on screen is current, or a leftover the app hasn't
 * managed to refresh.
 *
 * The service worker keeps no copy of API data at all (see `sw.ts`), so in
 * steady state every rendered entry came from the server this session. What
 * can still go stale is the screen itself: a refresh that *fails* leaves the
 * previous data visible, and this module is how the UI knows to say so —
 * `markOffline` on a failed request raises the flag, the next successful
 * reply clears it, and `Layout` shows the banner in between.
 *
 * The header check and clock reasoning in `noteResponse` survive for the
 * cases where a cached reply can still reach the app: the first load after
 * upgrading from a build that did cache (its worker answers that one load and
 * may stamp `FROM_CACHE_HEADER`), and any intermediary that ignores
 * `Cache-Control: no-store`. Belt and braces — in the priority order here,
 * calling stale data stale is worth a false alarm.
 */

import { FROM_CACHE_HEADER } from "../serviceWorkerContract";

/** Treat data as stale once it is this far behind the server clock (ms). */
const STALE_AFTER_MS = 2 * 60 * 1000;

/**
 * Best estimate of `serverClock - localClock` (ms).
 *
 * A phone whose clock is minutes off would otherwise make every fresh reply
 * look ancient, so ages are measured against the server's own clock rather
 * than the device's. A reply is always generated *before* it arrives, so
 * `Date - now` for any single response is at most the true skew — the largest
 * sample seen is therefore the best estimate, and one taken from a cached
 * reply only ever drags it down. That biases us toward calling stale data
 * fresh, never the reverse, which is the safe direction for a false alarm.
 */
let clockSkewMs: number | null = null;

/** When the data being shown was generated (local ms), or null if it's fresh. */
let staleSince: number | null = null;

const listeners = new Set<() => void>();

function setStaleSince(value: number | null): void {
  if (staleSince === value) return;
  staleSince = value;
  for (const listener of listeners) listener();
}

/**
 * Record a successful response and update the staleness flag.
 *
 * Mutations are worth passing in too: a POST that comes back at all proves
 * the server is reachable, which is exactly what clears the banner.
 */
export function noteResponse(res: Response): void {
  // Only consulted where nothing better is available — see below. It is not
  // trustworthy on its own: `navigator.onLine === false` is documented as
  // "definitely offline", but in practice installed PWAs, VPNs and captive
  // portals all report it while the network works fine, and a phone that
  // reports it wrongly used to pin this app in the stale state forever.
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;

  // Headers are optional-chained rather than assumed: this sits on the path of
  // every single request, and it exists only to label the UI — it must never
  // be the reason a response fails to come back.
  const header = res.headers?.get("date");
  const servedAt = header ? Date.parse(header) : NaN;

  // A reply labelled as a cache hit states outright what everything below
  // infers. Only reachable during the one load served by a previous build's
  // worker, but for that load it is authoritative.
  if (res.headers?.get(FROM_CACHE_HEADER) === "1") {
    const generatedAt = Number.isNaN(servedAt) ? Date.now() : servedAt - (clockSkewMs ?? 0);
    setStaleSince(Math.min(generatedAt, staleSince ?? generatedAt));
    return;
  }
  if (Number.isNaN(servedAt)) {
    // No usable `Date` (a dev server, or a mocked response in tests): fall
    // back to the connectivity signal alone rather than guessing at an age.
    if (offline) setStaleSince(staleSince ?? Date.now());
    else setStaleSince(null);
    return;
  }

  const now = Date.now();
  // Whether a *previous* reply already calibrated the clock. The first sample
  // of a session is absorbed wholesale into the skew estimate, so on a cold
  // start even a 45-minute-old cached reply measures as brand new — age is
  // not evidence of anything yet.
  const hadCalibration = clockSkewMs !== null;
  const sample = servedAt - now;
  if (clockSkewMs === null || sample > clockSkewMs) clockSkewMs = sample;

  const generatedAt = servedAt - clockSkewMs; // in local-clock terms
  const age = now - generatedAt;

  // Once the clock is calibrated, a recent `Date` on a non-cached reply is
  // positive proof the server was reachable a moment ago — better evidence
  // than any flag, so it is not second-guessed by one.
  //
  // This used to require `!offline` unconditionally, which meant a device
  // wrongly reporting itself offline could never clear the banner however
  // many requests succeeded: every reply landed here, failed the `!offline`
  // half, and re-flagged the screen as stale. The retry loop then pinged
  // every 15 seconds forever, refetching every mounted page each time it got
  // an answer — which is what "the page reloads a few times" looked like.
  //
  // Before calibration the hint still gets its say, because `age` cannot yet
  // contradict it.
  if (age < STALE_AFTER_MS && (hadCalibration || !offline)) {
    setStaleSince(null);
    return;
  }
  // Several endpoints load in parallel; report the oldest thing on screen.
  setStaleSince(Math.min(generatedAt, staleSince ?? generatedAt));
}

/**
 * Record that the server could not be reached, so whatever is on screen is
 * only as current as the last refresh that worked.
 *
 * This is the main way staleness starts now: with no offline cache, a dead
 * network means requests throw, and a request that throws never reaches
 * `noteResponse`. The first stamp wins — the screen has been stale since the
 * first failure, not the latest one.
 */
export function markOffline(): void {
  setStaleSince(staleSince ?? Date.now());
}

/** Subscribe to staleness changes. Returns an unsubscribe function. */
export function subscribeFreshness(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** When the data on screen was generated (local ms), or null if it's fresh. */
export function getStaleSince(): number | null {
  return staleSince;
}

/** Test seam — drops the calibrated skew and any recorded staleness. */
export function resetFreshness(): void {
  clockSkewMs = null;
  staleSince = null;
  for (const listener of listeners) listener();
}
