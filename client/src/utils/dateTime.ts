/**
 * Converts a UTC ISO 8601 timestamp to a local datetime string suitable
 * for use as the value of an <input type="datetime-local"> element
 * (format: "YYYY-MM-DDTHH:MM" in the user's local timezone).
 */
export function isoToLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Formats how long ago a timestamp was, as a short human phrase
 * ("Just now", "25m ago", "3h 25m ago", "Yesterday", "3d ago", "Mar 4").
 *
 * Under an hour the resolution is minutes; under a day it keeps the leftover
 * minutes, because the gap between events is the number a caregiver is
 * actually reading off these screens and "3h ago" hides up to 59 minutes of
 * it. Beyond a day it switches to calendar days rather than elapsed 24-hour
 * blocks, so an entry from Saturday night reads "2d ago" on Monday morning
 * instead of "Yesterday".
 */
export function formatRelativeTime(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "—";

  const now = new Date();
  const ms = now.getTime() - then.getTime();
  if (ms < 0) return "Just now";

  const mins = Math.round(ms / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;

  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hrs < 24) return remMins > 0 ? `${hrs}h ${remMins}m ago` : `${hrs}h ago`;

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfThen = new Date(then.getFullYear(), then.getMonth(), then.getDate());
  const days = Math.round((startOfToday.getTime() - startOfThen.getTime()) / 86400000);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;

  return then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
