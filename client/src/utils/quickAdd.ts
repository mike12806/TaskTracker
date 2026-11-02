import { addDaysStr, defaultDueTime, localToIso, todayStr } from "./taskDates";
import type { Priority } from "../types/models";

/**
 * The quick-add box's shorthand.
 *
 * Deliberately tiny and prefixed, so it can never eat a word someone meant as
 * part of the title: "Call mom tomorrow" stays exactly that, while
 * "Call mom @tomorrow !high" becomes a high-priority task due tomorrow. The
 * full editor is one tap away for anything else.
 *
 *   !high !medium !low  (or !h !m !l, !1 !2 !3)
 *   @today @tomorrow @mon … @sun (the next one, never today)  @next-week
 *
 * A task with a due date gets the default time and a reminder then, the same
 * as one made in the full editor (`quickAddSchedule`).
 */

const PRIORITY_TOKENS: Record<string, Priority> = {
  "!high": "high",
  "!h": "high",
  "!1": "high",
  "!medium": "medium",
  "!med": "medium",
  "!m": "medium",
  "!2": "medium",
  "!low": "low",
  "!l": "low",
  "!3": "low",
};

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function dateToken(token: string, now: Date): string | null {
  const t = token.slice(1);
  const today = todayStr(now);
  if (t === "today") return today;
  if (t === "tomorrow" || t === "tmr") return addDaysStr(today, 1);
  if (t === "next-week" || t === "nextweek") return addDaysStr(today, 7);
  // "@fri" or "@friday", but not "@fr" or "@fridge".
  const dow = t.length >= 3 ? WEEKDAYS.findIndex((day) => day.startsWith(t)) : -1;
  if (dow >= 0) {
    const ahead = (dow - now.getDay() + 7) % 7 || 7;
    return addDaysStr(today, ahead);
  }
  return null;
}

export interface QuickAddResult {
  title: string;
  priority?: Priority;
  due_date?: string;
}

/**
 * The due time and reminder a quick-added task with a due date starts with:
 * the same default time as the editor (`defaultDueTime`), and a reminder at it.
 *
 * Unlike the editor, there is nowhere here to warn that a reminder time has
 * already passed, and the cron fires a past reminder on the next tick. The
 * default time keeps today's reminders ahead, so in practice this only drops
 * one in the last minute of the day; it's a guard, not a rule.
 */
export function quickAddSchedule(
  dueDate: string,
  defaultTime: string,
  now = new Date(),
): { due_time: string; remind_at: string | null } {
  const dueTime = defaultDueTime(dueDate, defaultTime, now);
  const remindAt = localToIso(dueDate, dueTime);
  return { due_time: dueTime, remind_at: Date.parse(remindAt) > now.getTime() ? remindAt : null };
}

export function parseQuickAdd(text: string, now = new Date()): QuickAddResult {
  const result: QuickAddResult = { title: "" };
  const kept: string[] = [];
  for (const word of text.trim().split(/\s+/)) {
    const lower = word.toLowerCase();
    if (lower in PRIORITY_TOKENS) {
      result.priority = PRIORITY_TOKENS[lower];
      continue;
    }
    if (lower.startsWith("@")) {
      const date = dateToken(lower, now);
      if (date) {
        result.due_date = date;
        continue;
      }
    }
    kept.push(word);
  }
  result.title = kept.join(" ");
  return result;
}
