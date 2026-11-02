import { useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  ListSubheader,
  Menu,
  MenuItem,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { CheckRoundedIcon, DeleteOutlineRoundedIcon, SnoozeRoundedIcon } from "../icons";
import { useTasks } from "../hooks/useTasks";
import { useLists } from "../hooks/useLists";
import { useAreas } from "../hooks/useAreas";
import { useSettings } from "../hooks/useSettings";
import { useSaveGuard } from "../hooks/useSaveGuard";
import { useNotification } from "../hooks/useNotification";
import { isPending } from "../api/outbox";
import { clearDraft, loadDraft, saveDraft } from "../utils/formDraft";
import { addDaysStr, defaultDueTime, formatTime, isoToLocalInput, todayStr } from "../utils/taskDates";
import { reminderUnchanged, scheduleProblems } from "../utils/scheduleValidation";
import { REMINDER_OFFSETS, isReminderOffset, offsetFor, remindAtForOffset, type ReminderOffset } from "../utils/reminderOffsets";
import type { Priority, Recurrence, Task, TaskInput } from "../types/models";

/** What a new task starts with, decided by the view it was added from. */
export type TaskDefaults = Partial<Pick<TaskInput, "list_id" | "area_id" | "due_date" | "priority">>;

/** An offset before the due time (`at_due`, `1h`, …), an exact instant, or none. */
type ReminderMode = "none" | "custom" | ReminderOffset;

interface FormState {
  title: string;
  notes: string;
  list_id: number | null;
  /** Meaningful when `list_id` is null: which area's Inbox. */
  area_id: number | null;
  priority: Priority;
  due_date: string;
  due_time: string;
  reminder: ReminderMode;
  /** `YYYY-MM-DDTHH:MM`, for `reminder === "custom"`. */
  remind_custom: string;
  recurrence: Recurrence;
  recurrence_interval: number;
}

const DRAFT_NAME = "new-task";

function formFromTask(task: Task, defaultTime: string): FormState {
  const offset =
    task.remind_at && task.due_date ? offsetFor(task.due_date, task.due_time || defaultTime, task.remind_at) : null;
  return {
    title: task.title,
    notes: task.notes ?? "",
    list_id: task.list_id,
    area_id: task.area_id,
    priority: task.priority,
    due_date: task.due_date ?? "",
    due_time: task.due_time ?? "",
    reminder: !task.remind_at ? "none" : (offset ?? "custom"),
    remind_custom: task.remind_at ? isoToLocalInput(task.remind_at) : "",
    recurrence: task.recurrence,
    recurrence_interval: task.recurrence_interval || 1,
  };
}

/**
 * A new task with a due date starts at the default time (09:00 unless changed
 * in Settings, or three hours from now once that has passed today) and
 * reminds at that time, so the common case is just a title and a day.
 */
function emptyForm(defaults: TaskDefaults, defaultTime: string): FormState {
  return {
    title: "",
    notes: "",
    list_id: defaults.list_id ?? null,
    area_id: defaults.area_id ?? null,
    priority: defaults.priority ?? "none",
    due_date: defaults.due_date ?? "",
    due_time: defaults.due_date ? defaultDueTime(defaults.due_date, defaultTime) : "",
    reminder: defaults.due_date ? "at_due" : "none",
    remind_custom: "",
    recurrence: "none",
    recurrence_interval: 1,
  };
}

/**
 * The instant a reminder should fire, from the form.
 *
 * A reminder relative to the due time, on a task with no due time (one from
 * before due times were filled in, or one whose time was cleared), counts
 * from the default time in settings.
 */
function remindAtFrom(form: FormState, defaultTime: string): string | null {
  if (form.reminder === "none") return null;
  if (form.reminder === "custom") return form.remind_custom ? new Date(form.remind_custom).toISOString() : null;
  if (!form.due_date) return null;
  return remindAtForOffset(form.due_date, form.due_time || defaultTime, form.reminder);
}

/**
 * Sets or clears the due date, keeping the time and reminder in step.
 *
 * Giving a task its first due date fills in the default time (`defaultDueTime`) and, unless a
 * reminder was already picked, a reminder at that time. Moving an existing
 * date leaves both alone, so an all-day task stays all-day. Clearing the date
 * drops a reminder that was relative to it — there's nothing left to count
 * from — but keeps an exact one.
 */
function withDueDate(form: FormState, date: string, defaultTime: string): FormState {
  if (!date) {
    return { ...form, due_date: "", due_time: "", reminder: isReminderOffset(form.reminder) ? "none" : form.reminder };
  }
  if (form.due_date) return { ...form, due_date: date };
  return {
    ...form,
    due_date: date,
    due_time: form.due_time || defaultDueTime(date, defaultTime),
    reminder: form.reminder === "none" ? "at_due" : form.reminder,
  };
}

function toInput(form: FormState, defaultTime: string): TaskInput {
  return {
    title: form.title.trim(),
    notes: form.notes.trim() || null,
    list_id: form.list_id,
    // With a list, the server takes the list's area; this only picks the Inbox.
    area_id: form.list_id === null ? (form.area_id ?? undefined) : undefined,
    priority: form.priority,
    due_date: form.due_date || null,
    due_time: form.due_date && form.due_time ? form.due_time : null,
    remind_at: remindAtFrom(form, defaultTime),
    recurrence: form.recurrence,
    recurrence_interval: form.recurrence_interval,
  };
}

/**
 * The form works in whole minutes; a reminder set by a snooze carries seconds.
 * Sending back the minute-rounded value for a reminder the user never touched
 * would move `remind_at` — and a moved `remind_at` is a new reminder, so one
 * that already fired would fire again on the next tick.
 */
function keepReminderIfUnchanged(task: Task, input: TaskInput): TaskInput {
  return reminderUnchanged(task, input) ? { ...input, remind_at: task.remind_at } : input;
}

const SNOOZE_OPTIONS = [
  { label: "10 minutes", minutes: 10 },
  { label: "1 hour", minutes: 60 },
  { label: "3 hours", minutes: 180 },
  { label: "Tomorrow", minutes: 24 * 60 },
];

interface TaskDialogProps {
  open: boolean;
  /** The task being edited, or null to create one. */
  task: Task | null;
  defaults?: TaskDefaults;
  onClose: () => void;
}

export default function TaskDialog({ open, task, defaults = {}, onClose }: TaskDialogProps) {
  const { create, update, complete, remove, snooze } = useTasks();
  const { lists } = useLists();
  const { areas, defaultAreaId } = useAreas();
  const { settings } = useSettings();
  const { notify } = useNotification();
  const { saving, save } = useSaveGuard();
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down("sm"));
  const defaultTime = settings?.default_reminder_time ?? "09:00";
  const [snoozeAnchor, setSnoozeAnchor] = useState<HTMLElement | null>(null);

  const defaultsKey = JSON.stringify(defaults);
  const [form, setForm] = useState<FormState>(() =>
    task ? formFromTask(task, defaultTime) : emptyForm(defaults, defaultTime),
  );

  // Reset whenever the dialog opens on something new. A new task restores a
  // draft if an interruption (an Access re-auth, iOS evicting the app) took
  // the last one away mid-sentence — see `formDraft.ts`.
  useEffect(() => {
    if (!open) return;
    if (task) setForm(formFromTask(task, defaultTime));
    else setForm(loadDraft<FormState>(DRAFT_NAME, null) ?? emptyForm({ area_id: defaultAreaId, ...defaults }, defaultTime));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, task?.id, task?.updated_at, defaultsKey]);

  useEffect(() => {
    if (open && !task && form.title) saveDraft(DRAFT_NAME, null, form);
  }, [open, task, form]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  const readOnly = task ? isPending(task) : false;
  const input = useMemo(() => toInput(form, defaultTime), [form, defaultTime]);
  // Recomputed every render rather than memoised: "past" moves with the clock,
  // and the dialog can sit open across the minute a time slips behind.
  const problems = readOnly ? {} : scheduleProblems(input, task);
  const valid =
    form.title.trim().length > 0 &&
    !(form.reminder === "custom" && !form.remind_custom) &&
    !problems.due &&
    !problems.reminder;

  const close = () => {
    setSnoozeAnchor(null);
    onClose();
  };

  const handleSave = async () => {
    // The Save button is already disabled for this, but a dialog left open
    // past the minute gets here with a time that has since slipped behind.
    const stale = scheduleProblems(input, task);
    if (stale.due || stale.reminder) {
      notify(stale.due ?? stale.reminder ?? "That time has already passed.", "error");
      return;
    }
    await save(input, async (key) => {
      try {
        if (task) await update(task.id, keepReminderIfUnchanged(task, input));
        else await create(input, key);
        if (!task) clearDraft(DRAFT_NAME, null);
        close();
      } catch (err) {
        notify(err instanceof Error ? err.message : "Couldn't save the task.", "error");
      }
    });
  };

  const handleDiscard = () => {
    if (!task) clearDraft(DRAFT_NAME, null);
    close();
  };

  return (
    <Dialog open={open} onClose={handleDiscard} fullWidth maxWidth="sm" fullScreen={fullScreen}>
      <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1, pb: 1 }}>
        <Box sx={{ flex: 1 }}>{task ? "Edit task" : "New task"}</Box>
        {task && !readOnly && !task.completed && (
          <>
            <Tooltip title="Snooze reminder">
              <IconButton onClick={(e) => setSnoozeAnchor(e.currentTarget)} aria-label="Snooze reminder">
                <SnoozeRoundedIcon />
              </IconButton>
            </Tooltip>
            <Menu anchorEl={snoozeAnchor} open={Boolean(snoozeAnchor)} onClose={() => setSnoozeAnchor(null)}>
              {SNOOZE_OPTIONS.map((opt) => (
                <MenuItem
                  key={opt.minutes}
                  onClick={() => {
                    void snooze(task, opt.minutes);
                    close();
                  }}
                >
                  {opt.label}
                </MenuItem>
              ))}
            </Menu>
            <Tooltip title="Complete">
              <IconButton
                onClick={() => {
                  void complete(task);
                  close();
                }}
                aria-label="Complete task"
              >
                <CheckRoundedIcon />
              </IconButton>
            </Tooltip>
          </>
        )}
        {task && (
          <Tooltip title="Delete">
            <IconButton
              onClick={() => {
                void remove(task);
                close();
              }}
              aria-label="Delete task"
            >
              <DeleteOutlineRoundedIcon />
            </IconButton>
          </Tooltip>
        )}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <TextField
            label="Title"
            value={form.title}
            onChange={(e) => set("title", e.target.value)}
            autoFocus={!task}
            fullWidth
            disabled={readOnly}
            onKeyDown={(e) => {
              if (e.key === "Enter" && valid && !saving) void handleSave();
            }}
          />
          <TextField
            label="Notes"
            value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
            multiline
            minRows={2}
            fullWidth
            disabled={readOnly}
          />
          <TextField
            select
            label="Where"
            // One picker for area and list: "a:<id>" is that area's Inbox,
            // "l:<id>" a list (whose area comes with it).
            value={form.list_id !== null ? `l:${form.list_id}` : `a:${form.area_id ?? defaultAreaId ?? ""}`}
            onChange={(e) => {
              const [kind, raw] = String(e.target.value).split(":");
              const id = Number(raw);
              if (kind === "l") {
                const list = lists.find((l) => l.id === id);
                setForm((f) => ({ ...f, list_id: id, area_id: list?.area_id ?? f.area_id }));
              } else {
                setForm((f) => ({ ...f, list_id: null, area_id: id }));
              }
            }}
            disabled={readOnly}
          >
            {areas.flatMap((area) => [
              <ListSubheader key={`h${area.id}`} sx={{ lineHeight: "32px", fontWeight: 700, color: area.color }}>
                {area.name}
              </ListSubheader>,
              <MenuItem key={`a${area.id}`} value={`a:${area.id}`}>
                {area.name} Inbox
              </MenuItem>,
              ...lists
                .filter((l) => l.area_id === area.id)
                .map((l) => (
                  <MenuItem key={`l${l.id}`} value={`l:${l.id}`} sx={{ pl: 4 }}>
                    {l.name}
                  </MenuItem>
                )),
            ])}
          </TextField>

          <Box>
            <ToggleButtonGroup
              exclusive
              size="small"
              fullWidth
              value={form.priority}
              onChange={(_, v: Priority | null) => v && set("priority", v)}
              aria-label="Priority"
              disabled={readOnly}
            >
              <ToggleButton value="none">None</ToggleButton>
              <ToggleButton value="low">Low</ToggleButton>
              <ToggleButton value="medium">Medium</ToggleButton>
              <ToggleButton value="high">High</ToggleButton>
            </ToggleButtonGroup>
          </Box>

          <Stack direction="row" spacing={1}>
            <TextField
              label="Due date"
              type="date"
              value={form.due_date}
              onChange={(e) => setForm((f) => withDueDate(f, e.target.value, defaultTime))}
              error={!!problems.due}
              helperText={problems.due}
              slotProps={{ inputLabel: { shrink: true } }}
              sx={{ flex: 1 }}
              disabled={readOnly}
            />
            <TextField
              label="Time"
              type="time"
              value={form.due_time}
              onChange={(e) => set("due_time", e.target.value)}
              slotProps={{ inputLabel: { shrink: true } }}
              sx={{ width: 140 }}
              disabled={readOnly || !form.due_date}
            />
          </Stack>
          <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", rowGap: 1 }}>
            {[
              { label: "Today", date: todayStr() },
              { label: "Tomorrow", date: addDaysStr(todayStr(), 1) },
              { label: "Next week", date: addDaysStr(todayStr(), 7) },
            ].map((opt) => (
              <Button
                key={opt.label}
                size="small"
                variant={form.due_date === opt.date ? "contained" : "outlined"}
                onClick={() => setForm((f) => withDueDate(f, opt.date, defaultTime))}
                disabled={readOnly}
              >
                {opt.label}
              </Button>
            ))}
            {form.due_date && (
              <Button size="small" onClick={() => setForm((f) => withDueDate(f, "", defaultTime))} disabled={readOnly}>
                Clear
              </Button>
            )}
          </Stack>

          <TextField
            select
            label="Reminder"
            value={form.reminder}
            onChange={(e) => {
              const mode = e.target.value as ReminderMode;
              setForm((f) => ({
                ...f,
                reminder: mode,
                // Start a custom reminder from whatever the offset gave.
                remind_custom:
                  mode === "custom" && !f.remind_custom
                    ? isoToLocalInput(
                        remindAtFrom(f.reminder === "none" ? { ...f, reminder: "at_due" } : f, defaultTime) ??
                          new Date(Date.now() + 3_600_000).toISOString(),
                      )
                    : f.remind_custom,
              }));
            }}
            error={!!problems.reminder}
            helperText={
              problems.reminder
                ? problems.reminder
                : isReminderOffset(form.reminder) && form.due_date && !form.due_time
                  ? `Counted from ${formatTime(defaultTime)} on the due date (change the default in Settings)`
                  : undefined
            }
            disabled={readOnly}
          >
            <MenuItem value="none">No reminder</MenuItem>
            {REMINDER_OFFSETS.map((o) => (
              <MenuItem key={o.key} value={o.key} disabled={!form.due_date}>
                {o.label}
              </MenuItem>
            ))}
            <MenuItem value="custom">Custom…</MenuItem>
          </TextField>
          {form.reminder === "custom" && (
            <TextField
              label="Remind at"
              type="datetime-local"
              value={form.remind_custom}
              onChange={(e) => set("remind_custom", e.target.value)}
              error={!!problems.reminder}
              slotProps={{ inputLabel: { shrink: true } }}
              disabled={readOnly}
            />
          )}

          <Stack direction="row" spacing={1}>
            <TextField
              select
              label="Repeat"
              value={form.recurrence}
              onChange={(e) => set("recurrence", e.target.value as Recurrence)}
              sx={{ flex: 1 }}
              disabled={readOnly}
            >
              <MenuItem value="none">Doesn't repeat</MenuItem>
              <MenuItem value="daily">Daily</MenuItem>
              <MenuItem value="weekdays">Every weekday</MenuItem>
              <MenuItem value="weekly">Weekly</MenuItem>
              <MenuItem value="monthly">Monthly</MenuItem>
              <MenuItem value="yearly">Yearly</MenuItem>
            </TextField>
            {form.recurrence !== "none" && form.recurrence !== "weekdays" && (
              <TextField
                label="Every"
                type="number"
                value={form.recurrence_interval}
                onChange={(e) => set("recurrence_interval", Math.min(365, Math.max(1, Number(e.target.value) || 1)))}
                slotProps={{ htmlInput: { min: 1, max: 365 } }}
                sx={{ width: 100 }}
                disabled={readOnly}
              />
            )}
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={handleDiscard}>Cancel</Button>
        <Button variant="contained" onClick={() => void handleSave()} disabled={!valid || saving || readOnly}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
