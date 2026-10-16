import type { Env } from "../types/env.js";
import type { DomainEvent } from "./types.js";
import { resolveTaskAlerts } from "../alerts.js";

/**
 * One reaction to an event.
 *
 * `handles` is separate from `handle` so the dispatcher can tell "this
 * subscriber does not care" apart from "this subscriber ran and did nothing".
 */
export interface Subscriber {
  /** Stable name, used in log lines when this one throws. */
  name: string;
  handles(event: DomainEvent): boolean;
  handle(env: Env, event: DomainEvent): Promise<void>;
}

/**
 * A reminder alert says "this task is due your attention". It stops being
 * true when the task is done, gone, snoozed, or has had its reminder moved —
 * and when it stops being true it comes off the bell (and, on the next
 * refresh, off the lock screen; see `client/src/utils/reminderNotifications.ts`).
 *
 * Decided by re-reading the task rather than trusting the event, so it is
 * safe to run late or twice: it evaluates the world at the moment it runs.
 */
const reminderResolution: Subscriber = {
  name: "reminder-resolution",
  handles: (event) =>
    event.type === "task.completed" ||
    event.type === "task.deleted" ||
    event.type === "task.snoozed" ||
    event.type === "task.updated",
  handle: async (env, event) => {
    await resolveTaskAlerts(env, event.userId, event.taskId);
  },
};

/**
 * Every subscriber. Order is not significance, and **every subscriber must be
 * idempotent** — the dispatcher retries the whole message when any one fails.
 */
export const SUBSCRIBERS: Subscriber[] = [reminderResolution];
