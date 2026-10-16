/**
 * The live-update socket — how this device finds out that a task changed on
 * one of the user's other devices.
 *
 * What arrives here is a nudge, never data: `{ type: "change" }` and nothing
 * else. The app still fetches every entry over `/api/*` exactly as it did when
 * a timer drove the refetch. That is deliberate and load-bearing — the rule in
 * AGENTS.md is that API data is never cached anywhere, and rows pushed down a
 * socket would be precisely that: a second copy of the data, arriving by a
 * path with no `Cache-Control` and no staleness accounting. A nudge cannot go
 * stale, so there is nothing here to get wrong.
 *
 * This replaces one refresh trigger, not the refresh machinery. Coming back to
 * the app, reconnecting, an `online` event and the outbox flush all still do
 * what they did; see `useDataRefresh.tsx`. What the socket removes is the
 * minute of latency between ticking a task off on the phone and the laptop
 * dropping it.
 *
 * A module singleton rather than React state, like `freshness.ts` and
 * `outbox.ts` next door: exactly one socket per tab regardless of what mounts.
 */

import { API_BASE } from "./client";

/** Where a connection has got to. `Layout` never shows this; it steers the poll. */
export type LiveStatus =
  /** Not connected yet, or deliberately disconnected. */
  | "idle"
  /** Handshake in flight, or waiting for the server's greeting. */
  | "connecting"
  /** Greeted by the server — nudges are arriving. */
  | "open"
  /** Dropped, with a reconnect scheduled. */
  | "retrying"
  /**
   * Gave up. Nothing on this device has ever managed to connect, so the app
   * stops trying and goes back to polling at the old interval — see
   * `COLD_ATTEMPT_LIMIT`.
   */
  | "unavailable";

export type LiveEvent =
  | { type: "change"; kind: string; at: number }
  | { type: "status"; status: LiveStatus };

/**
 * How often to prove the socket is still carrying traffic (ms).
 *
 * A phone that loses signal in a lift leaves a socket that reads as OPEN and
 * will never deliver anything again. Without this the app would sit on a dead
 * connection showing data it believes is live, which is worse than the polling
 * it replaced — that at least failed visibly. The server answers `ping` from
 * the runtime's own auto-responder, so a heartbeat never wakes the Durable
 * Object and costs nothing.
 */
export const HEARTBEAT_MS = 45_000;

/** How long to wait for `pong` before treating the socket as dead (ms). */
export const HEARTBEAT_TIMEOUT_MS = 10_000;

/**
 * How long a socket has to greet the client before it is written off (ms).
 *
 * A rejected upgrade normally arrives as `onerror` then `onclose`, which the
 * reconnect path already handles. This is for the other shape: a handshake
 * that completes and then delivers nothing — a proxy that buffers, a tunnel
 * that half-works. Without it such a socket sits in `connecting` forever,
 * never failing and so never counting towards `COLD_ATTEMPT_LIMIT`, which
 * would leave a zombie connection that the app keeps believing in.
 */
export const READY_TIMEOUT_MS = 10_000;

/** First reconnect delay (ms); doubles up to `RECONNECT_MAX_MS`. */
export const RECONNECT_BASE_MS = 1_000;

/**
 * Longest gap between reconnect attempts (ms).
 *
 * Cloudflare terminates WebSockets whenever it releases code to the edge, so
 * a healthy connection still drops every so often for reasons that have
 * nothing to do with this app. The backoff is there for a real outage; it must
 * not turn a routine edge restart into half a minute of missed updates, which
 * is why the first retry is a second and returning to the app reconnects at
 * once regardless of where the backoff had got to.
 */
export const RECONNECT_MAX_MS = 30_000;

/**
 * Consecutive failures with no successful connection *ever* before giving up.
 *
 * This is the fallback for the case that cannot be detected any other way. A
 * browser is not told why a handshake failed — the WebSocket API hides the
 * HTTP status — so an Access policy rejecting the upgrade, a corporate proxy
 * stripping it and a dead network are indistinguishable from in here. Rather
 * than guess, the app counts: four attempts, none of which ever reached the
 * server's greeting, and it stops asking and tells `useDataRefresh` to poll at
 * the old rate instead. The app stays correct either way; only the latency
 * changes.
 *
 * A connection that worked once and then dropped never reaches this — that is
 * an ordinary reconnect, and it retries forever.
 */
export const COLD_ATTEMPT_LIMIT = 4;

