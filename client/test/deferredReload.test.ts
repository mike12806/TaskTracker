import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createDeferredReload,
  STALE_BACKGROUND_MS,
  STARTUP_GRACE_MS,
  type DeferredReload,
} from "../src/utils/deferredReload";

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

function openDialog(): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("role", "dialog");
  document.body.appendChild(el);
  return el;
}

let pending: DeferredReload | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-04T09:00:00Z"));
});

afterEach(() => {
  pending?.dispose();
  pending = null;
  document.body.innerHTML = "";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  vi.useRealTimers();
});

describe("deferred service-worker update reload", () => {
  it("reloads at a cold start, where there is nothing to lose", () => {
    const reload = vi.fn();
    pending = createDeferredReload(reload);

    // The app has just opened and the user has not touched anything. Holding
    // the reload here is what left installed devices several builds behind.
    pending.request();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload at a cold start with a form already open", () => {
    const reload = vi.fn();
    pending = createDeferredReload(reload);
    openDialog();

    pending.request();

    expect(reload).not.toHaveBeenCalled();
  });

  it("does not reload while the app is on screen once past the opening moments", () => {
    const reload = vi.fn();
    pending = createDeferredReload(reload);
    vi.advanceTimersByTime(STARTUP_GRACE_MS);

    pending.request();

    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads once the app is backgrounded", () => {
    const reload = vi.fn();
    pending = createDeferredReload(reload);
    vi.advanceTimersByTime(STARTUP_GRACE_MS);

    pending.request();
    setVisibility("hidden");

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("tries again when a reload asked of a hidden page never ran", () => {
    const reload = vi.fn();
    pending = createDeferredReload(reload);
    vi.advanceTimersByTime(STARTUP_GRACE_MS);

    pending.request();
    setVisibility("hidden");
    expect(reload).toHaveBeenCalledTimes(1);

    // Still running, so the page was frozen rather than reloaded — the update
    // is still pending and must not have been dropped on the floor.
    setVisibility("visible");
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("reloads immediately if the update lands while already backgrounded", () => {
    const reload = vi.fn();
    pending = createDeferredReload(reload);

    setVisibility("hidden");
    pending.request();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("never reloads out from under an open form", () => {
    const reload = vi.fn();
    pending = createDeferredReload(reload);
    const dialog = openDialog();

    pending.request();
    setVisibility("hidden");
    expect(reload).not.toHaveBeenCalled();

    // Still held when the user comes back to finish the form.
    setVisibility("visible");
    expect(reload).not.toHaveBeenCalled();

    // …and lands once the form is done with.
    dialog.remove();
    setVisibility("hidden");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("holds the reload while a field has focus", () => {
    const reload = vi.fn();
    pending = createDeferredReload(reload);
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    pending.request();
    setVisibility("hidden");

    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads on return from a long absence, when a fresh start is expected anyway", () => {
    const reload = vi.fn();
    pending = createDeferredReload(reload);
    const dialog = openDialog();

    pending.request();
    setVisibility("hidden");
    expect(reload).not.toHaveBeenCalled();

    dialog.remove();
    vi.advanceTimersByTime(STALE_BACKGROUND_MS);
    setVisibility("visible");

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload on return from a brief absence", () => {
    const reload = vi.fn();
    pending = createDeferredReload(reload);
    const dialog = openDialog();

    pending.request();
    setVisibility("hidden");

    dialog.remove();
    vi.advanceTimersByTime(30_000);
    setVisibility("visible");

    expect(reload).not.toHaveBeenCalled();
  });

  it("stops once a reload has actually committed", () => {
    const reload = vi.fn();
    pending = createDeferredReload(reload);

    // On screen, so this one runs rather than being frozen — which is what
    // makes it final. (A reload asked of a hidden page is retried instead;
    // see above.)
    pending.request();
    expect(reload).toHaveBeenCalledTimes(1);

    setVisibility("hidden");
    setVisibility("visible");
    setVisibility("hidden");

    expect(reload).toHaveBeenCalledTimes(1);
  });
});
