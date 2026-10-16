// Service worker registration powered by vite-plugin-pwa.
//
// We import the virtual module dynamically so that tests (which use the same
// Vite config but don't ship a service worker) can safely skip registration
// without bundling the module.

import { createDeferredReload } from "./utils/deferredReload";
import { updateChangesBuild } from "./utils/workerBuild";

export function registerServiceWorker(): void {
  if (typeof window === "undefined") return;
  if (!("serviceWorker" in navigator)) return;

  const pendingUpdate = createDeferredReload(() => window.location.reload());

  void import("virtual:pwa-register")
    .then(({ registerSW }) => {
      registerSW({
        immediate: true,
        // With registerType: 'autoUpdate' the new service worker activates as
        // soon as it's ready, and vite-plugin-pwa reloads the page right then
        // unless we take over via `onNeedReload`. That reload lands seconds
        // after the app is opened following a deploy — often mid-form — and
        // wipes out whatever has been typed. Picking up fresh assets still
        // needs a reload, so hold it until the app is in the background.
        //
        // (`onNeedRefresh` is never called in autoUpdate mode; `onNeedReload`
        // is the hook that suppresses the plugin's built-in reload.)
        //
        // The worker reports every build it activates, including the one this
        // page is already running: a launch fetches the live shell (see
        // `utils/appShell.ts`) and the worker finishes precaching that same
        // build seconds later. Reloading then is a second load of the app with
        // nothing to show for it — the "why did it load twice?" that
        // foregrounding the installed app produced after every deploy — so ask
        // the worker what it has before asking for a reload.
        onNeedReload() {
          void updateChangesBuild().then((changed) => {
            if (changed) pendingUpdate.request();
          });
        },
      });
    })
    .catch(() => {
      // Ignore — service worker is a progressive enhancement.
    });
}
