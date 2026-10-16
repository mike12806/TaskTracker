import type { Env } from "../types/env.js";
import { sendPushMessage } from "../pushSend.js";
import { recordAlert, reminderDedupeKey } from "../alerts.js";
import { notifyChange } from "../live.js";
import { toIsoSeconds } from "../time.js";

/** Queue name, as declared in `wrangler.toml`. */
export const REMINDER_QUEUE = "task-tracker-reminders";

/**
 * One push to one device.
 *
 * Carries the task's identity and the sentence to show, both decided by the
 * cron — the consumer only delivers. The title is in the job (unlike a
 * domain event) because the notification has to say it, and re-reading the
 * task at delivery would let a push that is a few seconds late describe a
 * task that has since been renamed rather than the one that came due.
 */
export interface ReminderJob {
  subscriptionId: number;
  kind: "reminder" | "confirmation";
  taskId?: number;
  title?: string;
  body?: string;
}

/**
 * The `tag` a reminder notification is shown under, and the identity the app
 * uses to take it back off the lock screen once the task is dealt with.
 *
 * Shared with the client (`client/src/utils/reminderNotifications.ts`), which
 * rebuilds the same string from the alerts feed: a notification whose tag no
 * longer names an open alert has been answered and is closed. Keyed on the
 * task, so a snoozed reminder that fires again replaces the old notification
 * instead of stacking under it.
 */
export function reminderNotificationTag(taskId: number): string {
  return `reminder:${taskId}`;
}

/** The sentence a reminder says — the push and the feed row both use this. */
export function reminderBody(task: { due_date: string | null; due_time: string | null }): string {
  if (task.due_date && task.due_time) return `Due ${task.due_date} at ${task.due_time}.`;
  if (task.due_date) return `Due ${task.due_date}.`;
  return "Reminder.";
}

interface ClaimedTask {
  id: number;
  user_id: number;
  title: string;
  remind_at: string;
  due_date: string | null;
  due_time: string | null;
}

/** Most reminders claimed in one tick. Anything beyond is picked up next minute. */
const CLAIM_BATCH = 100;

/**
 * Runs on the every-minute cron. Claims every open task whose reminder has
 * come due and has not fired yet, records an alert for each, and enqueues one
 * push per subscribed device.
 *
 * **The claim is the UPDATE.** `reminded_at = remind_at` is set in the same
 * statement that selects the task, so two overlapping cron invocations cannot
 * both see it — whichever runs second finds nothing to claim. A reminder fires
 * once per `remind_at` value: snoozing moves `remind_at`, which makes the task
 * claimable again, and nothing else does.
 *
 * Everything after the claim is outside the transaction and is allowed to
 * fail: the alert row is written before any push is queued (so the bell has
 * it even when every push fails), and a failed push is retried by the queue.
 */
export async function runReminderCron(env: Env, now = new Date()): Promise<number> {
  const claimed = await env.DB.prepare(
    `UPDATE tasks SET reminded_at = remind_at
      WHERE id IN (
        SELECT id FROM tasks
         WHERE completed = 0 AND remind_at IS NOT NULL AND remind_at <= ?
           AND (reminded_at IS NULL OR reminded_at != remind_at)
         ORDER BY remind_at
         LIMIT ?
      )
      RETURNING id, user_id, title, remind_at, due_date, due_time`,
  )
    .bind(toIsoSeconds(now), CLAIM_BATCH)
    .all<ClaimedTask>();

  for (const task of claimed.results) {
    try {
      await fireReminder(env, task);
    } catch (err) {
      // One task's failure must not cost the rest of the batch their
      // reminders. The claim stands — the alert row may well already exist —
      // so this one is logged rather than retried on the next tick.
      console.error(`Reminder for task ${task.id} failed after its claim:`, err);
    }
  }

  // The tasks themselves changed (reminded_at), which only matters to a
  // client showing reminder state — but it is one nudge per user per tick at
  // most, and only on ticks that fired something.
  const users = new Set(claimed.results.map((t) => t.user_id));
  for (const userId of users) await notifyChange(env, userId, "tasks");

  return claimed.results.length;
}

async function fireReminder(env: Env, task: ClaimedTask): Promise<void> {
  const body = reminderBody(task);

  await recordAlert(env, {
    userId: task.user_id,
    taskId: task.id,
    kind: "reminder",
    title: task.title,
    body,
    url: `/?task=${task.id}`,
    dedupeKey: reminderDedupeKey(task.id, task.remind_at),
  });

  const subscriptions = await env.DB.prepare("SELECT id FROM push_subscriptions WHERE user_id = ?")
    .bind(task.user_id)
    .all<{ id: number }>();

  for (const sub of subscriptions.results) {
    const job: ReminderJob = {
      subscriptionId: sub.id,
      kind: "reminder",
      taskId: task.id,
      title: task.title,
      body,
    };
    if (env.REMINDER_QUEUE) await env.REMINDER_QUEUE.send(job);
    else await deliverReminder(env, job);
  }
}

/** Sends one reminder push; run from the queue consumer. */
export async function deliverReminder(env: Env, job: ReminderJob): Promise<void> {
  const sub = await env.DB.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE id = ?")
    .bind(job.subscriptionId)
    .first<{ endpoint: string; p256dh: string; auth: string }>();

  // Unsubscribed between enqueue and delivery — nothing to do.
  if (!sub) return;

  if (job.kind === "confirmation") {
    await sendPushMessage(env, sub, {
      title: "Tasks",
      body: "Reminders are on. They'll show up here when they're due.",
      url: "/",
    });
    return;
  }

  if (!job.taskId) return;

  // A task completed in the seconds between the claim and this delivery
  // should not buzz a phone about something already done.
  const open = await env.DB.prepare("SELECT 1 AS ok FROM tasks WHERE id = ? AND completed = 0")
    .bind(job.taskId)
    .first();
  if (!open) return;

  await sendPushMessage(env, sub, {
    title: job.title ?? "Reminder",
    body: job.body ?? "Reminder.",
    url: `/?task=${job.taskId}`,
    tag: reminderNotificationTag(job.taskId),
    taskId: job.taskId,
  });
}

/**
 * The confirmation push a fresh subscription gets right away — see
 * `routes/push.ts` — through the same retrying queue as every other push.
 */
export async function enqueueConfirmation(env: Env, subscriptionId: number): Promise<void> {
  const job: ReminderJob = { subscriptionId, kind: "confirmation" };
  if (env.REMINDER_QUEUE) await env.REMINDER_QUEUE.send(job);
  else await deliverReminder(env, job);
}
