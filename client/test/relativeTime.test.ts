import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatRelativeTime } from "../src/utils/dateTime";

// Anchored to a local noon so the calendar-day boundaries below are unambiguous
// regardless of the timezone the suite runs in.
const NOW = new Date(2026, 2, 4, 12, 0, 0);

function minutesAgo(mins: number): string {
  return new Date(NOW.getTime() - mins * 60000).toISOString();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("formatRelativeTime", () => {
  it("collapses anything under a minute to 'Just now'", () => {
    expect(formatRelativeTime(minutesAgo(0))).toBe("Just now");
    expect(formatRelativeTime(minutesAgo(0.4))).toBe("Just now");
  });

  it("treats future timestamps as 'Just now' rather than negative durations", () => {
    expect(formatRelativeTime(new Date(NOW.getTime() + 90000).toISOString())).toBe("Just now");
  });

  it("reports minutes under an hour", () => {
    expect(formatRelativeTime(minutesAgo(1))).toBe("1m ago");
    expect(formatRelativeTime(minutesAgo(59))).toBe("59m ago");
  });

  // The point of one helper: two screens used to disagree, one flooring this
  // to "3h ago" while the other said "3h 25m ago" for the same timestamp.
  it("keeps leftover minutes under a day", () => {
    expect(formatRelativeTime(minutesAgo(205))).toBe("3h 25m ago");
  });

  it("drops the minutes when a gap lands on the hour", () => {
    expect(formatRelativeTime(minutesAgo(180))).toBe("3h ago");
  });

  it("stays in hours right up to the 24-hour mark", () => {
    expect(formatRelativeTime(minutesAgo(23 * 60 + 59))).toBe("23h 59m ago");
  });

  it("counts calendar days, not elapsed 24-hour blocks", () => {
    // Saturday 11pm read on Monday noon is 37 hours — one elapsed "day", but
    // two calendar days back.
    const saturdayNight = new Date(2026, 2, 2, 23, 0, 0);
    vi.setSystemTime(new Date(2026, 2, 4, 12, 0, 0));
    expect(formatRelativeTime(saturdayNight.toISOString())).toBe("2d ago");
  });

  it("names the previous calendar day 'Yesterday'", () => {
    expect(formatRelativeTime(new Date(2026, 2, 3, 9, 0, 0).toISOString())).toBe("Yesterday");
  });

  it("falls back to a date past a week", () => {
    const old = new Date(2026, 1, 20, 9, 0, 0);
    expect(formatRelativeTime(old.toISOString())).toBe(
      old.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    );
  });

  it("returns a placeholder for an unparseable timestamp", () => {
    expect(formatRelativeTime("not a date")).toBe("—");
  });
});
