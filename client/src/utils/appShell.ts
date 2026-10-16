import type { RouteHandlerCallback, RouteHandlerCallbackOptions } from "workbox-core";

/**
 * How long a navigation waits for the current shell before giving up and
 * using the precached one (ms).
 *
 * Long enough to cover a phone whose radio is still waking up on launch,
 * short enough that a dead network does not hold the app on a blank screen.
 * The fallback is a complete, working app — one build old — so overshooting
 * this costs a launch on a stale build, never a broken one.
 */
export const SHELL_NETWORK_TIMEOUT_MS = 3_000;

/**
 * The navigation handler: current shell first, precached shell as the backup.
 *
 * This used to be the precached shell and nothing else, which is what made
 * every launch after a deploy load the app twice. The sequence was: the worker
 * answers the navigation from its cache, so the app starts on the build it was
 * *last* told about; the browser then checks the worker script, finds a new
 * one, downloads the new build in the background and activates it; and the
 * page — now several seconds in and on screen — reloads to pick it up. Two
 * loads, every time a deploy had landed since the last launch, and this repo
 * deploys most days.
 *
 * Asking the network first removes the reason for the second load rather than
 * hiding it: the launch starts on the build that is live, so the update the
 * worker installs behind it is one the page is already running, and
 * `utils/workerBuild.ts` sees the build ids match and stands the reload down.
 *
 * The cost is one request for a document of a few hundred bytes, on an app
 * where nothing on screen can be filled in without the network anyway — every
 * `/api/*` read goes to the server by design (see `sw.ts`). Offline and slow
 * launches keep working exactly as they did, on the precached shell.
 */
export function createShellHandler(
  precachedShell: RouteHandlerCallback,
  timeoutMs: number = SHELL_NETWORK_TIMEOUT_MS,
): RouteHandlerCallback {
  return async (options: RouteHandlerCallbackOptions): Promise<Response> => {
    // A browser that says it is offline is not going to surprise anyone by
    // answering, and waiting out the timeout for it would add three seconds to
    // every launch in a dead spot.
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      return precachedShell(options);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const fresh = await Promise.race([
      fetch(options.request).catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);

    // A 5xx is the edge having a bad minute, not a new build, and a shell one
    // build old beats an error page. Everything else the server says has to
    // reach the browser as it is — including the opaque redirect Cloudflare
    // Access answers an expired session with, which is how the installed app
    // finds its way back to the login flow.
    if (fresh && fresh.status < 500) return fresh;

    return precachedShell(options);
  };
}
