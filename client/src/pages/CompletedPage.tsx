import { useCallback, useEffect, useState } from "react";
import { Box, Button, CircularProgress, Typography } from "@mui/material";
import TaskItem from "../components/TaskItem";
import TaskRows from "../components/TaskRows";
import PageTitle from "../components/PageTitle";
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
      <PageTitle sx={{ px: 0.5, mb: 2 }}>Completed</PageTitle>
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
        <TaskRows>
          {tasks.map((task) => (
            <TaskItem
              key={task.id}
              task={task}
              onToggle={onToggle}
              onOpen={() => {}}
              trailing={
                task.completed_at && (
                  <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
                    {formatRelativeTime(task.completed_at)}
                  </Typography>
                )
              }
            />
          ))}
        </TaskRows>
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
