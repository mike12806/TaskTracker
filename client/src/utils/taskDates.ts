import type { Task } from "../types/models";

/**
 * Due dates in the app's terms.
 *
 * A due date is a calendar date in the user's timezone, and "the user's
 * timezone" is the device's: `SettingsProvider` keeps the server's copy in
 * step with it, so the dates the server does arithmetic on are the same ones
 * shown here.
 */

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD` for a Date in the device's local time. */
export function toDateStr(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function todayStr(now = new Date()): string {
  return toDateStr(now);
}

export function addDaysStr(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return toDateStr(new Date(y, m - 1, d + days));
}

/** A `YYYY-MM-DD` date as a local Date at midnight. */
export function parseDateStr(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Local date and time to an ISO instant. */
export function localToIso(date: string, time: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  return new Date(y, m - 1, d, hh, mm).toISOString();
}

/** An ISO instant as the `YYYY-MM-DDTHH:MM` a datetime-local input wants. */
export function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  return `${toDateStr(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "9:30 AM", in the device's locale. */
export function formatTime(time: string): string {
  const [hh, mm] = time.split(":").map(Number);
  return new Date(2000, 0, 1, hh, mm).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** "Today", "Tomorrow", "Yesterday", "Fri", "Oct 24", "Oct 24, 2027". */
export function formatDueDate(date: string, now = new Date()): string {
  const today = todayStr(now);
  if (date === today) return "Today";
  if (date === addDaysStr(today, 1)) return "Tomorrow";
  if (date === addDaysStr(today, -1)) return "Yesterday";
  const d = parseDateStr(date);
  const days = Math.round((d.getTime() - parseDateStr(today).getTime()) / 86_400_000);
  if (days > 1 && days < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

/** A heading for a day in a grouped list: "Tomorrow · Sat, Oct 17", or "Wed, Oct 21". */
export function formatDayHeading(date: string, now = new Date()): string {
  const label = formatDueDate(date, now);
  const long = parseDateStr(date).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  // Only "Today"/"Tomorrow"/"Yesterday" add anything the date doesn't say.
  return ["Today", "Tomorrow", "Yesterday"].includes(label) ? `${label} · ${long}` : long;
}

export function formatDue(task: Pick<Task, "due_date" | "due_time">, now = new Date()): string | null {
  if (!task.due_date) return null;
  const date = formatDueDate(task.due_date, now);
  return task.due_time ? `${date} ${formatTime(task.due_time)}` : date;
}

export function isOverdue(task: Pick<Task, "due_date" | "due_time" | "completed">, now = new Date()): boolean {
  if (task.completed || !task.due_date) return false;
  const today = todayStr(now);
  if (task.due_date < today) return true;
  if (task.due_date > today || !task.due_time) return false;
  return new Date(localToIso(task.due_date, task.due_time)).getTime() < now.getTime();
}

/** "Every day", "Every 2 weeks", "Every weekday". */
export function describeRecurrence(task: Pick<Task, "recurrence" | "recurrence_interval">): string | null {
  const n = task.recurrence_interval || 1;
  const unit = { daily: "day", weekly: "week", monthly: "month", yearly: "year" } as const;
  switch (task.recurrence) {
    case "none":
      return null;
    case "weekdays":
      return "Every weekday";
    default:
      return n === 1 ? `Every ${unit[task.recurrence]}` : `Every ${n} ${unit[task.recurrence]}s`;
  }
}

/** Whether a task's reminder is still ahead of it. */
export function hasUpcomingReminder(task: Pick<Task, "remind_at" | "reminded_at">, now = new Date()): boolean {
  return Boolean(task.remind_at && task.remind_at !== task.reminded_at && Date.parse(task.remind_at) > now.getTime());
}

const PRIORITY_RANK = { high: 0, medium: 1, low: 2, none: 3 } as const;

/**
 * The order every view shows tasks in — the same order the server sends them,
 * re-applied here so a task queued on this device lands where its saved
 * version will.
 */
export function compareTasks(a: Task, b: Task): number {
  if (!!a.due_date !== !!b.due_date) return a.due_date ? -1 : 1;
  if (a.due_date && b.due_date && a.due_date !== b.due_date) return a.due_date < b.due_date ? -1 : 1;
  if (!!a.due_time !== !!b.due_time) return a.due_time ? -1 : 1;
  if (a.due_time && b.due_time && a.due_time !== b.due_time) return a.due_time < b.due_time ? -1 : 1;
  const p = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (p !== 0) return p;
  return b.created_at.localeCompare(a.created_at);
}
