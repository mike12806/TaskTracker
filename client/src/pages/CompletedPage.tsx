import { useCallback, useEffect, useState } from "react";
import { Box, Button, CircularProgress, Paper, Typography } from "@mui/material";
import TaskItem from "../components/TaskItem";
import { fetchCompletedTasks, reopenTask } from "../api/tasks";
import { useDataRefresh } from "../hooks/useDataRefresh";
import { useNotification } from "../hooks/useNotification";
import { useAreas } from "../hooks/useAreas";
import { formatRelativeTime } from "../utils/dateTime";
import type { Task } from "../types/models";

/**
 * Recently completed tasks, newest first. Unticking one reopens it. Paged by
 * completion time; the first page refetches on `refreshKey` like every read.
 */
export default function CompletedPage() {
  const { refreshKey, refreshData } = useDataRefresh();
  const { notify } = useNotification();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const { selected } = useAreas();
  const areaId = selected === "all" ? null : selected;

  useEffect(() => {
    let cancelled = false;
    fetchCompletedTasks(undefined, areaId)
      .then((rows) => {
        if (cancelled) return;
        setTasks(rows);
        setMore(rows.length === 50);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [refreshKey, areaId]);

  const loadMore = async () => {
    if (!tasks?.length) return;
    setLoadingMore(true);
    try {
      const rows = await fetchCompletedTasks(tasks[tasks.length - 1].completed_at ?? undefined, areaId);
      setTasks([...tasks, ...rows]);
      setMore(rows.length === 50);
    } catch (err) {
      notify(err instanceof Error ? err.message : "Couldn't load more.", "error");
    } finally {
      setLoadingMore(false);
    }
  };

  const onToggle = useCallback(
    (task: Task) => {
      setTasks((prev) => prev?.filter((t) => t.id !== task.id) ?? null);
      reopenTask(task.id).then(refreshData, (err: unknown) => {
        notify(err instanceof Error ? err.message : "Couldn't reopen that task.", "error");
        refreshData();
      });
    },
    [notify, refreshData],
  );

  return (
    <Box sx={{ maxWidth: 760, mx: "auto" }}>
      <Typography variant="h5" sx={{ fontWeight: 700, letterSpacing: "-0.02em", mb: 2 }}>
        Completed
      </Typography>
      {tasks === null && (
        <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
          <CircularProgress size={28} />
        </Box>
      )}
      {tasks?.length === 0 && (
        <Typography color="text.secondary" sx={{ textAlign: "center", py: 6 }}>
          Nothing completed yet.
        </Typography>
      )}
      {tasks && tasks.length > 0 && (
        <Paper variant="outlined" sx={{ px: 0.5 }}>
          {tasks.map((task) => (
            <Box key={task.id} sx={{ position: "relative" }}>
              <TaskItem task={task} onToggle={onToggle} onOpen={() => {}} />
              <Typography variant="caption" color="text.secondary" sx={{ position: "absolute", right: 12, top: 12 }}>
                {task.completed_at ? formatRelativeTime(task.completed_at) : ""}
              </Typography>
            </Box>
          ))}
        </Paper>
      )}
      {more && (
        <Box sx={{ textAlign: "center", mt: 2 }}>
          <Button onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        </Box>
      )}
    </Box>
  );
}
