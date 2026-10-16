/// <reference lib="webworker" />

/**
 * The app's service worker.
 *
 * Hand-written (`injectManifest`) so the caching policy is explicit code
 * rather than plugin config, because the policy is the point:
 *
 *   API data is never cached. Not network-first, not as an offline fallback —
 *   never.
 *
 * The task list is read as the current state of things — what is due, what
 * is done — so a saved copy presented later is worse than no data: it reads
 * as a fact and may be false (the task was finished on the laptop an hour
 * ago). Keeping no copy is the only version with nothing to get wrong. When
 * the server is unreachable the app keeps whatever it last rendered, says so
 * in a banner, and retries — see `useDataRefresh` and `freshness.ts`.
 *
 * Priorities, in order: never show stale data, then cost, then performance.
 * Offline readability was the price; it was only ever readable-but-wrong.
 *
 * What *is* cached: the precached app shell (versioned per build, so never
 * stale in the data sense) and Google Fonts (immutable).
 */

import { clientsClaim } from "workbox-core";
import { createHandlerBoundToURL, precacheAndRoute, cleanupOutdatedCaches } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { StaleWhileRevalidate } from "workbox-strategies";
import { ExpirationPlugin } from "workbox-expiration";
import { CacheableResponsePlugin } from "workbox-cacheable-response";
import { createShellHandler } from "./utils/appShell";
import { BUILD_ID_REQUEST, type BuildIdReply } from "./serviceWorkerContract";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

// A new build should take over as soon as it is ready. The page decides *when*
// to reload for it — see `createDeferredReload`, which holds the reload until
// it can't cost the user a half-filled form.
self.skipWaiting();
clientsClaim();

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// Navigations are answered with the shell that is live, falling back to the
// precached one when the network is slow, down, or broken — see
// `utils/appShell.ts` for why that way round, and what it costs. Excluded are
// the requests that have to reach the edge: /api/auth/login runs Cloudflare
// Access's redirect flow, and /cdn-cgi/ is its callback — answering either
// with cached HTML means the auth cookie is never set and the installed app
// spins forever.
registerRoute(
  new NavigationRoute(createShellHandler(createHandlerBoundToURL("index.html")), {
    denylist: [/^\/api\//, /^\/cdn-cgi\//],
  })
);

// Which build this worker serves.
//
// Asked by the page whenever the worker reports a new build, so that an update
// the page is *already running* does not turn into a second visible load of
// the app. See `serviceWorkerContract.ts` and `utils/workerBuild.ts`.
self.addEventListener("message", (event) => {
  const data = event.data as { type?: string } | null;
  if (data?.type !== BUILD_ID_REQUEST) return;
  const reply: BuildIdReply = { buildId: __BUILD_ID__ };
  event.ports[0]?.postMessage(reply);
});

// No route matches /api/* — deliberately. Those requests pass straight
// through to the network and fail honestly when it's down.

registerRoute(
  ({ url }) =>
    url.origin === "https://fonts.googleapis.com" || url.origin === "https://fonts.gstatic.com",
  new StaleWhileRevalidate({
    cacheName: "google-fonts",
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 30 }),
    ],
  })
);

// Task reminders (server/src/scheduled/reminders.ts). The payload is decided
// by the server at the moment the reminder fires, so unlike API data there is
// nothing in it that can go stale by being shown.
//
// `tag` names the task, which does two things: a snoozed reminder that fires
// again replaces the old notification instead of stacking under it, and the
// app can take it back off the lock screen once the task is done — see
// `utils/reminderNotifications.ts`.
//
// Done and Snooze act straight from the notification, with no window opened.
// They are same-origin fetches, so the Cloudflare Access cookie goes with
// them. If the session has expired (Access answers 401/403, or redirects and
// the fetch throws) the app is opened on the task instead, where the normal
// re-auth flow can run. iOS shows no action buttons; a tap opens the task.
interface ReminderPayload {
  title?: string;
  body?: string;
  url?: string;
  tag?: string;
  taskId?: number;
}

const SNOOZE_MINUTES = 10;

self.addEventListener("push", (event) => {
  const data: ReminderPayload = event.data?.json() ?? {};
  const actions = data.taskId
    ? [
        { action: "done", title: "Done" },
        { action: "snooze", title: `Snooze ${SNOOZE_MINUTES}m` },
      ]
    : [];
  event.waitUntil(
    self.registration.showNotification(data.title ?? "Tasks", {
      body: data.body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: data.tag,
      data: { url: data.url ?? "/", taskId: data.taskId },
      // `actions` is not in TypeScript's NotificationOptions yet.
      ...({ actions } as object),
    }),
  );
});

async function actOnTask(taskId: number, action: "done" | "snooze"): Promise<boolean> {
  const path = action === "done" ? "complete" : "snooze";
  try {
    const res = await fetch(`/api/tasks/${taskId}/${path}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(action === "snooze" ? { minutes: SNOOZE_MINUTES } : {}),
    });
    return res.ok;
  } catch {
    return false;
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { url, taskId } = (event.notification.data ?? {}) as { url?: string; taskId?: number };
  const action = event.action;

  event.waitUntil(
    (async () => {
      if (taskId && (action === "done" || action === "snooze")) {
        if (await actOnTask(taskId, action)) return;
      }
      // Focus an open window rather than stacking a second copy of the app.
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const target = url ?? "/";
      for (const client of windows) {
        if ("navigate" in client) {
          await (client as WindowClient).navigate(target).catch(() => undefined);
          await (client as WindowClient).focus();
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
