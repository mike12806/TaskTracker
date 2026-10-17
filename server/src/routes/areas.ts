import { Hono } from "hono";
import type { AppEnv } from "../types/env.js";
import { insertOnce, readClientRequestId } from "./idempotency.js";
import { announceChange } from "../live.js";

const areas = new Hono<AppEnv>();

export interface AreaRow {
  id: number;
  user_id: number;
  name: string;
  color: string;
  position: number;
  created_at: string;
  updated_at: string;
}

const MAX_NAME_LENGTH = 50;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** What every user starts with. Migration 0002 seeds the same two. */
const DEFAULT_AREAS = [
  { name: "Personal", color: "#30a46c" },
  { name: "Work", color: "#0090ff" },
];

/**
 * The user's areas, creating the defaults on first sight.
 *
 * Migration 0002 seeds areas for the users that existed when it ran; anyone
 * created after it gets theirs here, from whichever request first needs one.
 * The insert is guarded by the count it just read, so two first requests
 * racing can at worst seed twice — visible, harmless, and renameable — rather
 * than leave a user with no area for their tasks to live in.
 */
export async function ensureAreas(db: D1Database, userId: number): Promise<AreaRow[]> {
  const read = () =>
    db.prepare("SELECT * FROM areas WHERE user_id = ? ORDER BY position, id").bind(userId).all<AreaRow>();
  const existing = await read();
  if (existing.results.length > 0) return existing.results;

  await db.batch(
    DEFAULT_AREAS.map((a, i) =>
      db
        .prepare("INSERT INTO areas (user_id, name, color, position) VALUES (?, ?, ?, ?)")
        .bind(userId, a.name, a.color, i),
    ),
  );
  return (await read()).results;
}

/** The area a task or list lands in when nothing says otherwise: the first one. */
export async function defaultAreaId(db: D1Database, userId: number): Promise<number> {
  return (await ensureAreas(db, userId))[0].id;
}

export async function areaBelongsToUser(db: D1Database, userId: number, areaId: number): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS ok FROM areas WHERE id = ? AND user_id = ?").bind(areaId, userId).first();
  return row !== null;
}

function parseId(raw: string | undefined): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** GET /api/areas — the user's areas, in order. */
areas.get("/", async (c) => {
  return c.json(await ensureAreas(c.env.DB, c.get("userId")));
});

/** POST /api/areas — create, deduplicated on `client_request_id`. */
areas.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > MAX_NAME_LENGTH) return c.json({ error: "name is required (up to 50 characters)" }, 400);
  const color = body.color ?? "#5b5dff";
  if (typeof color !== "string" || !COLOR_RE.test(color)) return c.json({ error: "color must be #rrggbb" }, 400);

  await ensureAreas(c.env.DB, userId);
  const { rowId } = await insertOnce({
    db: c.env.DB,
    userId,
    table: "areas",
    clientRequestId: readClientRequestId(body),
    insert: c.env.DB.prepare(
      `INSERT INTO areas (user_id, name, color, position)
       VALUES (?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM areas WHERE user_id = ?))`,
    ).bind(userId, name, color, userId),
  });

  const created = await c.env.DB.prepare("SELECT * FROM areas WHERE id = ? AND user_id = ?").bind(rowId, userId).first();
  if (!created) return c.json({ deleted: true });
  await announceChange(c, "lists");
  return c.json(created, 201);
});

areas.put("/:id", async (c) => {
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
  if (sets.length === 0) return c.json({ error: "No fields to update" }, 400);
  sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')");

  const updated = await c.env.DB.prepare(`UPDATE areas SET ${sets.join(", ")} WHERE id = ? AND user_id = ? RETURNING *`)
    .bind(...values, id, userId)
    .first();
  if (!updated) return c.json({ error: "Not found" }, 404);
  await announceChange(c, "lists");
  return c.json(updated);
});

/**
 * DELETE /api/areas/:id?move_to=<area id>
 *
 * An area is never deleted with its contents: its lists and tasks move to
 * `move_to` (default: the first other area), all in one batch so nothing is
 * left pointing at an area that no longer exists. The last area can't go —
 * every task has to live somewhere.
 */
areas.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "Not found" }, 404);

  const all = await ensureAreas(c.env.DB, userId);
  if (!all.some((a) => a.id === id)) return c.json({ error: "Not found" }, 404);
  const others = all.filter((a) => a.id !== id);
  if (others.length === 0) return c.json({ error: "You can't delete your only area" }, 400);

  const moveParam = c.req.query("move_to");
  const target = moveParam === undefined ? others[0].id : parseId(moveParam);
  if (target === null || !others.some((a) => a.id === target)) {
    return c.json({ error: "move_to must be another of your areas" }, 400);
  }

  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE lists SET area_id = ? WHERE area_id = ? AND user_id = ?").bind(target, id, userId),
    c.env.DB.prepare("UPDATE tasks SET area_id = ? WHERE area_id = ? AND user_id = ?").bind(target, id, userId),
    c.env.DB.prepare("DELETE FROM areas WHERE id = ? AND user_id = ?").bind(id, userId),
  ]);

  await announceChange(c, "lists");
  await announceChange(c, "tasks");
  return c.json({ ok: true, moved_to: target });
});

export { areas };
