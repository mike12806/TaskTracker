import { Hono } from "hono";
import type { AppEnv, Env } from "../types/env.js";
import { insertOnce, readClientRequestId } from "./idempotency.js";
import { announceChange } from "../live.js";
import { emit } from "../events/bus.js";
import { taskEvent, type DomainEventType } from "../events/types.js";
import { backgroundWrites } from "../kv/cache.js";
import { readTimezone } from "./settings.js";
import { areaBelongsToUser, defaultAreaId } from "./areas.js";
import {
  daysBetween,
  localDateStr,
  nextOccurrence,
  RECURRENCES,
  shiftInstantByDays,
  toIsoSeconds,
  type Recurrence,
} from "../time.js";

const tasks = new Hono<AppEnv>();

export const PRIORITIES = ["none", "low", "medium", "high"] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface TaskRow {
  id: number;
  user_id: number;
  list_id: number | null;
  /** Always set: the list's area, or which area's Inbox the task is in. */
  area_id: number;
  title: string;
  notes: string | null;
  priority: Priority;
  due_date: string | null;
  due_time: string | null;
  remind_at: string | null;
  reminded_at: string | null;
  recurrence: Recurrence;
  recurrence_interval: number;
  completed: number;
  completed_at: string | null;
  recurred_from_id: number | null;
  created_at: string;
  updated_at: string;
}

const MAX_TITLE_LENGTH = 500;
const MAX_NOTES_LENGTH = 10_000;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Longest a snooze may be: a week. Anything longer is rescheduling. */
const MAX_SNOOZE_MINUTES = 7 * 24 * 60;

/** Open tasks returned in one go. A personal list is nowhere near this. */
const MAX_OPEN_TASKS = 2000;

/** The editable columns, in the order the INSERT binds them. */
const COLUMNS = [
  "list_id",
  "area_id",
  "title",
  "notes",
  "priority",
  "due_date",
  "due_time",
  "remind_at",
  "recurrence",
  "recurrence_interval",
] as const;
type Column = (typeof COLUMNS)[number];
type TaskInput = Partial<Record<Column, string | number | null>>;

class InputError extends Error {}

function readNullableString(value: unknown, field: string): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new InputError(`${field} must be a string`);
  return value;
}

/**
 * Validate and normalise a task body.
 *
 * `partial` is for edits: a field that is absent stays absent, and is left
 * alone by the UPDATE. `null` is a real value — "clear the due date" — and is
 * kept distinct from absent throughout.
 */
function readTaskInput(body: Record<string, unknown>, partial: boolean): TaskInput {
  const input: TaskInput = {};

  if (body.title !== undefined || !partial) {
    if (typeof body.title !== "string" || body.title.trim() === "") {
      throw new InputError("title is required");
    }
    const title = body.title.trim();
    if (title.length > MAX_TITLE_LENGTH) throw new InputError("title is too long");
    input.title = title;
  }

  if (body.notes !== undefined) {
    const notes = readNullableString(body.notes, "notes");
    if (notes !== null && notes.length > MAX_NOTES_LENGTH) throw new InputError("notes are too long");
    input.notes = notes;
  }

  if (body.priority !== undefined) {
    if (!PRIORITIES.includes(body.priority as Priority)) throw new InputError("Invalid priority");
    input.priority = body.priority as Priority;
  }

  if (body.list_id !== undefined) {
    if (body.list_id !== null && (typeof body.list_id !== "number" || !Number.isInteger(body.list_id))) {
      throw new InputError("list_id must be an integer or null");
    }
    input.list_id = body.list_id as number | null;
  }

  if (body.area_id !== undefined) {
    if (typeof body.area_id !== "number" || !Number.isInteger(body.area_id)) {
      throw new InputError("area_id must be an integer");
    }
    input.area_id = body.area_id;
  }

  if (body.due_date !== undefined) {
    const due = readNullableString(body.due_date, "due_date");
    if (due !== null && !DATE_RE.test(due)) throw new InputError("due_date must be YYYY-MM-DD");
    input.due_date = due;
  }

  if (body.due_time !== undefined) {
    const time = readNullableString(body.due_time, "due_time");
    if (time !== null && !TIME_RE.test(time)) throw new InputError("due_time must be HH:MM");
    input.due_time = time;
  }

  if (body.remind_at !== undefined) {
    const remind = readNullableString(body.remind_at, "remind_at");
    if (remind !== null) {
      const parsed = Date.parse(remind);
      if (Number.isNaN(parsed)) throw new InputError("remind_at must be an ISO 8601 timestamp");
      // Stored at second precision, so the cron's string comparison against
      // `toIsoSeconds(now)` sorts correctly — see `scheduled/reminders.ts`.
      input.remind_at = toIsoSeconds(new Date(parsed));
    } else {
      input.remind_at = null;
    }
  }

  if (body.recurrence !== undefined) {
    if (!RECURRENCES.includes(body.recurrence as Recurrence)) throw new InputError("Invalid recurrence");
    input.recurrence = body.recurrence as Recurrence;
  }

  if (body.recurrence_interval !== undefined) {
    const n = body.recurrence_interval;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 365) {
      throw new InputError("recurrence_interval must be an integer from 1 to 365");
    }
    input.recurrence_interval = n;
  }

  // A time without a date means nothing. Only checkable when both are in the
  // body; an edit that clears the date leaves the time to `normaliseRow`.
  if (input.due_time && input.due_date === null) {
    throw new InputError("due_time needs a due_date");
  }

  return input;
}

