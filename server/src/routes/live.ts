import { Hono } from "hono";
import type { AppEnv } from "../types/env.js";
import { liveRoomName } from "../live.js";

export const live = new Hono<AppEnv>();

/**
 * Open a live-update socket for the signed-in user.
 *
 * `GET /api/live?client=<opaque id>`, upgraded to a WebSocket and handed to
 * that user's Durable Object. See `src/live.ts` for what comes back over it
 * (nudges, never data).
 *
 * Authentication is `authMiddleware`, unchanged and unaware this is a socket:
 * a browser sends cookies on a same-origin handshake and Cloudflare Access
 * injects `Cf-Access-Jwt-Assertion` in front of the Worker. Access must stay a
 * hostname-based (self-hosted) application for this to work — a Worker-level
 * Access policy rejects upgrades outright.
 *
 * Mounted *before* `cacheControlMiddleware` in `index.ts`: a 101's `webSocket`
 * does not survive the response being rebuilt to add a header.
 */
live.get("/", async (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return c.json({ error: "Expected a WebSocket upgrade" }, 426);
  }
  // 503 rather than 500: the client reads it as "poll instead".
  if (!c.env.LIVE) {
    return c.json({ error: "Live updates unavailable" }, 503);
  }

  const stub = c.env.LIVE.get(c.env.LIVE.idFromName(liveRoomName(c.get("userId"))));
  return stub.fetch(c.req.raw);
});
