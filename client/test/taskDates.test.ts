import { describe, it, expect } from "vitest";
import { compareTasks, describeRecurrence, formatDueDate, hasUpcomingReminder, isOverdue } from "../src/utils/taskDates";
import type { Task } from "../src/types/models";

const NOW = new Date(2026, 9, 16, 10, 0); // Fri 16 Oct 2026, 10:00 local

function task(overrides: Partial<Task>): Task {
  return {
    id: 1,
    list_id: null,
    title: "t",
    notes: null,
    priority: "none",
    due_date: null,
    due_time: null,
    remind_at: null,
    reminded_at: null,
    recurrence: "none",
    recurrence_interval: 1,
    completed: 0,
    completed_at: null,
    recurred_from_id: null,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

describe("taskDates", () => {
  it("names nearby days", () => {
    expect(formatDueDate("2026-10-16", NOW)).toBe("Today");
    expect(formatDueDate("2026-10-17", NOW)).toBe("Tomorrow");
    expect(formatDueDate("2026-10-15", NOW)).toBe("Yesterday");
  });

  it("treats a task as overdue from its due time, or from the next day", () => {
    expect(isOverdue(task({ due_date: "2026-10-15" }), NOW)).toBe(true);
    expect(isOverdue(task({ due_date: "2026-10-16" }), NOW)).toBe(false);
    expect(isOverdue(task({ due_date: "2026-10-16", due_time: "09:00" }), NOW)).toBe(true);
    expect(isOverdue(task({ due_date: "2026-10-16", due_time: "11:00" }), NOW)).toBe(false);
    expect(isOverdue(task({ due_date: "2026-10-15", completed: 1 }), NOW)).toBe(false);
  });

  it("only shows a reminder that has not fired yet", () => {
    const later = new Date(NOW.getTime() + 3_600_000).toISOString();
    expect(hasUpcomingReminder(task({ remind_at: later }), NOW)).toBe(true);
    expect(hasUpcomingReminder(task({ remind_at: later, reminded_at: later }), NOW)).toBe(false);
    expect(hasUpcomingReminder(task({ remind_at: "2026-10-01T00:00:00Z" }), NOW)).toBe(false);
  });

  it("describes recurrence", () => {
    expect(describeRecurrence(task({ recurrence: "weekly" }))).toBe("Every week");
    expect(describeRecurrence(task({ recurrence: "monthly", recurrence_interval: 3 }))).toBe("Every 3 months");
    expect(describeRecurrence(task({ recurrence: "weekdays", recurrence_interval: 4 }))).toBe("Every weekday");
    expect(describeRecurrence(task({}))).toBeNull();
  });

  it("sorts like the server: dated, timed, priority, newest", () => {
    const rows = [
      task({ id: 1, title: "undated" }),
      task({ id: 2, title: "low", due_date: "2026-10-16", priority: "low" }),
      task({ id: 3, title: "timed", due_date: "2026-10-16", due_time: "08:00" }),
      task({ id: 4, title: "high", due_date: "2026-10-16", priority: "high" }),
      task({ id: 5, title: "earlier", due_date: "2026-10-15" }),
    ];
    expect(rows.sort(compareTasks).map((t) => t.title)).toEqual(["earlier", "timed", "high", "low", "undated"]);
  });
});
