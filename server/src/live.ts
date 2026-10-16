/**
 * Live change notifications over WebSocket.
 *
 * A task ticked off on the phone should disappear from the laptop's list
 * straight away, not on its next poll. This replaces the *trigger*, not the
 * fetching: a change here pushes a one-line nudge, the client bumps
 * `refreshKey`, and the data still arrives over the same `/api/*` routes.
 *
 * That split is deliberate and worth keeping. `client/AGENTS.md` says API data
 * is never cached anywhere, and a socket that pushed rows would be exactly
 * that — a second copy of the data, arriving by a path with no `Cache-Control`
 * and no staleness accounting. A nudge carries no data, so there is nothing to
 * go stale and nothing to reconcile.
 *
 * A Durable Object is not optional here. A plain Worker can complete a
 * WebSocket handshake, but the isolate that did it can be evicted at any
 * moment and there is no way for a *later* request (the POST that completes a
 * task) to reach the socket it left open. The DO is the addressable thing that
 * both halves can find: `user:<id>`, derived from the identity every request
 * already carries.
 *
 * Cost is why every socket is accepted with `ctx.acceptWebSocket()` rather
 * than `ws.accept()`. The hibernation API lets the runtime evict this object
 * while the sockets stay connected, so an idle household is billed nothing;
 * `ws.accept()` would bill wall-clock duration for as long as a tab was open,
 * which for a desktop tab pinned to the task list is all day. Nothing in
 * this class may hold a `setInterval`, a `setTimeout` or an alarm — any of
 * them pins the object in memory and quietly turns hibernation off.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types/env.js";

/**
 * Header a client uses to name its own live connection on a write.
 *
 * Without it the device that just saved gets its own change back and rebuilds
 * every list under the user two seconds after the dialog closed — it has
 * already refreshed locally, so that redraw shows nothing new. The DO skips
 * the originating socket instead. Absent (an outbox flush, curl, a device with
 * no socket) it simply broadcasts to everyone, which is the safe direction.
 */
export const LIVE_CLIENT_HEADER = "X-Live-Client";

/** What changed. Purely informational — the client refetches either way. */
export type ChangeKind = "tasks" | "lists" | "alerts" | "settings" | "briefing";

/** The Durable Object name carrying one user's live connections. */
export function liveRoomName(userId: number): string {
  return `user:${userId}`;
}

/** The nudge itself. No entry data — see the note at the top of this file. */
export interface LiveChangeMessage {
  type: "change";
  kind: ChangeKind;
  /** Server clock, so a client can drop a message it has already acted on. */
  at: number;
}

/** Sent once on connect, so the client knows the socket is live end to end. */
export interface LiveReadyMessage {
  type: "ready";
  at: number;
}

export type LiveMessage = LiveChangeMessage | LiveReadyMessage;

/**
 * Application-level heartbeat.
 *
 * A phone that loses signal leaves a socket that looks open and never
 * delivers anything, which under this design means a dashboard that has
 * stopped updating with nothing on screen saying so — the exact failure the
 * poll used to make impossible. The client sends `ping` and expects `pong`;
 * silence means reconnect.
 *
 * Answered by `setWebSocketAutoResponse` below, so a heartbeat never wakes the
 * object and never costs duration. Browsers cannot send protocol-level ping
 * frames from JavaScript, which is why this is an ordinary message rather than
 * the WebSocket ping the runtime would have handled for free.
 */
export const LIVE_PING = "ping";
export const LIVE_PONG = "pong";

