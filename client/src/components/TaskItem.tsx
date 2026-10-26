import { memo } from "react";
import { Box, Checkbox, Chip, Tooltip, Typography, useTheme } from "@mui/material";
import { AlarmRoundedIcon, FlagRoundedIcon, NotesRoundedIcon, RepeatRoundedIcon } from "../icons";
import PendingChip from "./PendingChip";
import { useLists } from "../hooks/useLists";
import { useAreas } from "../hooks/useAreas";
import { buildCategoryColors } from "../theme/categoryColors";
import { describeRecurrence, formatDue, formatTime, hasUpcomingReminder, isOverdue } from "../utils/taskDates";
import type { Task } from "../types/models";

interface TaskItemProps {
  task: Task;
  onToggle: (task: Task) => void;
  onOpen: (task: Task) => void;
  /** Hide the due date — the view's heading already says it (a day group). */
  hideDate?: boolean;
  /** Hide the list badge — the view is that list. */
  hideList?: boolean;
}

/**
 * One task row: the checkbox is the completion, the rest of the row opens the
 * editor. The checkbox is a real `<input type="checkbox">`, which matters for
 * more than accessibility: `isUserBusy` treats a focused checkbox as not busy,
 * so ticking a task never holds the next refresh hostage.
 */
function TaskItem({ task, onToggle, onOpen, hideDate, hideList }: TaskItemProps) {
  const theme = useTheme();
  const colors = buildCategoryColors(theme.palette.mode === "dark");
  const { listById } = useLists();
  const { selected, areaById } = useAreas();
  const list = hideList ? undefined : listById(task.list_id);
  // Showing every area: say which one each task is in. With one area
  // selected it would be the same word on every row.
  const area = selected === "all" ? areaById(task.area_id) : undefined;
  const due = hideDate ? (task.due_time ? formatTime(task.due_time) : null) : formatDue(task);
  const overdue = isOverdue(task);
  const recurrence = describeRecurrence(task);
  const done = task.completed === 1;

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "flex-start",
        gap: 0.5,
        py: 0.75,
        pr: 1,
        borderBottom: 1,
        borderColor: "divider",
        "&:last-of-type": { borderBottom: 0 },
      }}
    >
      <Checkbox
        checked={done}
        onChange={() => onToggle(task)}
        slotProps={{ input: { "aria-label": `${done ? "Reopen" : "Complete"} ${task.title}` } }}
        sx={{
          mt: -0.25,
          color: task.priority !== "none" ? colors[task.priority].solid : undefined,
          "& .MuiSvgIcon-root": { fontSize: 24 },
        }}
      />
      <Box
        onClick={() => onOpen(task)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter") onOpen(task);
        }}
        sx={{ flex: 1, minWidth: 0, cursor: "pointer", pt: 0.75 }}
      >
        <Typography
          sx={{
            fontSize: 15,
            fontWeight: 500,
            lineHeight: 1.35,
            wordBreak: "break-word",
            textDecoration: done ? "line-through" : "none",
            color: done ? "text.secondary" : "text.primary",
          }}
        >
          {task.title}
        </Typography>
        <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1, mt: 0.25 }}>
          {due && (
            <Typography
              variant="caption"
              sx={{ fontWeight: 600, color: overdue ? "error.main" : "text.secondary" }}
            >
              {due}
            </Typography>
          )}
          {hasUpcomingReminder(task) && (
            <Tooltip title={`Reminder ${new Date(task.remind_at!).toLocaleString()}`}>
              <AlarmRoundedIcon sx={{ fontSize: 15, color: "text.secondary" }} aria-label="Has a reminder" />
            </Tooltip>
          )}
          {recurrence && (
            <Tooltip title={recurrence}>
              <RepeatRoundedIcon sx={{ fontSize: 15, color: "text.secondary" }} aria-label={recurrence} />
            </Tooltip>
          )}
          {task.notes && <NotesRoundedIcon sx={{ fontSize: 15, color: "text.secondary" }} aria-label="Has notes" />}
          {task.priority === "high" && (
            <FlagRoundedIcon sx={{ fontSize: 15, color: colors.high.solid }} aria-label="High priority" />
          )}
          {area && (
            <Box component="span" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }}>
              <Box component="span" sx={{ width: 7, height: 7, borderRadius: "50%", bgcolor: area.color }} />
              <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
                {area.name}
              </Typography>
            </Box>
          )}
          {list && (
            <Chip
              size="small"
              label={list.name}
              sx={{
                height: 20,
                fontSize: 11.5,
                fontWeight: 600,
                bgcolor: "transparent",
                border: 1,
                borderColor: list.color,
                color: "text.secondary",
              }}
            />
          )}
          {task.pending && <PendingChip compact />}
        </Box>
      </Box>
    </Box>
  );
}

export default memo(TaskItem);
