import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { Box, CircularProgress, Paper, Typography } from "@mui/material";
import TaskItem from "./TaskItem";
import TaskDialog, { type TaskDefaults } from "./TaskDialog";
import QuickAdd from "./QuickAdd";
import { useTasks } from "../hooks/useTasks";
import { useAreas } from "../hooks/useAreas";
import type { Task } from "../types/models";

export interface TaskGroup {
  key: string;
  heading: string | null;
  tasks: Task[];
  /** Hide each row's date — the heading already says it. */
  hideDate?: boolean;
  tone?: "error";
}

interface TaskListViewProps {
  title: string;
  subtitle?: string;
  /** Narrow the open tasks to this view's. */
  filter: (task: Task) => boolean;
  /** Split the view's tasks into headed groups. Defaults to one group. */
  group?: (tasks: Task[]) => TaskGroup[];
  defaults?: TaskDefaults;
  hideList?: boolean;
  empty: string;
  header?: ReactNode;
}

/**
 * True inside the second view Layout shows beside the page when a foldable is
 * open (see `utils/fold.ts`). It is a glance at another view, not a second
 * page: no quick-add field to type into by mistake, no header (Today's is the
 * briefing, a request of its own), and `?task=` is left to the page so one
 * link never opens two editors.
 */
export const CompanionViewContext = createContext(false);

/**
 * Every task view — Today, Upcoming, Inbox, a list — is this component with a
 * different filter. The tasks come from `TasksProvider`, already fetched and
 * sorted, so switching views costs no request.
 *
 * `?task=<id>` opens that task's editor: it is where a reminder notification
 * and an alert in the bell both land.
 */
export default function TaskListView({ title, subtitle, filter, group, defaults, hideList, empty, header }: TaskListViewProps) {
  const { tasks, loaded, failed, complete } = useTasks();
  const { inSelection, selected, areaById } = useAreas();
  const [searchParams, setSearchParams] = useSearchParams();
  const [editing, setEditing] = useState<Task | null>(null);
  const companion = useContext(CompanionViewContext);

  // Every view is narrowed to the area selected in the app bar. Queued tasks
  // carry the area_id they were created with, so they filter the same way.
  const visible = useMemo(() => tasks.filter((t) => inSelection(t.area_id) && filter(t)), [tasks, filter, inSelection]);
  const groups = useMemo(
    () => (group ? group(visible) : [{ key: "all", heading: null, tasks: visible }]).filter((g) => g.tasks.length > 0),
    [group, visible],
  );

  // Deep link from a notification or the bell.
  const linked = searchParams.get("task");
  useEffect(() => {
    if (companion || !linked || !loaded) return;
    const task = tasks.find((t) => t.id === Number(linked));
    if (task) setEditing(task);
    setSearchParams(
      (params) => {
        params.delete("task");
        return params;
      },
      { replace: true },
    );
  }, [companion, linked, loaded, tasks, setSearchParams]);

  // Keep an open editor pointed at the freshest copy of its task.
  const editingCurrent = editing ? (tasks.find((t) => t.id === editing.id) ?? editing) : null;

  const onOpen = useCallback((task: Task) => setEditing(task), []);
  const onToggle = useCallback((task: Task) => void complete(task), [complete]);

  return (
    <Box sx={{ maxWidth: 760, mx: "auto" }}>
      <Box sx={{ mb: 2 }}>
        <Typography variant="h5" sx={{ fontWeight: 700, letterSpacing: "-0.02em" }}>
          {title}
        </Typography>
        {selected !== "all" && (
          <Typography variant="body2" sx={{ color: areaById(selected)?.color, fontWeight: 600 }}>
            {areaById(selected)?.name}
          </Typography>
        )}
        {subtitle && (
          <Typography variant="body2" color="text.secondary">
            {subtitle}
          </Typography>
        )}
      </Box>
      {!companion && header}
      {!companion && <QuickAdd defaults={defaults} />}

      {!loaded && !failed && (
        <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
          <CircularProgress size={28} />
        </Box>
      )}
      {!loaded && failed && (
        <Typography color="text.secondary" sx={{ textAlign: "center", py: 6 }}>
          Couldn't load tasks. Retrying when the server is reachable.
        </Typography>
      )}
      {loaded && groups.length === 0 && (
        <Typography color="text.secondary" sx={{ textAlign: "center", py: 6 }}>
          {empty}
        </Typography>
      )}

      {groups.map((g) => (
        <Box key={g.key} sx={{ mb: 2.5 }}>
          {g.heading && (
            <Typography
              variant="overline"
              sx={{ display: "block", fontWeight: 700, color: g.tone === "error" ? "error.main" : "text.secondary", mb: 0.5 }}
            >
              {g.heading} · {g.tasks.length}
            </Typography>
          )}
          <Paper variant="outlined" sx={{ px: 0.5 }}>
            {g.tasks.map((task) => (
              <TaskItem key={task.id} task={task} onToggle={onToggle} onOpen={onOpen} hideDate={g.hideDate} hideList={hideList} />
            ))}
          </Paper>
        </Box>
      ))}

      <TaskDialog open={editing !== null} task={editingCurrent} onClose={() => setEditing(null)} />
    </Box>
  );
}