/**
 * Where a task lives: its list and its area, kept consistent.
 *
 * A task in a list is in that list's area — always, so the area can never
 * disagree with the list. A task with no list is in an area's Inbox, chosen
 * by `area_id` (or, failing that, where it already was, or the first area).
 *
 * Asking for a different area without naming a list moves the task to that
 * area's Inbox: "this is a work thing" shouldn't require knowing which work
 * list. Naming a list *and* an area that disagree is a 400, because one of
 * them is a mistake and the server can't tell which.
 */
async function placeTask(
  db: D1Database,
  userId: number,
  input: TaskInput,
  existing: Pick<TaskRow, "list_id" | "area_id"> | null,
): Promise<{ list_id: number | null; area_id: number } | { error: string; status: 400 | 404 }> {
  const askedArea = input.area_id as number | undefined;
  let listId = input.list_id !== undefined ? (input.list_id as number | null) : (existing?.list_id ?? null);

  if (listId !== null) {
    const list = await db
      .prepare("SELECT area_id FROM lists WHERE id = ? AND user_id = ?")
      .bind(listId, userId)
      .first<{ area_id: number | null }>();
    if (!list) return { error: "List not found", status: 404 };
    const listArea = list.area_id ?? (await defaultAreaId(db, userId));
    if (askedArea === undefined || askedArea === listArea) return { list_id: listId, area_id: listArea };
    if (input.list_id !== undefined) return { error: "That list is in a different area", status: 400 };
    listId = null;
  }

  if (askedArea !== undefined && !(await areaBelongsToUser(db, userId, askedArea))) {
    return { error: "Area not found", status: 404 };
  }
  return { list_id: null, area_id: askedArea ?? existing?.area_id ?? (await defaultAreaId(db, userId)) };
}

