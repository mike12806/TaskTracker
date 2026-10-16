import { describe, it, expect } from "vitest";
import {
  addMonths,
  daysBetween,
  localDateStr,
  localParts,
  localToUtc,
  nextOccurrence,
  shiftInstantByDays,
} from "../src/time.js";

const NY = "America/New_York";

describe("localToUtc", () => {
  it("converts a wall-clock time in EST and EDT", () => {
    expect(localToUtc("2026-01-15", "09:00", NY).toISOString()).toBe("2026-01-15T14:00:00.000Z");
    expect(localToUtc("2026-07-15", "09:00", NY).toISOString()).toBe("2026-07-15T13:00:00.000Z");
  });

  it("uses the offset in force at the answer, either side of a DST change", () => {
    // 2026-03-08 is the spring-forward Sunday in the US.
    expect(localToUtc("2026-03-08", "01:30", NY).toISOString()).toBe("2026-03-08T06:30:00.000Z");
    expect(localToUtc("2026-03-08", "09:00", NY).toISOString()).toBe("2026-03-08T13:00:00.000Z");
  });

  it("round-trips through localParts", () => {
    const instant = localToUtc("2026-11-01", "23:45", "Asia/Kolkata");
    const p = localParts(instant, "Asia/Kolkata");
    expect([p.year, p.month, p.day, p.hour, p.minute]).toEqual([2026, 11, 1, 23, 45]);
  });
});

describe("calendar arithmetic", () => {
  it("clamps months to the end of a shorter month", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonths("2026-11-15", 3)).toBe("2027-02-15");
  });

  it("steps weekdays over the weekend", () => {
    expect(nextOccurrence("2026-10-16", "weekdays", 1)).toBe("2026-10-19"); // Fri -> Mon
    expect(nextOccurrence("2026-10-14", "weekdays", 1)).toBe("2026-10-15");
  });

  it("applies the interval", () => {
    expect(nextOccurrence("2026-10-16", "daily", 3)).toBe("2026-10-19");
    expect(nextOccurrence("2026-10-16", "weekly", 2)).toBe("2026-10-30");
    expect(nextOccurrence("2024-02-29", "yearly", 1)).toBe("2025-02-28");
  });

  it("counts days across month ends", () => {
    expect(daysBetween("2026-10-30", "2026-11-02")).toBe(3);
  });
});

describe("shiftInstantByDays", () => {
  it("keeps the wall-clock time across a DST change", () => {
    // 9:00 EDT on Saturday Oct 31 2026 -> 9:00 EST on Sunday Nov 1.
    const sat = localToUtc("2026-10-31", "09:00", NY);
    const sun = shiftInstantByDays(sat, 1, NY);
    expect(sun.toISOString()).toBe("2026-11-01T14:00:00.000Z");
    expect(localDateStr(sun, NY)).toBe("2026-11-01");
  });
});
