/**
 * The in-app alerts feed — the record behind the push notifications.
 *
 * Every reminder the cron fires is written here at the moment it is decided,
 * and the app's bell reads it back. Two rules, carried over from BabyTracker:
 *
 * 1. **Record at the decision, not at the delivery.** The reminder cron claims
 *    a task with a single UPDATE (see `scheduled/reminders.ts`); the row goes
 *    in right behind that claim, so the feed carries exactly the reminders
 *    that fired — one row, not one per device, and a row even when nothing is
 *    subscribed to push at all.
 * 2. **Never throw.** A feed write failing is not a reason for the push itself
 *    not to go out, nor for a task to fail to save.
 */

import type { Env } from "./types/env.js";
import { notifyChange } from "./live.js";
import { toIsoSeconds } from "./time.js";

export type AlertKind = "reminder";

export interface NewAlert {
  userId: number;
  taskId: number | null;
  kind: AlertKind;
  title: string;
  /** The sentence that was (or would have been) pushed, stored verbatim. */
  body: string;
  url?: string;
  dedupeKey: string;
}

/** How long an alert stays in the feed. */
export const ALERT_RETENTION_DAYS = 30;

/** The occasion a reminder alert is raised for: one task, one remind_at. */
export function reminderDedupeKey(taskId: number, remindAt: string): string {
  return `reminder:${taskId}:${remindAt}`;
}

/**
 * Write one alert to the feed, unless its occasion is already there. Returns
 * whether a row was actually inserted.
 */
export async function recordAlert(env: Env, alert: NewAlert): Promise<boolean> {
  try {
    const result = await env.DB.prepare(
      `INSERT INTO alerts (user_id, task_id, kind, title, body, url, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (dedupe_key) DO NOTHING`,
    )
      .bind(
        alert.userId,
        alert.taskId,
        alert.kind,
        alert.title,
        alert.body,
        alert.url ?? "/",
        alert.dedupeKey,
      )
      .run();
    const recorded = (result.meta?.changes ?? 0) > 0;
    // Only on a row that was actually written — a doubled cron lands here
    // twice for one occasion, and a nudge on the second is a refetch for
    // nothing. No origin id: this is a cron, so every device should hear it.
    if (recorded) await notifyChange(env, alert.userId, "alerts");
    return recorded;
  } catch (error) {
    console.error(`Failed to record the alert "${alert.dedupeKey}":`, error);
    return false;
  }
}

/**
 * Close every open reminder alert for one task that is no longer true.
 *
 * "No longer true" is decided by re-reading the task, never by trusting the
 * caller: the one alert left open is the one for the task's *current*
 * reminder, and only while the task is still open and that reminder has
 * actually fired. So completing, deleting or snoozing the task, or moving its
 * reminder, resolves the alert — and running this twice, or late, does
 * nothing further. That is the idempotence the event bus requires.
 *
 * Returns how many alerts it closed, nudging the user's devices when that is
 * more than none so the bell drops them without waiting for a poll.
 */
export async function resolveTaskAlerts(
  env: Env,
  userId: number,
  taskId: number,
  now = new Date(),
): Promise<number> {
  try {
    const task = await env.DB.prepare(
      "SELECT completed, remind_at, reminded_at FROM tasks WHERE id = ? AND user_id = ?",
    )
      .bind(taskId, userId)
      .first<{ completed: number; remind_at: string | null; reminded_at: string | null }>();

    const stillLive =
      task && task.completed === 0 && task.remind_at && task.reminded_at === task.remind_at
        ? reminderDedupeKey(taskId, task.remind_at)
        : null;

    const result = await env.DB.prepare(
      `UPDATE alerts SET resolved_at = ?
        WHERE user_id = ? AND dedupe_key LIKE ? AND resolved_at IS NULL
          AND (? IS NULL OR dedupe_key != ?)`,
    )
      .bind(toIsoSeconds(now), userId, `reminder:${taskId}:%`, stillLive, stillLive)
      .run();
    const resolved = result.meta?.changes ?? 0;
    if (resolved > 0) await notifyChange(env, userId, "alerts");
    return resolved;
  } catch (error) {
    console.error(`Failed to resolve alerts for task ${taskId}:`, error);
    return 0;
  }
}

/** Drop alerts older than the retention window. Run from the hourly cron. */
export async function pruneAlerts(env: Env, now = new Date()): Promise<number> {
  const cutoff = toIsoSeconds(new Date(now.getTime() - ALERT_RETENTION_DAYS * 86_400_000));
  const result = await env.DB.prepare("DELETE FROM alerts WHERE created_at < ?").bind(cutoff).run();
  return result.meta?.changes ?? 0;
}
