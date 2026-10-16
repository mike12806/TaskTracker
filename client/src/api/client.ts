import { ApiError } from "./errors";
import { markOffline, noteResponse } from "./freshness";
import { FROM_CACHE_HEADER } from "../serviceWorkerContract";
import { liveClientId } from "./live";

export const API_BASE = import.meta.env.VITE_API_URL || "/api";

/**
 * How long to wait for a reply before giving up on a request (ms).
 *
 * Without this a request has no failure mode at all on a phone: a radio that
 * has dropped the connection without telling anyone leaves `fetch` pending
 * indefinitely, so it never throws, `markOffline` never runs, and the banner
 * and its retry loop — the whole apparatus for saying "this data is old" —
 * never arm. The screen just sits there looking current. A request that has
 * gone this long is not going to be answered, and calling it failed is what
 * puts the app back on a path that recovers.
 */
export const REQUEST_TIMEOUT_MS = 12_000;

/**
 * The same, for the two probes below (ms).
 *
 * Shorter because nothing is waiting on their answer: they only decide whether
 * to re-auth or when to retry, and both have another tick coming.
 */
export const PROBE_TIMEOUT_MS = 6_000;

/**
 * Deadline for a request that runs a language model server-side (ms).
 *
 * Generous on purpose. Nothing is blocked on it — it is a deliberate button
 * press with a spinner — and giving up early costs the work the server has
 * already done, since the Worker keeps going regardless of whether anyone is
 * still listening.
 */
export const GENERATION_TIMEOUT_MS = 120_000;

/**
 * Is this status the API's own JWT check failing, or something upstream of
 * it doing the same job?
 *
 * Our Worker never returns 403 — every auth rejection it makes is a 401 (see
 * `server/src/middleware/auth.ts`). Cloudflare Access does return 403,
 * though, and for exactly the equivalent reason: for a page navigation an
 * expired session gets redirected to the login flow, but for a `fetch`/XHR
 * request — which is everything this client sends — Access answers 403
 * directly instead. So a 403 from this API can only be Access rejecting a
 * dead session at the edge before the request ever reached the Worker, and
 * belongs in the same bucket as our own 401: re-authenticate, don't report it
 * as a request failure.
 */
function isAuthFailure(status: number): boolean {
  return status === 401 || status === 403;
}

function triggerReauth(): void {
  // Navigate (don't reload) to an /api/* URL: the service worker serves
  // cached HTML for normal navigations, so a reload never reaches Cloudflare
  // Access and the login flow can't run — this is what left the installed
  // PWA spinning forever once its session expired. Guard prevents a loop.
  const key = "auth_reload_ts";
  const last = sessionStorage.getItem(key);
  if (!last || Date.now() - Number(last) > 10_000) {
    sessionStorage.setItem(key, String(Date.now()));
    const redirect = encodeURIComponent(
      window.location.pathname + window.location.search
    );
    window.location.href = `${API_BASE}/auth/login?redirect=${redirect}`;
  }
}

/**
 * Can an authenticated request still reach the API?
 *
 * Used to tell an expired Access session apart from a dropped connection when
 * fetch() throws. The cache-busting param matters: the service worker answers
 * /api/ GETs network-first and would otherwise hand back a cached 200 from
 * before the session expired.
 */
