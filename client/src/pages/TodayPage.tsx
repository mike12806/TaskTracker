import { useCallback } from "react";
import TaskListView, { type TaskGroup } from "../components/TaskListView";
import BriefingCard from "../components/BriefingCard";
import { todayStr } from "../utils/taskDates";
import type { Task } from "../types/models";

/** Overdue, then due today. The briefing sits on top. */
export default function TodayPage() {
  const today = todayStr();
  const filter = useCallback((t: Task) => t.due_date !== null && t.due_date <= today, [today]);
  const group = useCallback(
    (tasks: Task[]): TaskGroup[] => [
      { key: "overdue", heading: "Overdue", tasks: tasks.filter((t) => t.due_date! < today), tone: "error" },
      { key: "today", heading: "Today", tasks: tasks.filter((t) => t.due_date === today), hideDate: true },
    ],
    [today],
  );
  const subtitle = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

  return (
    <TaskListView
      title="Today"
      subtitle={subtitle}
      filter={filter}
      group={group}
      defaults={{ due_date: today }}
      empty="Nothing due today."
      header={<BriefingCard />}
    />
  );
}
