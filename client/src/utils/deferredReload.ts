import { isUserBusy } from "./interruptions";

/**
 * A background stint at least this long means the user walked away, so coming
 * back is a natural moment to start on the new build.
 */
export const STALE_BACKGROUND_MS = 30 * 60 * 1000;

/**
 * How long after launch an update still counts as arriving at a cold start.
 *
 * Wide enough for the worker to finish installing on a slow connection — the
 * precache is around a megabyte — while still plainly "the app just opened".
 */
export const STARTUP_GRACE_MS = 60 * 1000;

export interface DeferredReload {
  /** A new build is ready — reload at the next moment that won't cost the user anything. */
  request: () => void;
  /** Detach listeners. */
  dispose: () => void;
}

/**
 * Holds a page reload until it's safe to perform.
 *
 * "Safe" means nothing is open that a reload would destroy. `isUserBusy` is the
 * whole of that question — an open dialog or a focused field — and it is
 * checked before every reload below.
 *
 * Beyond that the aim is for the reload to be invisible, which is why a
 * backgrounded app is the preferred moment. But "invisible" cannot come at the
 * cost of "never", and it did:
 *
 *   - A cold start was excluded. `returningFromLongAbsence` requires a prior
 *     hidden period, so on a fresh launch it is always false, and the app is on
 *     screen so `backgrounded` is false too. An update that arrived while the
 *     user sat looking at a freshly opened app was held indefinitely — despite
 *     a cold start being the safest moment there is, with nothing typed yet.
 *
 *   - The one path that did fire reloads a hidden page, and cleared the pending
 *     flag before calling it. Mobile browsers freeze a backgrounded page rather
 *     than run script in it, so that reload often never happened, and with the
 *     flag already cleared the update was forgotten for the rest of the session.
 *
 * Between them an installed app could stay several builds behind indefinitely,
 * which is exactly what happened chasing the section-page crash: the fix was
 * deployed and green while the phone kept running the build with the bug. So a
 * cold start now reloads, and a reload issued into a hidden page is treated as
 * provisional until the page is gone.
 */
export function createDeferredReload(reload: () => void): DeferredReload {
  let requested = false;
  let hiddenAt = 0;
  let everHidden = false;
  let reloadedWhileHidden = false;
  const openedAt = Date.now();

  const attempt = () => {
    if (!requested) return;
    if (isUserBusy()) return;

    const hidden = document.visibilityState === "hidden";

    // Still on the opening screens and never backgrounded. Restricted to the
    // first visible stretch on purpose: once the app has been away and come
    // back, a brief absence should not reload underneath someone mid-scroll.
    const coldStart = !everHidden && Date.now() - openedAt < STARTUP_GRACE_MS;

    const returningFromLongAbsence =
      hiddenAt > 0 && Date.now() - hiddenAt >= STALE_BACKGROUND_MS;

    // We asked a hidden page to reload and it is still here, so it never did.
    const hiddenReloadDidNotTake = !hidden && reloadedWhileHidden;

    if (!hidden && !coldStart && !returningFromLongAbsence && !hiddenReloadDidNotTake) return;

    if (hidden) {
      // Leave `requested` set. A frozen page may never run this, and the update
      // has to still be pending when it wakes up.
      reloadedWhileHidden = true;
    } else {
      // The page is on screen and running, so this one commits.
      requested = false;
    }
    reload();
  };

  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
      everHidden = true;
      attempt();
      return;
    }
    attempt();
    hiddenAt = 0;
  };

  document.addEventListener("visibilitychange", onVisibilityChange);

  return {
    request: () => {
      requested = true;
      attempt();
    },
    dispose: () => document.removeEventListener("visibilitychange", onVisibilityChange),
  };
}
