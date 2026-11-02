import { describe, it, expect } from "vitest";
import { parseQuickAdd, quickAddSchedule } from "../src/utils/quickAdd";

// Friday 16 October 2026, local time.
const NOW = new Date(2026, 9, 16, 10, 0);

describe("parseQuickAdd", () => {
  it("leaves a plain title alone, including words that look like dates", () => {
    expect(parseQuickAdd("Call mom tomorrow", NOW)).toEqual({ title: "Call mom tomorrow" });
  });

  it("reads priority and date tokens anywhere in the line", () => {
    expect(parseQuickAdd("!high Pay rent @tomorrow", NOW)).toEqual({
      title: "Pay rent",
      priority: "high",
      due_date: "2026-10-17",
    });
    expect(parseQuickAdd("Stretch !3 @today", NOW)).toEqual({ title: "Stretch", priority: "low", due_date: "2026-10-16" });
  });

  it("takes a weekday as the next one, never today", () => {
    expect(parseQuickAdd("Standup @mon", NOW).due_date).toBe("2026-10-19");
    expect(parseQuickAdd("Report @friday", NOW).due_date).toBe("2026-10-23");
  });

  it("gives a dated task the default time and a reminder at it", () => {
    expect(quickAddSchedule("2026-10-17", "09:00", NOW)).toEqual({
      due_time: "09:00",
      remind_at: new Date(2026, 9, 17, 9, 0).toISOString(),
    });
  });

  it("starts a task for today three hours out once the default time has passed", () => {
    // NOW is 10:00, so 09:00 today is behind us.
    expect(quickAddSchedule("2026-10-16", "09:00", NOW)).toEqual({
      due_time: "13:00",
      remind_at: new Date(2026, 9, 16, 13, 0).toISOString(),
    });
    expect(quickAddSchedule("2026-10-16", "17:30", NOW).due_time).toBe("17:30");
  });

  it("never arms a reminder that has already passed", () => {
    expect(quickAddSchedule("2026-10-16", "09:00", new Date(2026, 9, 16, 23, 59, 30))).toEqual({
      due_time: "23:59",
      remind_at: null,
    });
  });

  it("keeps an @word that is not a date", () => {
    expect(parseQuickAdd("Email @fridge-guy", NOW).title).toBe("Email @fridge-guy");
    expect(parseQuickAdd("Ping @fr", NOW).title).toBe("Ping @fr");
  });
});