/** One user's open connections. See the file comment for why this exists. */
export class UserLive extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Set on every construction rather than once: the object is evicted and
    // rebuilt constantly under hibernation, and the auto-response is per
    // instance, not persisted.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(LIVE_PING, LIVE_PONG));
  }

  /**
   * Complete the upgrade the Worker handed over.
   *
   * The caller has already authenticated the request and picked the room from
   * the authenticated user — this object is not reachable from outside the
   * Worker, so it does not repeat either.
   */
  override async fetch(request: Request): Promise<Response> {
    const clientId = new URL(request.url).searchParams.get("client") ?? "";

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Hibernation, not `server.accept()` — see the file comment.
    this.ctx.acceptWebSocket(server);
    // Survives eviction, unlike anything held on `this`. It is only ever the
    // client's own opaque id, used to skip its own echo.
    server.serializeAttachment({ clientId });

    // Proof the socket works end to end, which a browser `onopen` alone does
    // not give: Access sits in front of this and a rejected upgrade can look
    // like an open socket that never speaks. The client waits for this before
    // it stands the polling fallback down.
    server.send(JSON.stringify({ type: "ready", at: Date.now() } satisfies LiveReadyMessage));

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Tell every device this user has open that something changed.
   *
   * Called over RPC from the write paths. Never throws: a broadcast that fails
   * must not be the reason a task fails to save — the client's own backstop
   * poll is what makes that safe to swallow.
   */
  publish(kind: ChangeKind, originClientId?: string): void {
    const message = JSON.stringify({
      type: "change",
      kind,
      at: Date.now(),
    } satisfies LiveChangeMessage);

    for (const ws of this.ctx.getWebSockets()) {
      if (originClientId) {
        const attachment = ws.deserializeAttachment() as { clientId?: string } | null;
        if (attachment?.clientId && attachment.clientId === originClientId) continue;
      }
      try {
        ws.send(message);
      } catch {
        // Already closing. `getWebSockets` can still hand back a socket in the
        // CLOSING state, and one dead connection must not cost the others
        // their nudge.
      }
    }
  }

  /**
   * Anything the client sends that is not the heartbeat.
   *
   * `ping` never reaches here — `setWebSocketAutoResponse` answers it without
   * waking the object. Nothing else is part of the protocol: this is a
   * one-way channel, and a client with something to say uses the REST API.
   */
  override async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    // Intentionally empty.
  }

  override async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    // Completing the handshake by hand because `compatibility_date` predates
    // 2026-04-07, when `web_socket_auto_reply_to_close` became the default.
    // Without it a socket the client closed lingers in CLOSING and keeps
    // showing up in `getWebSockets()`.
    //
    // 1005 and 1006 are "no status" and "abnormal" — a phone going through a
    // tunnel produces them constantly, and neither may be echoed back on the
    // wire, so they are replaced with a normal close.
    const echoable = code >= 1000 && code !== 1005 && code !== 1006;
    try {
      ws.close(echoable ? code : 1000, reason);
    } catch {
      // Already gone.
    }
  }

  override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    try {
      ws.close(1011, "error");
    } catch {
      // Already gone.
    }
  }
}

/**
 * Publish a change for one user, from anywhere in the Worker.
 *
 * Swallows everything. A live nudge is a convenience on top of a client that
 * still polls as a backstop, so no write, cron or queue consumer may fail
 * because a broadcast did.
 *
 * Awaited by callers rather than fired into `waitUntil`, so a nudge can never
 * overtake the row it is about: a client told to refetch before the commit
 * landed would read the old data and sit on it until its backstop poll.
 */
export async function notifyChange(
  env: Env,
  userId: number,
  kind: ChangeKind,
  originClientId?: string,
): Promise<void> {
  if (!env.LIVE) return;
  if (!Number.isFinite(userId) || userId <= 0) return;

  try {
    const stub = env.LIVE.get(env.LIVE.idFromName(liveRoomName(userId)));
    await stub.publish(kind, originClientId);
  } catch (err) {
    console.error(`Live notify failed for user ${userId}:`, err);
  }
}

/**
 * Announce a change from inside a route handler.
 *
 * Reads the caller's own connection id off the request, so the device that
 * made the change is the one device not told about it — it refreshed the
 * moment it saved.
 */
export async function announceChange(
  // Structural rather than Hono's `Context`, so every route file can use it.
  c: { env: Env; req: { header(name: string): string | undefined }; get(key: "userId"): number },
  kind: ChangeKind,
): Promise<void> {
  await notifyChange(c.env, c.get("userId"), kind, c.req.header(LIVE_CLIENT_HEADER));
}
