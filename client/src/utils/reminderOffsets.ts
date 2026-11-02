/**
 * Reminders set relative to a task's due time.
 *
 * Nothing about the offset is stored: the server only ever sees `remind_at`.
 * The form works the offset back out when a task is opened (`offsetFor`), and
 * recurrence shifts `remind_at` by the same number of days as the due date,
 * so a successor keeps the same "1 hour before".
 *
 * Day offsets are calendar days, not multiples of 24 hours, so "1 day before"
 * a 09:00 task is 09:00 the day before even across a DST change.
 */
export const REMINDER_OFFSETS = [
  { key: "at_due", label: "At due time", minutes: 0, days: 0 },
  { key: "15m", label: "15 minutes before", minutes: 15, days: 0 },
  { key: "30m", label: "30 minutes before", minutes: 30, days: 0 },
  { key: "1h", label: "1 hour before", minutes: 60, days: 0 },
  { key: "2h", label: "2 hours before", minutes: 120, days: 0 },
  { key: "1d", label: "1 day before", minutes: 0, days: 1 },
  { key: "2d", label: "2 days before", minutes: 0, days: 2 },
  { key: "1w", label: "1 week before", minutes: 0, days: 7 },
] as const;

export type ReminderOffset = (typeof REMINDER_OFFSETS)[number]["key"];

export function isReminderOffset(value: string): value is ReminderOffset {
  return REMINDER_OFFSETS.some((o) => o.key === value);
}

/** The instant to remind at, for a due date and time and an offset before it. */
export function remindAtForOffset(dueDate: string, dueTime: string, offset: ReminderOffset): string {
  const { minutes, days } = REMINDER_OFFSETS.find((o) => o.key === offset)!;
  const [y, m, d] = dueDate.split("-").map(Number);
  const [hh, mm] = dueTime.split(":").map(Number);
  const local = new Date(y, m - 1, d - days, hh, mm);
  return new Date(local.getTime() - minutes * 60_000).toISOString();
}

/** Which offset a stored `remind_at` corresponds to, if any. */
export function offsetFor(dueDate: string, dueTime: string, remindAt: string): ReminderOffset | null {
  const at = Date.parse(remindAt);
  // Compared to the minute: a snooze can leave seconds on `remind_at`.
  const minute = (ms: number) => Math.floor(ms / 60_000);
  const match = REMINDER_OFFSETS.find((o) => minute(Date.parse(remindAtForOffset(dueDate, dueTime, o.key))) === minute(at));
  return match?.key ?? null;
}

