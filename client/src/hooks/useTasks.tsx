import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@mui/material";
import { completeTask, deleteTask, fetchOpenTasks, reopenTask, snoozeTask, updateTask } from "../api/tasks";
import { createEntry, discardPendingRow, isPending } from "../api/outbox";
import { useDataRefresh } from "./useDataRefresh";
import { usePendingRows } from "./useOutbox";
import { useNotification } from "./useNotification";
import { useLists } from "./useLists";
import { QUEUED_SAVE_MESSAGE, QUEUED_SAVE_SEVERITY } from "../utils/saveOutcome";
import { compareTasks } from "../utils/taskDates";
import type { Task, TaskInput } from "../types/models";

interface TasksContextValue {
  /** Every open task, saved and queued, in display order. */
  tasks: Task[];
  loaded: boolean;
  /** The last fetch failed and nothing has ever loaded. */
  failed: boolean;
  create: (input: Partial<TaskInput> & { title: string }, clientRequestId: string) => Promise<"saved" | "queued">;
  update: (id: number, changes: Partial<TaskInput>) => Promise<Task>;
  complete: (task: Task) => Promise<void>;
  remove: (task: Task) => Promise<void>;
  snooze: (task: Task, minutes: number) => Promise<void>;
}

const QUEUED_TASK_DEFAULTS: Partial<Task> = {
  list_id: null,
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
};

const TasksContext = createContext<TasksContextValue | null>(null);

/**
 * The open tasks, fetched once for every view.
 *
 * Today, Upcoming, Inbox and each list are filters over the same set, so they
 * share one fetch rather than each making their own; it refetches on
 * `refreshKey` (resume, live nudge, poll, save) like every read here, and is
 * never cached. Tasks queued on this device are merged in and sorted to where
 * their saved version will land.
 *
 * Completing is optimistic: the row leaves the list on the tap, with an Undo,
 * and comes back with an error if the server won't take it. It is the most
 * frequent tap in the app, and it is idempotent server-side, so the usual
 * argument against optimism — a duplicate on retry — does not apply.
 */
export function TasksProvider({ children }: { children: ReactNode }) {
  const { refreshKey, refreshData } = useDataRefresh();
  const { notify, notifyWithAction } = useNotification();
  const pending = usePendingRows<Task>("tasks");
  const { listById } = useLists();
  const [serverTasks, setServerTasks] = useState<Task[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  /**
   * Tasks completed or deleted on this device, by when they were hidden, until
   * a fetch that started after that lands. A fetch already in flight when the
   * box was ticked still has the task in it, and must not bring it back.
   */
  const [hidden, setHidden] = useState<Map<number, number>>(new Map());

  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();
    fetchOpenTasks()
      .then((rows) => {
        if (cancelled) return;
        setServerTasks(rows);
        setLoaded(true);
        setFailed(false);
        setHidden((prev) => new Map([...prev].filter(([, hiddenAt]) => hiddenAt >= startedAt)));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const tasks = useMemo(() => {
    // A queued body carries only the fields the form sent; fill in the rest
    // the way the server's column defaults would.
    // A queued task added to a list sent no area of its own — the server
    // takes the list's — so it gets the list's here too, or the area filter
    // would hide it.
    const queued = pending.map((row) => {
      const task = { ...QUEUED_TASK_DEFAULTS, ...row } as Task;
      if (task.area_id == null && task.list_id != null) {
        const areaId = listById(task.list_id)?.area_id;
        if (areaId) task.area_id = areaId;
      }
      return task;
    });
    return [...queued, ...serverTasks.filter((t) => !hidden.has(t.id))].sort(compareTasks);
  }, [pending, serverTasks, hidden, listById]);

  const hide = (id: number, on: boolean) =>
    setHidden((prev) => {
      const next = new Map(prev);
      if (on) next.set(id, Date.now());
      else next.delete(id);
      return next;
    });

  const create = useCallback<TasksContextValue["create"]>(
    async (input, clientRequestId) => {
      const outcome = await createEntry<Task>("tasks", { ...input, client_request_id: clientRequestId });
      if (outcome.status === "failed") throw outcome.error;
      if (outcome.status === "queued") {
        notify(QUEUED_SAVE_MESSAGE, QUEUED_SAVE_SEVERITY);
        return "queued";
      }
      refreshData();
      return "saved";
    },
    [notify, refreshData],
  );

  const update = useCallback<TasksContextValue["update"]>(
    async (id, changes) => {
      const saved = await updateTask(id, changes);
      refreshData();
      return saved;
    },
    [refreshData],
  );

  const complete = useCallback<TasksContextValue["complete"]>(
    async (task) => {
      if (isPending(task)) {
        notify("This task hasn't reached the server yet — complete it once it syncs.", "info");
        return;
      }
      hide(task.id, true);
      try {
        const { next } = await completeTask(task.id);
        notifyWithAction(
          next ? `Done — next one ${next.due_date ? `due ${next.due_date}` : "added"}.` : "Done.",
          (close) => (
            <Button
              color="inherit"
              size="small"
              onClick={() => {
                close();
                void reopenTask(task.id).then(refreshData, (err: unknown) =>
                  notify(err instanceof Error ? err.message : "Couldn't undo.", "error"),
                );
              }}
            >
              Undo
            </Button>
          ),
        );
        refreshData();
      } catch (err) {
        hide(task.id, false);
        notify(err instanceof Error ? err.message : "Couldn't complete that task.", "error");
      }
    },
    [notify, notifyWithAction, refreshData],
  );

  const remove = useCallback<TasksContextValue["remove"]>(
    async (task) => {
      // A queued task has nothing on the server to delete: dropping it from
      // the queue *is* the delete, and the only version that works offline.
      if (discardPendingRow(task.id)) return;
      hide(task.id, true);
      try {
        await deleteTask(task.id);
        refreshData();
      } catch (err) {
        hide(task.id, false);
        notify(err instanceof Error ? err.message : "Couldn't delete that task.", "error");
      }
    },
    [notify, refreshData],
  );

  const snooze = useCallback<TasksContextValue["snooze"]>(
    async (task, minutes) => {
      try {
        await snoozeTask(task.id, minutes);
        notify(`Snoozed for ${minutes >= 60 ? `${minutes / 60} h` : `${minutes} min`}.`, "success");
        refreshData();
      } catch (err) {
        notify(err instanceof Error ? err.message : "Couldn't snooze that task.", "error");
      }
    },
    [notify, refreshData],
  );

  return (
    <TasksContext.Provider value={{ tasks, loaded, failed, create, update, complete, remove, snooze }}>
      {children}
    </TasksContext.Provider>
  );
}

export function useTasks(): TasksContextValue {
  const value = useContext(TasksContext);
  if (!value) throw new Error("useTasks must be used inside TasksProvider");
  return value;
}
