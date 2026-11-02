import { localToIso, todayStr } from "./taskDates";
import type { Task, TaskInput } from "../types/models";

/**
 * Whether a task's due date and reminder are acceptable to save.
 *
 * Only what is being *set* is checked. A task that has already slipped into
 * the past must stay editable — retitling an overdue task, or changing its
 * priority, can't be blocked by a due date the user isn't touching — so a due
 * date or reminder equal to what the task already has is never a problem.
 *
 * "Past" is judged to the minute, since the form only works in whole minutes:
 * 10:07 is still allowed at 10:07:40.
 *
 * Client-side on purpose. The server also receives creates that were queued
 * offline and replayed later (`api/outbox.ts`), and a due time that was fine
 * when typed would be rejected on replay.
 */
export interface ScheduleProblems {
  due?: string;
  reminder?: string;
}

const minuteOf = (ms: number) => Math.floor(ms / 60_000);

/** Whether a reminder is the same minute as the task's existing one (a snooze can leave seconds). */
export function reminderUnchanged(task: Task | null, input: Pick<TaskInput, "remind_at">): boolean {
  if (!task?.remind_at || !input.remind_at) return false;
  return minuteOf(Date.parse(task.remind_at)) === minuteOf(Date.parse(input.remind_at));
}

export function scheduleProblems(
  input: Pick<TaskInput, "due_date" | "due_time" | "remind_at">,
  task: Task | null,
  now = new Date(),
): ScheduleProblems {
  const problems: ScheduleProblems = {};
  const thisMinute = minuteOf(now.getTime());

  const dueChanged = !task || task.due_date !== input.due_date || (task.due_time ?? null) !== (input.due_time ?? null);
  if (input.due_date && dueChanged) {
    // A past date says so even though it also carries a (default) time.
    if (input.due_date < todayStr(now)) problems.due = "That date has already passed.";
    else if (input.due_time && minuteOf(Date.parse(localToIso(input.due_date, input.due_time))) < thisMinute) {
      problems.due = "That time has already passed.";
    }
  }

  if (input.remind_at && !reminderUnchanged(task, input) && minuteOf(Date.parse(input.remind_at)) < thisMinute) {
    problems.reminder = "That reminder time has already passed.";
  }

  return problems;
}
