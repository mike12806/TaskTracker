import { describe, it, expect } from "vitest";
import { parseQuickAdd } from "../src/utils/quickAdd";

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

  it("keeps an @word that is not a date", () => {
    expect(parseQuickAdd("Email @fridge-guy", NOW).title).toBe("Email @fridge-guy");
    expect(parseQuickAdd("Ping @fr", NOW).title).toBe("Ping @fr");
  });
});
