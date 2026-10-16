import { describe, it, expect, vi, afterEach } from "vitest";
import type { RouteHandlerCallback, RouteHandlerCallbackOptions } from "workbox-core";
import { createShellHandler } from "../src/utils/appShell";

/** The precached shell, standing in for the build the device already has. */
const precached: RouteHandlerCallback = async () => new Response("precached shell");

function navigation(url = "https://baby.test/"): RouteHandlerCallbackOptions {
  return {
    request: new Request(url),
    url: new URL(url),
    event: new Event("fetch") as unknown as ExtendableEvent,
  };
}

function setOnline(online: boolean): void {
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => online });
}

afterEach(() => {
  vi.unstubAllGlobals();
  setOnline(true);
});

describe("app shell navigation handler", () => {
  it("serves the shell the server has now, so a launch starts on the live build", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("live shell", { status: 200 })));

    const response = await createShellHandler(precached)(navigation());

    expect(await response.text()).toBe("live shell");
  });

  it("passes on what the edge says, including the Access redirect", async () => {
    // An expired Cloudflare Access session answers a navigation with a
    // redirect the browser has to follow. Swallowing it for a cached shell
    // leaves the installed app spinning against an API it cannot reach.
    const redirect = Response.redirect("https://baby.test/cdn-cgi/access/login", 302);
    vi.stubGlobal("fetch", vi.fn(async () => redirect));

    const response = await createShellHandler(precached)(navigation());

    expect(response).toBe(redirect);
  });

  it("falls back to the precached shell when the network fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));

    const response = await createShellHandler(precached)(navigation());

    expect(await response.text()).toBe("precached shell");
  });

  it("falls back rather than waiting out a network that never answers", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));

    const response = await createShellHandler(precached, 10)(navigation());

    expect(await response.text()).toBe("precached shell");
  });

  it("falls back on a server error — a shell one build old beats an error page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream error", { status: 503 })));

    const response = await createShellHandler(precached)(navigation());

    expect(await response.text()).toBe("precached shell");
  });

  it("does not wait on the network at all when the browser says it is offline", async () => {
    const fetchSpy = vi.fn(async () => new Response("live shell"));
    vi.stubGlobal("fetch", fetchSpy);
    setOnline(false);

    const response = await createShellHandler(precached)(navigation());

    expect(await response.text()).toBe("precached shell");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
