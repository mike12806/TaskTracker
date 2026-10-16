import { BUILD_ID_REQUEST, type BuildIdReply } from "../serviceWorkerContract";

/**
 * How long to wait for the worker to name its build (ms).
 *
 * This runs while the user is looking at the app, with a reload waiting on
 * the answer, so it is deliberately short. Silence is treated as "unknown"
 * and the reload goes ahead — see `updateChangesBuild`.
 */
export const BUILD_ID_TIMEOUT_MS = 2_000;

/**
 * The worker that has just taken over, not the one still controlling the page.
 *
 * `navigator.serviceWorker.controller` is whatever is controlling this page,
 * which for the first moments after an update is still the *old* worker — the
 * build we are trying to leave, and so exactly the wrong thing to ask which
 * build is now installed. `registration.active` is the one that has just
 * activated.
 */
async function activeWorker(): Promise<ServiceWorker | null> {
  try {
    const registration = await navigator.serviceWorker.ready;
    return registration.active ?? navigator.serviceWorker.controller;
  } catch {
    return navigator.serviceWorker.controller;
  }
}

/**
 * Ask the active service worker which build it is serving.
 *
 * Null whenever there is no answer to be had: no worker, a browser without
 * `MessageChannel`, or a worker from a build that predates the message and so
 * says nothing. Null means *unknown* and never "the same build".
 */
export async function workerBuildId(
  timeoutMs: number = BUILD_ID_TIMEOUT_MS,
): Promise<string | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  if (typeof MessageChannel === "undefined") return null;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const answer = (async () => {
    const worker = await activeWorker();
    if (!worker) return null;

    return await new Promise<string | null>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event: MessageEvent) => {
        const data = event.data as Partial<BuildIdReply> | null;
        resolve(typeof data?.buildId === "string" ? data.buildId : null);
      };
      try {
        worker.postMessage({ type: BUILD_ID_REQUEST }, [channel.port2]);
      } catch {
        // A worker discarded between being handed to us and being asked.
        resolve(null);
      }
    });
  })();

  try {
    return await Promise.race([
      answer,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Would reloading for this update actually change the build on screen?
 *
 * The worker reports a new build whenever one activates, including the build
 * the page fetched from the network moments earlier at launch — see
 * `utils/appShell.ts`. Reloading for that one is a second visible load of the
 * app that changes nothing, and it is what made the installed app appear to
 * load twice whenever it was opened after a deploy.
 *
 * Unknown counts as changed. The reload is the safe direction: the worst a
 * needless one costs is the launch it is being saved here, while skipping a
 * real one leaves the device on an old build — which is the failure this whole
 * update path exists to avoid.
 */
export async function updateChangesBuild(
  timeoutMs: number = BUILD_ID_TIMEOUT_MS,
): Promise<boolean> {
  const installed = await workerBuildId(timeoutMs);
  return installed === null || installed !== __BUILD_ID__;
}
