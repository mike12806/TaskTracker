import { useCallback } from "react";
import TaskListView, { type TaskGroup } from "../components/TaskListView";
import { addDaysStr, formatDayHeading, todayStr } from "../utils/taskDates";
import type { Task } from "../types/models";

/** Everything dated after today, a heading per day for the next two weeks. */
export default function UpcomingPage() {
  const today = todayStr();
  const horizon = addDaysStr(today, 14);
  const filter = useCallback((t: Task) => t.due_date !== null && t.due_date > today, [today]);
  const group = useCallback(
    (tasks: Task[]): TaskGroup[] => {
      const byDay = new Map<string, Task[]>();
      const later: Task[] = [];
      for (const t of tasks) {
        if (t.due_date! > horizon) later.push(t);
        else byDay.set(t.due_date!, [...(byDay.get(t.due_date!) ?? []), t]);
      }
      return [
        ...[...byDay.entries()].map(([date, ts]) => ({ key: date, heading: formatDayHeading(date), tasks: ts, hideDate: true })),
        { key: "later", heading: "Later", tasks: later },
      ];
    },
    [horizon],
  );

  return (
    <TaskListView
      title="Upcoming"
      filter={filter}
      group={group}
      defaults={{ due_date: addDaysStr(today, 1) }}
      empty="Nothing scheduled after today."
    />
  );
}