/**
 * How long to wait before re-probing after giving up (ms).
 *
 * Whatever blocked the upgrade may not be permanent — a captive portal, a
 * flaky tunnel, an Access policy someone is in the middle of fixing — so
 * "unavailable" is a rest, not a verdict. Re-probed when the app is brought
 * back to the front, never on a timer in a background tab.
 */
export const UNAVAILABLE_RETRY_MS = 5 * 60_000;

/**
 * This tab's connection id, sent on every write.
 *
 * The server skips this socket when fanning out a change that came from it, so
 * the device that saved does not get its own entry back and rebuild every list
 * under the user two seconds after the dialog closed. It already refreshed.
 *
 * Per tab, not per device: two tabs are two connections, and each should hear
 * about what the other did.
 */
const CLIENT_ID =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `c${Date.now()}${Math.random().toString(36).slice(2)}`;

export function liveClientId(): string {
  return CLIENT_ID;
}

const listeners = new Set<(event: LiveEvent) => void>();

let socket: WebSocket | null = null;
/** Whether the app wants a connection at all. */
let wanted = false;
let status: LiveStatus = "idle";
/** Consecutive failed attempts since the last time a socket was greeted. */
let coldAttempts = 0;
/** Whether any socket in this tab has ever been greeted. */
let everConnected = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let pongTimer: ReturnType<typeof setTimeout> | null = null;
let readyTimer: ReturnType<typeof setTimeout> | null = null;
let unavailableSince = 0;

function emit(event: LiveEvent): void {
  for (const listener of listeners) listener(event);
}

function setStatus(next: LiveStatus): void {
  if (status === next) return;
  status = next;
  if (next === "unavailable") unavailableSince = Date.now();
  emit({ type: "status", status: next });
}

/** Subscribe to nudges and status changes. Returns an unsubscribe function. */
export function subscribeLive(listener: (event: LiveEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getLiveStatus(): LiveStatus {
  return status;
}

/** The socket URL, derived from wherever the API lives. */
function liveUrl(): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost";
  const base = new URL(API_BASE, origin);
  const url = new URL(`${base.pathname.replace(/\/+$/, "")}/live`, base.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("client", CLIENT_ID);
  return url.toString();
}

function clearTimers(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  clearReadyTimer();
  stopHeartbeat();
}

function clearReadyTimer(): void {
  if (readyTimer !== null) {
    clearTimeout(readyTimer);
    readyTimer = null;
  }
}

function stopHeartbeat(): void {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (pongTimer !== null) {
    clearTimeout(pongTimer);
    pongTimer = null;
  }
}

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    // A hidden tab is not waiting on anything, and on iOS it is frozen mid-tick
    // anyway — the timer would fire on resume and immediately declare the
    // socket dead for having missed a pong it never had the chance to answer.
    // Coming back to the app checks the connection directly instead.
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;

    try {
      socket.send("ping");
    } catch {
      dropAndRetry();
      return;
    }

    if (pongTimer !== null) clearTimeout(pongTimer);
    pongTimer = setTimeout(() => {
      // Silence on a socket that still reads as OPEN: the connection is a
      // ghost. Tear it down so the reconnect path can replace it.
      dropAndRetry();
    }, HEARTBEAT_TIMEOUT_MS);
  }, HEARTBEAT_MS);
}

/** Close whatever is open and schedule a replacement. */
function dropAndRetry(): void {
  clearReadyTimer();
  stopHeartbeat();
  const dying = socket;
  socket = null;
  if (dying) {
    // Detached first: the close below would otherwise re-enter this module
    // through `onclose` and schedule a second reconnect.
    dying.onopen = null;
    dying.onmessage = null;
    dying.onerror = null;
    dying.onclose = null;
    try {
      dying.close();
    } catch {
      // Already gone.
    }
  }
  scheduleReconnect();
}

function scheduleReconnect(): void {
  if (!wanted) {
    setStatus("idle");
    return;
  }
  if (reconnectTimer !== null) return;

  coldAttempts += 1;
  // Only a tab that has *never* connected gives up. A socket that worked and
  // then dropped is an ordinary reconnect and retries for as long as the app
  // is open.
  if (!everConnected && coldAttempts >= COLD_ATTEMPT_LIMIT) {
    setStatus("unavailable");
    return;
  }

  setStatus("retrying");
  const exponent = Math.min(coldAttempts - 1, 10);
  const backoff = Math.min(RECONNECT_BASE_MS * 2 ** exponent, RECONNECT_MAX_MS);
  // Jittered so two devices woken by the same edge restart do not come back in
  // lockstep for the rest of the session.
  const delay = backoff / 2 + Math.random() * (backoff / 2);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    open();
  }, delay);
}