async function sessionIsAlive(): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  try {
    const res = await fetch(`${API_BASE}/auth/me?probe=${Date.now()}`, {
      credentials: "include",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * One cheap request answering "can the server be reached right now?".
 *
 * Used by the stale-data retry loop instead of a full refresh: while the
 * network is down, refreshing means every mounted page refetching, failing,
 * and toasting an error — a dozen doomed requests and an error popup every
 * cycle. Pinging first costs one request, and the full refresh only runs once
 * it will actually succeed.
 *
 * The cache-busting param keeps it honest across the upgrade from builds
 * whose worker still holds an `api-cache`: a unique URL can never be answered
 * from a cache, so an `ok` here is proof of a live server, not a stale copy.
 */
export async function pingServer(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/auth/me?probe=${Date.now()}`, {
      credentials: "include",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // An expired session (401 from our Worker, or 403 from Access rejecting
    // it before that) isn't a reachability problem — it needs re-auth, not an
    // endless "can't refresh" retry. Left unhandled, this ping would report
    // "unreachable" forever and the stale-data retry loop would poll every
    // 15s without ever sending the user back to log in.
    if (isAuthFailure(res.status)) {
      triggerReauth();
      return false;
    }
    return res.ok && res.headers?.get(FROM_CACHE_HEADER) !== "1";
  } catch {
    return false;
  }
}

/**
 * Options for requests whose failure should not colour the whole app's idea
 * of whether it is up to date.
 */
interface FetchFlags {
  /**
   * Set for a request nothing on screen depends on.
   *
   * Failure normally means "the data on screen is stale": it raises the
   * banner and arms a 15-second retry loop that refetches every mounted
   * page. That is right for the numbers, and wrong for garnish. The daily
   * note is the case that proved it — a server-side error on that one
   * endpoint marked the whole dashboard stale, so the retry loop refetched
   * everything, hit the same error, and refetched again, which is what "the
   * page reloads a few times after it loads" looked like from the outside.
   *
   * A `.catch()` at the call site cannot fix this: `markOffline` fires in
   * here, before the caller ever sees the rejection.
   *
   * A *successful* optional request still counts as proof the server is
   * reachable — that direction is only ever good news.
   */
  optional?: boolean;

  /**
   * Override the request deadline (ms). Defaults to REQUEST_TIMEOUT_MS.
   *
   * That default is sized for ordinary CRUD, where anything slower than a
   * few seconds means the connection is gone. A request that asks the server
   * to *generate* something is a different kind of animal: the daily-note
   * refresh runs a language model per child, and a model that thinks before
   * it answers can legitimately take far longer than twelve seconds. Holding
   * it to the CRUD deadline aborted the request client-side while the Worker
   * was still working — which surfaced as "Network error" with nothing in the
   * Cloudflare log, because the live stream only records a request once it
   * completes.
   */
  timeoutMs?: number;
}

async function doFetch(
  path: string,
  options: RequestInit,
  flags: FetchFlags = {},
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...options,
      signal: AbortSignal.timeout(flags.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch {
    // fetch() throws for two very different reasons: Cloudflare Access
    // redirecting an unauthenticated request to its login domain (surfaced as
    // a CORS error), and an ordinary dropped connection — routine on a phone.
    // Re-authing navigates away from whatever is on screen, so only do it once
    // we know the session is actually gone. Retrying the original request
    // isn't an option: a POST that failed on the way back would double-log.
    // Either way the data on screen just failed to refresh. With no offline
    // cache, a thrown fetch is the main way staleness begins, and this is the
    // only place that sees it — flag it before deciding what to do next.
    if (!flags.optional) markOffline();
    if (await sessionIsAlive()) {
      // No status: nothing answered. The outbox reads that as "hold this and
      // try again later" rather than as a rejection.
      throw new ApiError("Network error — check your connection and try again.");
    }
    triggerReauth();
    throw new ApiError("Unauthorized", 401);
  }

  // Deliberately outside the try above: that catch means "the network failed",
  // and anything thrown in here would be misread as a dropped connection and
  // bounce the user through re-auth. A reply that arrives proves the server is
  // reachable again — `noteResponse` clears the staleness banner (and still
  // spots the cached replies a previous build's worker can serve during the
  // one load it takes to upgrade).
  //
  // Except when the server answers but cannot serve: a 5xx carries no data, so
  // the screen still shows whatever the last working refresh left there. Taking
  // it as proof of freshness cleared the banner off a reply that refreshed
  // nothing. Anything below 500 does prove the app can talk to the server —
  // including the 401 that starts re-auth and the 400 a rejected form gets —
  // and a refresh behind it will land.
  if (res.status >= 500) {
    if (!flags.optional) markOffline();
  } else noteResponse(res);
  return res;
}

/**
 * The best sentence available for a failed response.
 *
 * The API sends `{ error }` for everything it rejects itself, but a request
 * can also die before reaching it — Cloudflare answers an oversized upload
 * with an HTML 413, and a gateway hiccup with an HTML 5xx. Parsing those as
 * JSON fails, and the old fallback ("Request failed") told the user nothing
 * about what to do next.
 */
async function errorFromResponse(res: Response): Promise<ApiError> {
  const body = await res.json().catch(() => null);
  const message = (body as { error?: string } | null)?.error;
  if (message) return new ApiError(message, res.status);

  if (res.status === 413) return new ApiError("That file is too large to upload.", res.status);
  if (res.status === 429) return new ApiError("Too many requests — wait a moment and try again.", res.status);
  if (res.status >= 500) return new ApiError(`The server had a problem (HTTP ${res.status}). Please try again.`, res.status);
  return new ApiError(`Request failed (HTTP ${res.status})`, res.status);
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  flags: FetchFlags = {},
): Promise<T> {
  const res = await doFetch(
    path,
    {
      ...options,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        // Names this tab's live connection, so the server can leave it out
        // when it fans the resulting change out to everyone watching the
        // child. Without it the device that just saved gets its own entry
        // pushed back and rebuilds every list under the user, having already
        // refreshed. Harmless on reads and when no socket is open — the
        // server only ever uses it to skip a connection, never to find one.
        "X-Live-Client": liveClientId(),
        ...options.headers,
      },
    },
    flags,
  );

  if (isAuthFailure(res.status)) {
    triggerReauth();
    throw new ApiError("Unauthorized", res.status);
  }

  if (!res.ok) {
    throw await errorFromResponse(res);
  }

  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>(path),

  /**
   * A GET for something the page can do without. Its failure will not raise
   * the stale-data banner or arm the refresh-retry loop — see `FetchFlags`.
   * The caller still gets the rejection and must handle it.
   */
  getOptional: <T>(path: string) => request<T>(path, {}, { optional: true }),

  post: <T>(path: string, data: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(data) }),

  /**
   * A POST for something nothing on screen depends on — the counterpart of
   * `getOptional`, and for the same reason. Marking the alerts feed read is
   * the case: it changes a badge, and failing to reach the server with it
   * says nothing about whether the data on screen is current, so it must not
   * raise the stale-data banner.
   *
   * Not for anything the user typed. A failed save is exactly the case the
   * banner and the outbox exist for.
   */
  postOptional: <T>(path: string, data: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(data) }, { optional: true }),

  /**
   * A POST that asks the server to generate something, and so is allowed to
   * take much longer than an ordinary write before being given up on.
   */
  postSlow: <T>(path: string, data: unknown, timeoutMs = GENERATION_TIMEOUT_MS) =>
    request<T>(path, { method: "POST", body: JSON.stringify(data) }, { timeoutMs }),

  put: <T>(path: string, data: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(data) }),

  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),

  upload: async <T>(path: string, formData: FormData): Promise<T> => {
    const res = await doFetch(path, {
      method: "POST",
      credentials: "include",
      // No Content-Type — FormData sets its own multipart boundary — but the
      // live id still belongs here, for the same reason it does on every other
      // write: this device refreshes itself once the upload returns.
      headers: { "X-Live-Client": liveClientId() },
      body: formData,
    });

    if (isAuthFailure(res.status)) {
      triggerReauth();
      throw new Error("Unauthorized");
    }

    if (!res.ok) {
      throw await errorFromResponse(res);
    }

    return res.json() as Promise<T>;
  },
};
