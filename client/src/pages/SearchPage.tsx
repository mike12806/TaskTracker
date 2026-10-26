import { useCallback, useEffect, useState } from "react";
import { Box, InputAdornment, Paper, TextField, ToggleButton, ToggleButtonGroup, Typography } from "@mui/material";
import { SearchRoundedIcon } from "../icons";
import TaskItem from "../components/TaskItem";
import TaskDialog from "../components/TaskDialog";
import { searchTasks } from "../api/tasks";
import { useTasks } from "../hooks/useTasks";
import { useDataRefresh } from "../hooks/useDataRefresh";
import { useAreas } from "../hooks/useAreas";
import type { Task } from "../types/models";

/**
 * Search. Open tasks are filtered on the device — they are already loaded —
 * so results appear as you type; completed ones ask the server, debounced.
 */
export default function SearchPage() {
  const { tasks, complete } = useTasks();
  const { refreshKey } = useDataRefresh();
  const { selected, inSelection } = useAreas();
  const areaId = selected === "all" ? null : selected;
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<"open" | "completed">("open");
  const [completed, setCompleted] = useState<Task[]>([]);
  const [editing, setEditing] = useState<Task | null>(null);
  const term = q.trim().toLowerCase();

  useEffect(() => {
    if (scope !== "completed" || !term) {
      setCompleted([]);
      return;
    }
    const timer = setTimeout(() => {
      searchTasks(term, "completed", areaId).then(setCompleted, () => {});
    }, 250);
    return () => clearTimeout(timer);
  }, [scope, term, refreshKey, areaId]);

  const results =
    scope === "open"
      ? term
        ? tasks.filter(
            (t) => inSelection(t.area_id) && (t.title.toLowerCase().includes(term) || (t.notes ?? "").toLowerCase().includes(term)),
          )
        : []
      : completed;

  const onToggle = useCallback((task: Task) => void complete(task), [complete]);

  return (
    <Box sx={{ maxWidth: 760, mx: "auto" }}>
      <Typography variant="h5" sx={{ fontWeight: 700, letterSpacing: "-0.02em", mb: 2 }}>
        Search
      </Typography>
      <TextField
        fullWidth
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search titles and notes"
        slotProps={{
          htmlInput: { "aria-label": "Search tasks", enterKeyHint: "search" },
          input: {
            startAdornment: (
              <InputAdornment position="start">
                <SearchRoundedIcon />
              </InputAdornment>
            ),
          },
        }}
        sx={{ mb: 1.5 }}
      />
      <ToggleButtonGroup exclusive size="small" value={scope} onChange={(_, v) => v && setScope(v)} sx={{ mb: 2 }}>
        <ToggleButton value="open">Open</ToggleButton>
        <ToggleButton value="completed">Completed</ToggleButton>
      </ToggleButtonGroup>
      {term && results.length === 0 && (
        <Typography color="text.secondary" sx={{ textAlign: "center", py: 4 }}>
          No matches.
        </Typography>
      )}
      {results.length > 0 && (
        <Paper variant="outlined" sx={{ px: 0.5 }}>
          {results.map((task) => (
            <TaskItem
              key={task.id}
              task={task}
              onToggle={scope === "open" ? onToggle : () => {}}
              onOpen={scope === "open" ? setEditing : () => {}}
            />
          ))}
        </Paper>
      )}
      <TaskDialog open={editing !== null} task={editing} onClose={() => setEditing(null)} />
    </Box>
  );
}
