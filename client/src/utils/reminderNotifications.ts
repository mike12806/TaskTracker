import type { Alert } from "../types/models";

/**
 * Taking an answered reminder back off the lock screen.
 *
 * A push is a copy of an alert that lives on the device rather than on the
 * server, so nothing the server does can retract it — complete the task on
 * the laptop and the phone's notification is still sitting there. Only the
 * page or the service worker can close it, so the app closes it itself.
 *
 * The rule is *the reminder notifications on this device that no longer name
 * an open alert get closed*. That falls out of the feed the bell already
 * fetches, and it covers every way a reminder is answered: completed here,
 * completed on another device, snoozed, deleted, or dismissed from the drawer.
 *
 * The identity is the notification `tag`, which the server sets from
 * `reminderNotificationTag` in `server/src/scheduled/reminders.ts`; the same
 * string is rebuilt here from the feed.
 */

/** Prefix every reminder notification's tag carries. */
export const REMINDER_TAG_PREFIX = "reminder:";

/** Must match `reminderNotificationTag` on the server, exactly. */
export function reminderTag(taskId: number): string {
  return `${REMINDER_TAG_PREFIX}${taskId}`;
}

/**
 * Close every reminder notification on this device that the given feed no
 * longer accounts for.
 *
 * Call it only with a feed that actually came back from the server: an empty
 * list because the request failed is not evidence that anything was answered.
 * Silent on every browser that can't do this.
 */
export async function closeAnsweredReminderNotifications(alerts: Alert[]): Promise<void> {
  try {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    // `getRegistration`, not `ready`: `ready` never settles when no worker is
    // registered at all, and this is called on every refresh.
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration || typeof registration.getNotifications !== "function") return;

    const open = await registration.getNotifications();
    if (open.length === 0) return;

    const stillOpen = new Set(
      alerts.filter((alert) => alert.kind === "reminder" && alert.task_id !== null).map((alert) => reminderTag(alert.task_id!)),
    );

    for (const notification of open) {
      if (notification.tag?.startsWith(REMINDER_TAG_PREFIX) && !stillOpen.has(notification.tag)) {
        notification.close();
      }
    }
  } catch {
    // Nothing to recover from: the alert is already off the bell.
  }
}
