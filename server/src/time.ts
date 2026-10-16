/**
 * Calendar arithmetic in the user's own timezone.
 *
 * Due dates are calendar dates ("Friday"), reminders are instants ("9:00 on
 * Friday, in New York"), and the two meet in three places: recurrence (the
 * next occurrence of a 9am reminder is 9am, even across a DST change), the
 * digest hour, and "what is today". All of it goes through here so there is
 * one implementation of the offset dance rather than three.
 *
 * Built on `Intl.DateTimeFormat`, which Workers ship with full zone data, so
 * there is no timezone library to keep up to date.
 */

/** Fallback when a stored timezone is not one this runtime recognises. */
export const DEFAULT_TIMEZONE = "America/New_York";

/** Whether `tz` is an IANA zone this runtime can format in. */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function safeZone(tz: string): string {
  return isValidTimezone(tz) ? tz : DEFAULT_TIMEZONE;
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The wall-clock reading of `instant` in `tz`. */
export function localParts(instant: Date, tz: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: safeZone(tz),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: WEEKDAYS.indexOf(get("weekday")),
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD` for `instant`'s calendar date in `tz`. */
export function localDateStr(instant: Date, tz: string): string {
  const p = localParts(instant, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** `HH:MM` for `instant`'s wall-clock time in `tz`. */
export function localTimeStr(instant: Date, tz: string): string {
  const p = localParts(instant, tz);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** Offset of `tz` from UTC at `instant`, in ms (positive east of Greenwich). */
function offsetMs(instant: Date, tz: string): number {
  const p = localParts(instant, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The instant at which the clock in `tz` reads `date` `time`.
 *
 * Two passes, because the offset to subtract is the one in force at the
 * *answer*, which is not known until the answer is: guess with the offset at
 * the naive reading, then correct with the offset at the guess. A wall-clock
 * time that does not exist (02:30 on a spring-forward night) lands an hour
 * later, which is what every phone's alarm clock does too.
 */
export function localToUtc(date: string, time: string, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const naive = Date.UTC(y, m - 1, d, hh, mm, 0);
  const zone = safeZone(tz);
  const first = naive - offsetMs(new Date(naive), zone);
  const second = naive - offsetMs(new Date(first), zone);
  return new Date(second);
}

/** ISO 8601 at second precision — the format every timestamp column uses. */
export function toIsoSeconds(instant: Date): string {
  return instant.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Add whole days to a `YYYY-MM-DD` date. Pure calendar arithmetic. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return next.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`, both `YYYY-MM-DD`. */
export function daysBetween(from: string, to: string): number {
  const [y1, m1, d1] = from.split("-").map(Number);
  const [y2, m2, d2] = to.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Add calendar months, clamping to the end of a shorter month (Jan 31 → Feb 28). */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const day = Math.min(d, daysInMonth(year, month));
  return `${year}-${pad(month)}-${pad(day)}`;
}

export type Recurrence = "none" | "daily" | "weekdays" | "weekly" | "monthly" | "yearly";

export const RECURRENCES: readonly Recurrence[] = [
  "none",
  "daily",
  "weekdays",
  "weekly",
  "monthly",
  "yearly",
];

/**
 * The next due date after `date` for a recurring task.
 *
 * `weekdays` ignores the interval — "every other weekday" is not a thing
 * anyone means — and steps to the next Monday–Friday date.
 */
export function nextOccurrence(date: string, recurrence: Recurrence, interval: number): string {
  const n = Math.max(1, Math.floor(interval || 1));
  switch (recurrence) {
    case "daily":
      return addDays(date, n);
    case "weekly":
      return addDays(date, 7 * n);
    case "monthly":
      return addMonths(date, n);
    case "yearly":
      return addMonths(date, 12 * n);
    case "weekdays": {
      let next = addDays(date, 1);
      for (;;) {
        const [y, m, d] = next.split("-").map(Number);
        const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
        if (dow !== 0 && dow !== 6) return next;
        next = addDays(next, 1);
      }
    }
    default:
      return date;
  }
}

/**
 * Move a reminder instant by whole calendar days while keeping its wall-clock
 * time in `tz` — 9:00 stays 9:00 across a DST change, which adding 24h × days
 * would not.
 */
export function shiftInstantByDays(instant: Date, days: number, tz: string): Date {
  const date = localDateStr(instant, tz);
  const time = localTimeStr(instant, tz);
  return localToUtc(addDays(date, days), time, tz);
}
