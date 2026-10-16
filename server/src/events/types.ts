/**
 * The domain events this Worker publishes, and what each one carries.
 *
 * A write says *what happened* once; whatever cares subscribes (see
 * `subscribers.ts`). The write path stops being the place where the list of
 * consequences lives.
 *
 * **Identity, never the row.** `{ type, userId, taskId, … }` and nothing about
 * the task's contents: a queued message can be delivered after the row it
 * names has changed again, so a snapshot taken at emit time is a value that
 * *was* true. A subscriber that needs the task re-reads D1. It also means no
 * task title ever sits in a queue's retention window.
 *
 * `at` is when the event was emitted, not anything about the task.
 */

export type DomainEventType =
  | "task.created"
  | "task.updated"
  | "task.completed"
  | "task.reopened"
  | "task.snoozed"
  | "task.deleted";

export interface DomainEvent {
  type: DomainEventType;
  userId: number;
  taskId: number;
  /** When this event was emitted, ISO 8601. */
  at: string;
}

/** Build one event, stamping `at`. */
export function taskEvent(
  type: DomainEventType,
  fields: Omit<DomainEvent, "type" | "at">,
): DomainEvent {
  return { type, ...fields, at: new Date().toISOString() };
}
