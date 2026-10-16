import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  connectLive,
  subscribeLive,
  getLiveStatus,
  revalidateLive,
  resetLive,
  liveClientId,
  COLD_ATTEMPT_LIMIT,
  HEARTBEAT_MS,
  HEARTBEAT_TIMEOUT_MS,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  READY_TIMEOUT_MS,
  type LiveEvent,
} from "../src/api/live";

/**
 * A WebSocket that does nothing until the test tells it to.
 *
 * Every interesting case here is about what happens when a connection fails,
 * stalls or dies, so the useful control is over the transitions rather than
 * over a real socket — jsdom has no WebSocket implementation to lean on
 * anyway.
 */
class FakeSocket {
  static instances: FakeSocket[] = [];

  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string) {
    if (this.readyState !== FakeSocket.OPEN) throw new Error("not open");
    this.sent.push(data);
  }

  close() {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }

  /** The server completing the handshake and greeting the client. */
  greet() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
    this.onmessage?.({ data: JSON.stringify({ type: "ready", at: Date.now() }) });
  }

  /** The handshake failing — an Access rejection looks exactly like this. */
  fail() {
    this.readyState = FakeSocket.CLOSED;
    this.onerror?.();
    this.onclose?.();
  }

  /** A change published by the server. */
  publish(kind = "tasks") {
    this.onmessage?.({ data: JSON.stringify({ type: "change", kind, at: Date.now() }) });
  }

  pong() {
    this.onmessage?.({ data: "pong" });
  }

  /** Drops the connection without any close being delivered — a phone in a lift. */
  goSilent() {
    this.readyState = FakeSocket.OPEN;
  }
}

const latest = () => FakeSocket.instances[FakeSocket.instances.length - 1];

/** Let the reconnect backoff elapse, whatever it currently is. */
function advancePastBackoff() {
  vi.advanceTimersByTime(RECONNECT_MAX_MS + 1);
}

