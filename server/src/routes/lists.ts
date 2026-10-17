import { Hono } from "hono";
import type { AppEnv } from "../types/env.js";
import { insertOnce, readClientRequestId } from "./idempotency.js";
import { announceChange } from "../live.js";
import { areaBelongsToUser, defaultAreaId, ensureAreas } from "./areas.js";

const lists = new Hono<AppEnv>();

const MAX_NAME_LENGTH = 100;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * GET /api/lists — every list, with its open-task count, plus the Inbox count
 * (tasks with no list) so the nav drawer can badge everything in one request.
 * Each area has its own Inbox, so `inbox_counts` is keyed by area id;
 * `inbox_count` is their total.
 */
lists.get("/", async (c) => {
  const userId = c.get("userId");
  const includeArchived = c.req.query("archived") === "1";

  await ensureAreas(c.env.DB, userId);
  const [rows, inbox] = await Promise.all([
    c.env.DB.prepare(
      `SELECT l.*, (SELECT COUNT(*) FROM tasks t WHERE t.list_id = l.id AND t.completed = 0) AS open_count
         FROM lists l
        WHERE l.user_id = ? ${includeArchived ? "" : "AND l.archived = 0"}
        ORDER BY l.position, l.id`,
    )
      .bind(userId)
      .all(),
    c.env.DB.prepare(
      "SELECT area_id, COUNT(*) AS n FROM tasks WHERE user_id = ? AND list_id IS NULL AND completed = 0 GROUP BY area_id",
    )
      .bind(userId)
      .all<{ area_id: number; n: number }>(),
  ]);

  const inboxCounts: Record<string, number> = {};
  for (const row of inbox.results) inboxCounts[String(row.area_id)] = row.n;
  const total = inbox.results.reduce((sum, row) => sum + row.n, 0);

  return c.json({ lists: rows.results, inbox_count: total, inbox_counts: inboxCounts });
});

/** POST /api/lists — create, deduplicated on `client_request_id`. */
lists.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ error: "name is required" }, 400);
  if (name.length > MAX_NAME_LENGTH) return c.json({ error: "name is too long" }, 400);
  const color = body.color === undefined ? "#5b5dff" : body.color;
  if (typeof color !== "string" || !COLOR_RE.test(color)) return c.json({ error: "color must be #rrggbb" }, 400);

  let areaId: number;
  if (body.area_id === undefined) {
    areaId = await defaultAreaId(c.env.DB, userId);
  } else if (typeof body.area_id === "number" && (await areaBelongsToUser(c.env.DB, userId, body.area_id))) {
    areaId = body.area_id;
  } else {
    return c.json({ error: "Area not found" }, 404);
  }

  const { rowId } = await insertOnce({
    db: c.env.DB,
    userId,
    table: "lists",
    clientRequestId: readClientRequestId(body),
    // New lists go to the bottom of the drawer.
    insert: c.env.DB.prepare(
      `INSERT INTO lists (user_id, area_id, name, color, position)
       VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM lists WHERE user_id = ?))`,
    ).bind(userId, areaId, name, color, userId),
  });

  const created = await c.env.DB.prepare("SELECT *, 0 AS open_count FROM lists WHERE id = ? AND user_id = ?")
    .bind(rowId, userId)
    .first();
  if (!created) return c.json({ deleted: true });

  await announceChange(c, "lists");
  return c.json(created, 201);
});

lists.put("/:id", async (c) => {
  const userId = c.get("userId");
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "Not found" }, 404);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  const sets: string[] = [];
  const values: (string | number)[] = [];
  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > MAX_NAME_LENGTH) return c.json({ error: "Invalid name" }, 400);
    sets.push("name = ?");
    values.push(name);
  }
  if (body.color !== undefined) {
    if (typeof body.color !== "string" || !COLOR_RE.test(body.color)) return c.json({ error: "color must be #rrggbb" }, 400);
    sets.push("color = ?");
    values.push(body.color);
  }
  if (body.position !== undefined) {
    if (typeof body.position !== "number" || !Number.isInteger(body.position)) return c.json({ error: "Invalid position" }, 400);
    sets.push("position = ?");
    values.push(body.position);
  }
  if (body.archived !== undefined) {
    sets.push("archived = ?");
    values.push(body.archived ? 1 : 0);
  }
  let movesArea = false;
  if (body.area_id !== undefined) {
    if (typeof body.area_id !== "number" || !(await areaBelongsToUser(c.env.DB, userId, body.area_id))) {
      return c.json({ error: "Area not found" }, 404);
    }
    sets.push("area_id = ?");
    values.push(body.area_id);
    movesArea = true;
  }
  if (sets.length === 0) return c.json({ error: "No fields to update" }, 400);
  sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')");

  // Moving a list to another area moves its tasks with it, in the same
  // transaction: a task's area is its list's area, never anything else.
  const statements = [
    c.env.DB.prepare(`UPDATE lists SET ${sets.join(", ")} WHERE id = ? AND user_id = ? RETURNING *`).bind(
      ...values,
      id,
      userId,
    ),
  ];
  if (movesArea) {
    statements.push(
      c.env.DB.prepare("UPDATE tasks SET area_id = ? WHERE list_id = ? AND user_id = ?").bind(body.area_id, id, userId),
    );
  }
  const [result] = await c.env.DB.batch(statements);
  const updated = (result.results as unknown[])[0];
  if (!updated) return c.json({ error: "Not found" }, 404);

  await announceChange(c, "lists");
  if (movesArea) await announceChange(c, "tasks");
  return c.json(updated);
});

/**
 * DELETE /api/lists/:id — the list goes, its tasks move to the Inbox (the
 * foreign key is ON DELETE SET NULL) of the same area: they keep their
 * `area_id`. Losing a list's worth of tasks to one mis-tap would be the worse
 * mistake.
 */
lists.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "Not found" }, 404);

  const gone = await c.env.DB.prepare("DELETE FROM lists WHERE id = ? AND user_id = ? RETURNING id")
    .bind(id, userId)
    .first();
  if (!gone) return c.json({ error: "Not found" }, 404);

  await announceChange(c, "lists");
  await announceChange(c, "tasks");
  return c.json({ ok: true });
});

export { lists };
