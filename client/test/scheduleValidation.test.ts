import { describe, it, expect } from "vitest";
import { scheduleProblems } from "../src/utils/scheduleValidation";
import type { Task } from "../src/types/models";

const NOW = new Date(2026, 9, 16, 10, 7, 40); // Fri 16 Oct 2026, 10:07:40 local
const at = (d: number, hh: number, mm: number) => new Date(2026, 9, d, hh, mm).toISOString();

function task(overrides: Partial<Task>): Task {
  return {
    id: 1, list_id: null, area_id: 1, title: "t", notes: null, priority: "none", due_date: null, due_time: null,
    remind_at: null, reminded_at: null, recurrence: "none", recurrence_interval: 1, completed: 0, completed_at: null,
    recurred_from_id: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", ...overrides,
  };
}

describe("scheduleProblems", () => {
  it("accepts a task with no schedule, today, and the future", () => {
    expect(scheduleProblems({ due_date: null, due_time: null, remind_at: null }, null, NOW)).toEqual({});
    expect(scheduleProblems({ due_date: "2026-10-16", due_time: null, remind_at: null }, null, NOW)).toEqual({});
    expect(scheduleProblems({ due_date: "2026-10-17", due_time: "09:00", remind_at: at(17, 8, 0) }, null, NOW)).toEqual({});
  });

  it("rejects a new due date or time that has passed", () => {
    expect(scheduleProblems({ due_date: "2026-10-15", due_time: null, remind_at: null }, null, NOW).due).toBeTruthy();
    expect(scheduleProblems({ due_date: "2026-10-16", due_time: "09:00", remind_at: null }, null, NOW).due).toBeTruthy();
  });

  it("judges to the minute, so the current minute is still allowed", () => {
    expect(scheduleProblems({ due_date: "2026-10-16", due_time: "10:07", remind_at: at(16, 10, 7) }, null, NOW)).toEqual({});
    expect(scheduleProblems({ due_date: "2026-10-16", due_time: "10:06", remind_at: at(16, 10, 6) }, null, NOW)).toEqual({
      due: "That time has already passed.",
      reminder: "That reminder time has already passed.",
    });
  });

  it("rejects a reminder in the past even when the due date is fine", () => {
    expect(scheduleProblems({ due_date: "2026-10-20", due_time: "09:00", remind_at: at(15, 9, 0) }, null, NOW).reminder).toBeTruthy();
  });

  it("leaves an existing task's untouched schedule alone, even if it is overdue", () => {
    const overdue = task({ due_date: "2026-10-10", due_time: "09:00", remind_at: at(10, 8, 0) });
    expect(scheduleProblems({ due_date: "2026-10-10", due_time: "09:00", remind_at: at(10, 8, 0) }, overdue, NOW)).toEqual({});
    // A snooze leaves seconds on remind_at; the form's minute-rounded value is still "unchanged".
    const snoozed = task({ remind_at: new Date(Date.parse(at(10, 8, 0)) + 30_000).toISOString() });
    expect(scheduleProblems({ due_date: null, due_time: null, remind_at: at(10, 8, 0) }, snoozed, NOW)).toEqual({});
  });

  it("still checks what an existing task is changed to", () => {
    const overdue = task({ due_date: "2026-10-10", due_time: "09:00", remind_at: at(10, 8, 0) });
    expect(scheduleProblems({ due_date: "2026-10-11", due_time: "09:00", remind_at: at(10, 8, 0) }, overdue, NOW).due).toBeTruthy();
    expect(scheduleProblems({ due_date: "2026-10-10", due_time: "09:00", remind_at: at(11, 8, 0) }, overdue, NOW).reminder).toBeTruthy();
  });
});
