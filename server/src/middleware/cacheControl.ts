import type { MiddlewareHandler } from "hono";

/**
 * Marks API replies as uncacheable.
 *
 * Tasks are changed from several devices, so a reply that is even a few
 * minutes old is misleading rather than merely dated. Nothing between the
 * Worker and the app — the browser's HTTP cache, Cloudflare's edge, a proxy in
 * between — may keep one and hand it back later.
 *
 * The app keeps no copy of its own either — the service worker has no route
 * for `/api/*` (see `client/src/sw.ts`) — so a reply is current or absent.
 *
 * A handler that sets its own policy wins.
 */
export const cacheControlMiddleware: MiddlewareHandler = async (c, next) => {
  await next();
  // A 101 is a WebSocket handshake, not a reply anyone can cache. Setting a
  // header rebuilds the Response, and a rebuilt Response loses the `webSocket`
  // that is the entire point of it — the socket would open and then never
  // deliver anything. `/api/live` is mounted above this middleware so it
  // should never arrive here anyway; this is what makes that ordering a
  // safeguard rather than the only thing holding the feature up.
  if (c.res.status === 101) return;
  if (!c.res.headers.has("Cache-Control")) {
    c.header("Cache-Control", "no-store");
  }
};
