import { addDaysStr, todayStr } from "./taskDates";
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
