import { describe, it, expect } from "vitest";
import { offsetFor, remindAtForOffset } from "../src/utils/reminderOffsets";

const local = (y: number, m: number, d: number, hh: number, mm: number) => new Date(y, m - 1, d, hh, mm).toISOString();

describe("reminderOffsets", () => {
  it("counts back from the due time", () => {
    expect(remindAtForOffset("2026-10-16", "09:00", "at_due")).toBe(local(2026, 10, 16, 9, 0));
    expect(remindAtForOffset("2026-10-16", "09:00", "1h")).toBe(local(2026, 10, 16, 8, 0));
    expect(remindAtForOffset("2026-10-16", "01:00", "2h")).toBe(local(2026, 10, 15, 23, 0));
    expect(remindAtForOffset("2026-10-16", "09:00", "1d")).toBe(local(2026, 10, 15, 9, 0));
    expect(remindAtForOffset("2026-10-01", "09:00", "1w")).toBe(local(2026, 9, 24, 9, 0));
  });

  it("keeps day offsets on the same wall-clock time", () => {
    // Whether or not the test machine's zone has DST, a day before is the
    // same local time on the previous calendar date.
    const at = new Date(remindAtForOffset("2026-11-02", "09:00", "1d"));
    expect([at.getDate(), at.getHours(), at.getMinutes()]).toEqual([1, 9, 0]);
  });

  it("recognises an offset from a stored reminder, ignoring seconds", () => {
    expect(offsetFor("2026-10-16", "09:00", local(2026, 10, 16, 9, 0))).toBe("at_due");
    expect(offsetFor("2026-10-16", "09:00", local(2026, 10, 16, 7, 0))).toBe("2h");
    expect(offsetFor("2026-10-16", "09:00", new Date(Date.parse(local(2026, 10, 15, 9, 0)) + 30_000).toISOString())).toBe("1d");
    expect(offsetFor("2026-10-16", "09:00", local(2026, 10, 16, 8, 10))).toBeNull();
  });
});