function open(): void {
  if (!wanted) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  if (typeof WebSocket === "undefined") {
    setStatus("unavailable");
    return;
  }

  setStatus("connecting");

  let ws: WebSocket;
  try {
    ws = new WebSocket(liveUrl());
  } catch {
    scheduleReconnect();
    return;
  }
  socket = ws;

  clearReadyTimer();
  readyTimer = setTimeout(() => {
    readyTimer = null;
    if (ws !== socket) return;
    if (status === "open") return;
    // Opened, or still opening, and silent either way. Treat it as a failed
    // attempt so it is replaced and, if this keeps happening, eventually
    // stood down in favour of the poll.
    dropAndRetry();
  }, READY_TIMEOUT_MS);

  ws.onmessage = (event: MessageEvent) => {
    if (ws !== socket) return;

    if (event.data === "pong") {
      if (pongTimer !== null) {
        clearTimeout(pongTimer);
        pongTimer = null;
      }
      return;
    }

    let message: { type?: string; kind?: string; at?: number };
    try {
      message = JSON.parse(event.data as string);
    } catch {
      return;
    }

    if (message.type === "ready") {
      // `onopen` is not enough on its own. Cloudflare Access sits in front of
      // this Worker, and an upgrade it will not carry can still look like a
      // socket that opened — it just never speaks. The greeting is the proof
      // that traffic makes it end to end, so it, not `onopen`, is what stands
      // the polling fallback down.
      clearReadyTimer();
      everConnected = true;
      coldAttempts = 0;
      setStatus("open");
      startHeartbeat();
      return;
    }

    if (message.type === "change") {
      emit({ type: "change", kind: message.kind ?? "tasks", at: message.at ?? Date.now() });
    }
  };

  ws.onerror = () => {
    // Nothing useful is on the event — the WebSocket API deliberately hides
    // why a handshake failed. `onclose` follows and does the work.
  };

  ws.onclose = () => {
    if (ws !== socket) return;
    socket = null;
    clearReadyTimer();
    stopHeartbeat();
    scheduleReconnect();
  };
}

/**
 * Connect, or hang up.
 *
 * The server holds one Durable Object per user and authenticates the socket
 * like any other request, so there is nothing to choose — only whether to
 * connect at all.
 */
export function connectLive(enable: boolean): void {
  if (!enable) {
    wanted = false;
    clearTimers();
    const dying = socket;
    socket = null;
    if (dying) {
      dying.onclose = null;
      try {
        dying.close();
      } catch {
        // Already gone.
      }
    }
    setStatus("idle");
    return;
  }

  if (wanted && (status === "open" || status === "connecting")) return;
  wanted = true;
  open();
}

/**
 * Check the connection after the app has been away, and rebuild it if needed.
 *
 * Called on every signal that the app is back in front of the user. This is
 * the main path on an installed iOS PWA, where the page is frozen rather than
 * closed: timers do not run while it is backgrounded, the socket is usually
 * dead by the time it thaws, and `onclose` may not have fired — so the state
 * of the connection has to be read directly rather than waited for.
 *
 * Returns true if the socket was already healthy, which the caller reads as
 * "no missed nudges to worry about".
 */
export function revalidateLive(): boolean {
  if (!wanted) return false;

  if (status === "unavailable") {
    // A rest, not a verdict — see UNAVAILABLE_RETRY_MS.
    if (Date.now() - unavailableSince < UNAVAILABLE_RETRY_MS) return false;
    coldAttempts = 0;
    open();
    return false;
  }

  if (socket && socket.readyState === WebSocket.OPEN) {
    // Restart the heartbeat rather than trusting the one that was frozen with
    // the page: its pending pong deadline may already have expired.
    startHeartbeat();
    return true;
  }

  // Straight back in, whatever the backoff had queued up. Waiting out a
  // 30-second timer that was scheduled before the phone went in a pocket is
  // exactly the delay the socket exists to remove.
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  open();
  return false;
}

/** Test seam — drops the connection and every scrap of state around it. */
export function resetLive(): void {
  clearTimers();
  clearReadyTimer();
  const dying = socket;
  socket = null;
  if (dying) {
    dying.onopen = null;
    dying.onmessage = null;
    dying.onerror = null;
    dying.onclose = null;
    try {
      dying.close();
    } catch {
      // Already gone.
    }
  }
  wanted = false;
  coldAttempts = 0;
  everConnected = false;
  unavailableSince = 0;
  status = "idle";
  listeners.clear();
}
