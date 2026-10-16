import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getStaleSince,
  markOffline,
  noteResponse,
  resetFreshness,
} from "../src/api/freshness";
import { FROM_CACHE_HEADER } from "../src/serviceWorkerContract";

const NOW = new Date(2026, 2, 4, 12, 0, 0);

/** A response as the service worker or the network would hand one back. */
function response(servedAt: Date | null): Response {
  return {
    headers: new Headers(servedAt ? { date: servedAt.toUTCString() } : {}),
  } as Response;
}

function setOnline(online: boolean): void {
  Object.defineProperty(navigator, "onLine", { configurable: true, value: online });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  setOnline(true);
  resetFreshness();
});

afterEach(() => {
  vi.useRealTimers();
  setOnline(true);
});

describe("response freshness", () => {
  it("treats a reply generated just now as fresh", () => {
    noteResponse(response(NOW));
    expect(getStaleSince()).toBeNull();
  });

  it("flags a reply the service worker served from its offline cache", () => {
    // Calibrate on a live reply, then get one from cache — the network went
    // away and workbox answered with what it had from half an hour ago.
    noteResponse(response(NOW));
    const cached = new Date(NOW.getTime() - 30 * 60000);
    noteResponse(response(cached));

    expect(getStaleSince()).toBe(cached.getTime());
  });

  it("clears the flag as soon as a live reply comes back", () => {
    noteResponse(response(NOW));
    noteResponse(response(new Date(NOW.getTime() - 30 * 60000)));
    expect(getStaleSince()).not.toBeNull();

    noteResponse(response(NOW));
    expect(getStaleSince()).toBeNull();
  });

  it("does not cry stale on a device whose own clock is wrong", () => {
    // Phone clock running 20 minutes fast. Every reply the server generates
    // looks 20 minutes old by the local clock, which would otherwise put the
    // banner up permanently on a perfectly healthy connection.
    const serverNow = new Date(NOW.getTime() - 20 * 60000);
    noteResponse(response(serverNow));

    expect(getStaleSince()).toBeNull();
  });

  it("still spots genuinely old data on a device whose clock is wrong", () => {
    const skew = -20 * 60000;
    noteResponse(response(new Date(NOW.getTime() + skew)));

    const cached = new Date(NOW.getTime() + skew - 30 * 60000);
    noteResponse(response(cached));

    expect(getStaleSince()).toBe(cached.getTime() - skew);
  });

  it("flags an app opened with no connection, before any live reply calibrates the clock", () => {
    // Cold start in a basement: everything on screen came out of the cache and
    // there is no fresh reply to measure it against, so the clock reasoning
    // has nothing to work with. Being offline is the giveaway.
    setOnline(false);
    noteResponse(response(new Date(NOW.getTime() - 45 * 60000)));

    expect(getStaleSince()).not.toBeNull();
  });

  it("clears staleness on a fresh reply even when the device claims to be offline", () => {
    // The bug this pins: `navigator.onLine === false` is reported wrongly by
    // installed PWAs, VPNs and captive portals. When it was allowed to veto a
    // fresh reply, a phone reporting it could never leave the stale state —
    // every request succeeded, every one re-flagged the screen, and the retry
    // loop refetched every page every 15 seconds forever.
    // A running app: an earlier live reply has already calibrated the clock.
    noteResponse(response(NOW));
    markOffline();
    expect(getStaleSince()).not.toBeNull();

    setOnline(false);
    noteResponse(response(NOW));

    expect(getStaleSince()).toBeNull();
  });

  it("keeps quiet when a reply carries no Date header at all", () => {
    // The dev server doesn't always set one; guessing an age from nothing
    // would put a false banner in front of the user.
    noteResponse(response(null));
    expect(getStaleSince()).toBeNull();
  });

  it("reports the oldest thing on screen when several reads come back stale", () => {
    noteResponse(response(NOW));
    const older = new Date(NOW.getTime() - 50 * 60000);
    noteResponse(response(new Date(NOW.getTime() - 30 * 60000)));
    noteResponse(response(older));

    expect(getStaleSince()).toBe(older.getTime());
  });
});

// Only a previous build's worker can produce these now — the current worker
// caches no API data — but that worker answers the one load it takes to
// upgrade, so the label must keep being honoured.
describe("replies a service worker labels as cache hits", () => {
  /** A reply as an old build's worker hands one back from its offline cache. */
  function cachedReply(servedAt: Date | null): Response {
    const headers = new Headers(servedAt ? { date: servedAt.toUTCString() } : {});
    headers.set(FROM_CACHE_HEADER, "1");
    return { headers } as Response;
  }

  it("is flagged on the very first reply of a session", () => {
    // The case the clock reasoning cannot get right on its own: nothing has
    // been seen yet, so there is no estimate to measure this against. The
    // label settles it regardless.
    noteResponse(cachedReply(new Date(NOW.getTime() - 30 * 60000)));

    expect(getStaleSince()).toBe(NOW.getTime() - 30 * 60000);
  });

  it("is flagged even when the device believes it is online", () => {
    setOnline(true);
    noteResponse(cachedReply(new Date(NOW.getTime() - 45 * 60000)));

    expect(getStaleSince()).not.toBeNull();
  });

  it("is flagged even when the reply carries no usable Date", () => {
    noteResponse(cachedReply(null));

    expect(getStaleSince()).not.toBeNull();
  });

  it("cannot be talked back into looking live by a later cache hit", () => {
    noteResponse(response(NOW));
    expect(getStaleSince()).toBeNull();

    noteResponse(cachedReply(new Date(NOW.getTime() - 10 * 60000)));
    expect(getStaleSince()).not.toBeNull();
  });

  it("clears once a genuinely live reply arrives", () => {
    noteResponse(cachedReply(new Date(NOW.getTime() - 30 * 60000)));
    expect(getStaleSince()).not.toBeNull();

    noteResponse(response(NOW));
    expect(getStaleSince()).toBeNull();
  });

});

describe("failed requests", () => {
  it("flags the screen as stale when a request cannot get through at all", () => {
    // With no offline cache, a dead network means requests throw — and a
    // request that throws never reaches `noteResponse`, so the client calls
    // this instead. Without it the app would sit on the last rendered data
    // with nothing marking it.
    markOffline();

    expect(getStaleSince()).toBe(NOW.getTime());
  });

  it("keeps the first failure's timestamp when failures repeat", () => {
    // The screen has been stale since the first failed refresh, not the
    // latest one — the banner's age must not creep forward while offline.
    markOffline();
    vi.setSystemTime(new Date(NOW.getTime() + 60000));
    markOffline();

    expect(getStaleSince()).toBe(NOW.getTime());
  });

  it("clears the flag once any request succeeds again", () => {
    markOffline();
    expect(getStaleSince()).not.toBeNull();

    noteResponse(response(NOW));
    expect(getStaleSince()).toBeNull();
  });
});