describe("live updates", () => {
  let events: LiveEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    resetLive();
    events = [];
    subscribeLive((event) => events.push(event));
  });

  afterEach(() => {
    resetLive();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("connects over ws(s) with this tab's id", () => {
    connectLive(true);
    const url = new URL(latest().url);
    expect(url.protocol).toBe("ws:"); // jsdom serves the tests over http
    expect(url.pathname).toBe("/api/live");
    expect(url.searchParams.get("client")).toBe(liveClientId());
  });

  it("stays 'connecting' until the server greets it", () => {
    // An upgrade Access will not carry can still look like a socket that
    // opened — it just never speaks. The greeting is the only proof that
    // traffic makes it end to end, so `onopen` alone must not count.
    connectLive(true);
    latest().readyState = FakeSocket.OPEN;
    latest().onopen?.();
    expect(getLiveStatus()).toBe("connecting");

    latest().greet();
    expect(getLiveStatus()).toBe("open");
  });

  it("replaces a socket that opens and then never speaks", () => {
    // The other shape of a rejected upgrade: the handshake completes and
    // nothing follows. Without a deadline this sits in `connecting` forever,
    // never failing and so never counting towards giving up.
    connectLive(true);
    latest().readyState = FakeSocket.OPEN;
    latest().onopen?.();

    vi.advanceTimersByTime(READY_TIMEOUT_MS + 1);
    advancePastBackoff();

    expect(FakeSocket.instances.length).toBeGreaterThan(1);
  });

  it("does not write off a socket that greeted it in time", () => {
    connectLive(true);
    latest().greet();
    vi.advanceTimersByTime(READY_TIMEOUT_MS + 1);

    expect(FakeSocket.instances).toHaveLength(1);
    expect(getLiveStatus()).toBe("open");
  });

  it("passes a published change through to subscribers", () => {
    connectLive(true);
    latest().greet();
    latest().publish("timers");

    expect(events).toContainEqual({ type: "change", kind: "timers", at: expect.any(Number) });
  });

  it("ignores anything it cannot parse", () => {
    connectLive(true);
    latest().greet();
    latest().onmessage?.({ data: "<html>a proxy error page</html>" });

    expect(events.filter((e) => e.type === "change")).toHaveLength(0);
    expect(getLiveStatus()).toBe("open");
  });

  it("reconnects after the connection drops", () => {
    connectLive(true);
    latest().greet();
    const first = latest();

    first.close();
    expect(getLiveStatus()).toBe("retrying");

    // Just past the first backoff, which is jittered within RECONNECT_BASE_MS.
    // Deliberately not `advancePastBackoff()`: that would also outrun
    // READY_TIMEOUT_MS and the replacement — which no test server greets —
    // would be written off and replaced again, several times over.
    vi.advanceTimersByTime(RECONNECT_BASE_MS + 1);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("gives up and lets the app fall back to polling when it can never connect", () => {
    // An Access policy that will not carry a WebSocket is indistinguishable
    // from a dead network in here — the browser does not expose the HTTP
    // status of a failed upgrade. So the app counts failures instead of
    // guessing, and hands the job back to the poll.
    connectLive(true);
    for (let attempt = 0; attempt < COLD_ATTEMPT_LIMIT; attempt += 1) {
      latest().fail();
      advancePastBackoff();
    }

    expect(getLiveStatus()).toBe("unavailable");
    const attempts = FakeSocket.instances.length;
    advancePastBackoff();
    expect(FakeSocket.instances).toHaveLength(attempts);
  });

  it("keeps retrying a connection that worked once, however many times it drops", () => {
    connectLive(true);
    latest().greet();

    for (let drop = 0; drop < COLD_ATTEMPT_LIMIT * 3; drop += 1) {
      latest().close();
      advancePastBackoff();
    }

    expect(getLiveStatus()).not.toBe("unavailable");
  });

  it("replaces a socket that has stopped answering the heartbeat", () => {
    connectLive(true);
    latest().greet();
    const ghost = latest();

    ghost.goSilent();
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(ghost.sent).toContain("ping");

    // No pong. A socket that still reads as OPEN but delivers nothing is worse
    // than one that closed: the app would sit on it believing it was current.
    vi.advanceTimersByTime(HEARTBEAT_TIMEOUT_MS + 1);
    advancePastBackoff();
    expect(FakeSocket.instances.length).toBeGreaterThan(1);
  });

  it("keeps a socket that answers the heartbeat", () => {
    connectLive(true);
    latest().greet();
    const socket = latest();

    for (let beat = 0; beat < 3; beat += 1) {
      vi.advanceTimersByTime(HEARTBEAT_MS);
      expect(socket.sent).toHaveLength(beat + 1);
      socket.pong();
    }

    // Past the deadline every one of those pings would have missed had it gone
    // unanswered, to show the answers actually disarmed it.
    vi.advanceTimersByTime(HEARTBEAT_TIMEOUT_MS + 1);

    expect(FakeSocket.instances).toHaveLength(1);
    expect(getLiveStatus()).toBe("open");
  });

  it("rebuilds a dead socket when the app comes back, without waiting out the backoff", () => {
    connectLive(true);
    latest().greet();
    latest().close();
    expect(getLiveStatus()).toBe("retrying");

    const attempts = FakeSocket.instances.length;
    // No timer advance: returning to the app is exactly the moment that a
    // 30-second backoff scheduled before the phone went in a pocket is the
    // delay this feature exists to remove.
    expect(revalidateLive()).toBe(false);
    expect(FakeSocket.instances.length).toBe(attempts + 1);
  });

  it("reports a healthy socket as healthy on resume", () => {
    connectLive(true);
    latest().greet();
    expect(revalidateLive()).toBe(true);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("hangs up when asked to", () => {
    connectLive(true);
    latest().greet();
    const socket = latest();

    connectLive(false);
    expect(socket.readyState).toBe(FakeSocket.CLOSED);
    expect(getLiveStatus()).toBe("idle");
  });

  it("does not tear down and rebuild a socket that is already up", () => {
    connectLive(true);
    latest().greet();
    connectLive(true);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});