async function fetchTask(db: D1Database, userId: number, id: number): Promise<TaskRow | null> {
  return db
    .prepare("SELECT * FROM tasks WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first<TaskRow>();
}

/** Say what happened, once, and nudge the user's other devices. */
async function announce(
  c: Parameters<typeof announceChange>[0] & { env: Env },
  type: DomainEventType,
  taskId: number,
  waitUntil: ReturnType<typeof backgroundWrites>,
): Promise<void> {
  await emit(c.env, taskEvent(type, { userId: c.get("userId"), taskId }), waitUntil);
  await announceChange(c, "tasks");
}

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** LIKE pattern for a search term, with the wildcards in it escaped. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * GET /api/tasks
 *
 * `status=open` (default) returns every open task, because every view the app
 * has — Today, Upcoming, Inbox, a list — is a filter over that set, and a
 * personal task list is small enough that filtering on the device is cheaper
 * than one request per view. Sorted the way every view wants them: dated
 * before undated, then by date and time, then priority, then newest.
 *
 * `status=completed` pages backwards through completed tasks by completion
 * time, `before` being the `completed_at` of the last row the client has.
 *
 * `q` searches title and notes across both.
 */
tasks.get("/", async (c) => {
  const userId = c.get("userId");
  const status = c.req.query("status") ?? "open";
  const listParam = c.req.query("list_id");
  const areaParam = c.req.query("area_id");
  const q = c.req.query("q")?.trim();

  const where = ["user_id = ?"];
  const binds: unknown[] = [userId];

  if (areaParam !== undefined) {
    const areaId = parseId(areaParam);
    if (areaId === null) return c.json({ error: "Invalid area_id" }, 400);
    where.push("area_id = ?");
    binds.push(areaId);
  }

  if (listParam !== undefined) {
    if (listParam === "inbox") {
      where.push("list_id IS NULL");
    } else {
      const listId = parseId(listParam);
      if (listId === null) return c.json({ error: "Invalid list_id" }, 400);
      where.push("list_id = ?");
      binds.push(listId);
    }
  }

  if (q) {
    where.push("(title LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')");
    binds.push(likePattern(q), likePattern(q));
  }

  if (status === "completed") {
    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10) || 50, 200);
    const before = c.req.query("before");
    where.push("completed = 1");
    if (before) {
      where.push("completed_at < ?");
      binds.push(before);
    }
    const { results } = await c.env.DB.prepare(
      `SELECT * FROM tasks WHERE ${where.join(" AND ")}
        ORDER BY completed_at DESC, id DESC LIMIT ?`,
    )
      .bind(...binds, limit)
      .all<TaskRow>();
    return c.json(results);
  }

  if (status !== "open") return c.json({ error: "status must be open or completed" }, 400);

  where.push("completed = 0");
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM tasks WHERE ${where.join(" AND ")}
      ORDER BY due_date IS NULL, due_date, due_time IS NULL, due_time,
               CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
               created_at DESC
      LIMIT ?`,
  )
    .bind(...binds, MAX_OPEN_TASKS)
    .all<TaskRow>();
  return c.json(results);
});

tasks.get("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  const row = id === null ? null : await fetchTask(c.env.DB, c.get("userId"), id);
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(row);
});

/**
 * POST /api/tasks — create, deduplicated on `client_request_id`.
 *
 * The offline outbox replays creates with the key they were given when Save
 * was pressed, so a replay against a server that already applied it is
 * answered with the original task rather than adding it twice.
 */
tasks.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "Invalid JSON body" }, 400);

  let input: TaskInput;
  try {
    input = readTaskInput(body, false);
  } catch (error) {
    if (error instanceof InputError) return c.json({ error: error.message }, 400);
    throw error;
  }

  const placed = await placeTask(c.env.DB, userId, input, null);
  if ("error" in placed) return c.json({ error: placed.error }, placed.status);
  input.list_id = placed.list_id;
  input.area_id = placed.area_id;

  const cols = COLUMNS.filter((col) => input[col] !== undefined);
  const { rowId } = await insertOnce({
    db: c.env.DB,
    userId,
    table: "tasks",
    clientRequestId: readClientRequestId(body),
    insert: c.env.DB.prepare(
      `INSERT INTO tasks (user_id, ${cols.join(", ")}) VALUES (?, ${cols.map(() => "?").join(", ")})`,
    ).bind(userId, ...cols.map((col) => input[col])),
  });

  const created = await fetchTask(c.env.DB, userId, rowId);
  // The key was claimed by a create whose task has since been deleted. The
  // create did happen; resurrecting it would undo a deliberate delete.
  if (!created) return c.json({ deleted: true });

  await announce(c, "task.created", rowId, backgroundWrites(c));
  return c.json(created, 201);
});

/** PUT /api/tasks/:id — edit. Absent fields are left alone; `null` clears. */
tasks.put("/:id", async (c) => {
  const userId = c.get("userId");
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "Invalid JSON body" }, 400);

  let input: TaskInput;
  try {
    input = readTaskInput(body, true);
  } catch (error) {
    if (error instanceof InputError) return c.json({ error: error.message }, 400);
    throw error;
  }

  if (input.list_id !== undefined || input.area_id !== undefined) {
    const existing = await fetchTask(c.env.DB, userId, id);
    if (!existing) return c.json({ error: "Not found" }, 404);
    const placed = await placeTask(c.env.DB, userId, input, existing);
    if ("error" in placed) return c.json({ error: placed.error }, placed.status);
    input.list_id = placed.list_id;
    input.area_id = placed.area_id;
  }

  const cols = COLUMNS.filter((col) => input[col] !== undefined);
  if (cols.length === 0) return c.json({ error: "No fields to update" }, 400);

  // Clearing the date clears the time with it, in the same statement.
  const clearsTime = input.due_date === null && input.due_time === undefined;
  const sets = [
    ...cols.map((col) => `${col} = ?`),
    ...(clearsTime ? ["due_time = NULL"] : []),
    "updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')",
  ];

  const updated = await c.env.DB.prepare(
    `UPDATE tasks SET ${sets.join(", ")} WHERE id = ? AND user_id = ? RETURNING *`,
  )
    .bind(...cols.map((col) => input[col]), id, userId)
    .first<TaskRow>();
  if (!updated) return c.json({ error: "Not found" }, 404);

  await announce(c, "task.updated", id, backgroundWrites(c));
  return c.json(updated);
});

tasks.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "Not found" }, 404);

  const gone = await c.env.DB.prepare("DELETE FROM tasks WHERE id = ? AND user_id = ? RETURNING id")
    .bind(id, userId)
    .first();
  if (!gone) return c.json({ error: "Not found" }, 404);

  await announce(c, "task.deleted", id, backgroundWrites(c));
  return c.json({ ok: true });
});

/**
 * The occurrence that follows `task`, or null if it does not recur.
 *
 * Steps forward from the due date (or from today, for an undated recurring
 * task) until it lands after today, so finishing a daily task that is three
 * days overdue schedules tomorrow rather than three more overdue copies. The
 * reminder moves by the same number of calendar days and keeps its wall-clock
 * time in the user's timezone, so a 9:00 reminder is still 9:00 after a DST
 * change.
 */
export function nextOccurrenceOf(
  task: Pick<TaskRow, "due_date" | "remind_at" | "recurrence" | "recurrence_interval">,
  tz: string,
  now = new Date(),
): { due_date: string; remind_at: string | null } | null {
  if (task.recurrence === "none") return null;

  const today = localDateStr(now, tz);
  const anchor =
    task.due_date ?? (task.remind_at ? localDateStr(new Date(task.remind_at), tz) : today);

  let next = nextOccurrence(anchor, task.recurrence, task.recurrence_interval);
  for (let guard = 0; next <= today && guard < 5000; guard++) {
    next = nextOccurrence(next, task.recurrence, task.recurrence_interval);
  }

  const remind = task.remind_at
    ? toIsoSeconds(shiftInstantByDays(new Date(task.remind_at), daysBetween(anchor, next), tz))
    : null;

  return { due_date: next, remind_at: remind };
}

/**
 * POST /api/tasks/:id/complete
 *
 * Idempotent, which matters more here than anywhere: this is the tap that
 * gets doubled, retried, and fired from a notification action. Completing a
 * completed task changes nothing, and the next occurrence of a recurring task
 * is spawned behind a unique index on `recurred_from_id`, so however many
 * times this runs for one occurrence there is exactly one next one.
 *
 * Both writes are one `D1.batch()` — a transaction — so a recurring task can
 * never be completed without its successor, or the reverse.
 */
tasks.post("/:id/complete", async (c) => {
  const userId = c.get("userId");
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "Not found" }, 404);

  const task = await fetchTask(c.env.DB, userId, id);
  if (!task) return c.json({ error: "Not found" }, 404);

  const now = new Date();
  const tz = await readTimezone(c.env.DB, userId);
  const next = nextOccurrenceOf(task, tz, now);

  const statements = [
    c.env.DB.prepare(
      `UPDATE tasks SET completed = 1, completed_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE id = ? AND user_id = ? AND completed = 0`,
    ).bind(toIsoSeconds(now), id, userId),
  ];
  if (next) {
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO tasks (user_id, list_id, area_id, title, notes, priority, due_date, due_time, remind_at,
                            recurrence, recurrence_interval, recurred_from_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      ).bind(
        userId,
        task.list_id,
        task.area_id,
        task.title,
        task.notes,
        task.priority,
        next.due_date,
        task.due_time,
        next.remind_at,
        task.recurrence,
        task.recurrence_interval,
        id,
      ),
    );
  }
  await c.env.DB.batch(statements);

  const [completed, successor] = await Promise.all([
    fetchTask(c.env.DB, userId, id),
    next
      ? c.env.DB.prepare("SELECT * FROM tasks WHERE recurred_from_id = ? AND user_id = ?")
          .bind(id, userId)
          .first<TaskRow>()
      : Promise.resolve(null),
  ]);

  const waitUntil = backgroundWrites(c);
  await emit(c.env, taskEvent("task.completed", { userId, taskId: id }), waitUntil);
  if (successor) await emit(c.env, taskEvent("task.created", { userId, taskId: successor.id }), waitUntil);
  await announceChange(c, "tasks");

  return c.json({ task: completed, next: successor ?? null });
});

/**
 * POST /api/tasks/:id/reopen — undo a completion.
 *
 * Does not remove a successor a recurring task already spawned: that task may
 * have been edited since, and silently deleting it is the worse surprise. The
 * unique index means completing this one again will not spawn a second.
 */
tasks.post("/:id/reopen", async (c) => {
  const userId = c.get("userId");
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "Not found" }, 404);

  const reopened = await c.env.DB.prepare(
    `UPDATE tasks SET completed = 0, completed_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ? AND user_id = ? RETURNING *`,
  )
    .bind(id, userId)
    .first<TaskRow>();
  if (!reopened) return c.json({ error: "Not found" }, 404);

  await announce(c, "task.reopened", id, backgroundWrites(c));
  return c.json(reopened);
});

/**
 * POST /api/tasks/:id/snooze — `{ minutes }` (default 10) or `{ until }`.
 *
 * Moves `remind_at`, which re-arms the reminder: the cron fires once per
 * remind_at value, so a new value is a new reminder. The alert for the old
 * one is resolved by the event bus. Called from the notification's Snooze
 * action as well as the app, hence a default that needs no body at all.
 */
tasks.post("/:id/snooze", async (c) => {
  const userId = c.get("userId");
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json<{ minutes?: unknown; until?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const now = Date.now();

  let remindAt: number;
  if (typeof body.until === "string") {
    remindAt = Date.parse(body.until);
    if (Number.isNaN(remindAt) || remindAt <= now) {
      return c.json({ error: "until must be a future ISO 8601 timestamp" }, 400);
    }
  } else {
    const minutes = body.minutes === undefined ? 10 : body.minutes;
    if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 1 || minutes > MAX_SNOOZE_MINUTES) {
      return c.json({ error: `minutes must be between 1 and ${MAX_SNOOZE_MINUTES}` }, 400);
    }
    remindAt = now + Math.round(minutes) * 60_000;
  }
  if (remindAt - now > MAX_SNOOZE_MINUTES * 60_000) {
    return c.json({ error: "Snooze is limited to a week" }, 400);
  }

  const snoozed = await c.env.DB.prepare(
    `UPDATE tasks SET remind_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ? AND user_id = ? AND completed = 0 RETURNING *`,
  )
    .bind(toIsoSeconds(new Date(remindAt)), id, userId)
    .first<TaskRow>();
  if (!snoozed) return c.json({ error: "Not found" }, 404);

  await announce(c, "task.snoozed", id, backgroundWrites(c));
  return c.json(snoozed);
});

export { tasks };
