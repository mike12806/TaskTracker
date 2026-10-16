import { Hono } from "hono";
import type { AppEnv, Env } from "../types/env.js";

const alerts = new Hono<AppEnv>();

/** Most recent alerts to hand back. The feed is recent context, not an archive. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Second-precision UTC, the format `alerts.created_at` is written in.
 *
 * The read mark is compared against those timestamps as a *string*, and the
 * two formats do not sort against each other: `"…T12:00:00.000Z"` is
 * lexicographically less than `"…T12:00:00Z"`, because `.` sorts below `Z`.
 * Storing a millisecond-precision mark would therefore leave the alert it was
 * taken from counting as unread forever, and the badge would never clear.
 */
function toSecondPrecision(iso: string): string {
  return new Date(iso).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * "This user has not dismissed this alert" — the same predicate in the list
 * and the count, so the badge can never disagree with what the drawer shows.
 * Binds one `userId` where it is interpolated.
 */
const NOT_DISMISSED = `NOT EXISTS (
  SELECT 1 FROM alert_dismissals d WHERE d.alert_id = a.id AND d.user_id = ?
)`;

/**
 * "The thing this alert was raised about is still true."
 *
 * A reminder is resolved when its task is completed, snoozed, deleted or has
 * its reminder moved — see `resolveTaskAlerts` in `src/alerts.ts`. Resolved
 * alerts leave the list and the count; the row stays, as the record.
 */
const UNRESOLVED = "a.resolved_at IS NULL";

interface AlertRow {
  id: number;
  task_id: number | null;
  kind: string;
  title: string;
  body: string;
  url: string;
  created_at: string;
}

/**
 * GET /api/alerts — the alerts feed for this user, newest first.
 *
 * `unread` counts against `alert_reads.last_read_at` rather than a per-alert
 * flag — the bell only needs "how many since you last looked". Dismissed and
 * resolved alerts are left out of both the list and the count, through the
 * same predicates, so the badge can never disagree with the drawer.
 */
alerts.get("/", async (c) => {
  const userId = c.get("userId");
  const limit = Math.min(parseInt(c.req.query("limit") || String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT, MAX_LIMIT);

  const read = await c.env.DB.prepare("SELECT last_read_at FROM alert_reads WHERE user_id = ?")
    .bind(userId)
    .first<{ last_read_at: string }>();
  const lastReadAt = read?.last_read_at ?? null;

  const [list, unread] = await Promise.all([
    c.env.DB.prepare(
      `SELECT a.id, a.task_id, a.kind, a.title, a.body, a.url, a.created_at
         FROM alerts a
        WHERE a.user_id = ? AND ${UNRESOLVED} AND ${NOT_DISMISSED}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ?`,
    )
      .bind(userId, userId, limit)
      .all<AlertRow>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS n
         FROM alerts a
        WHERE a.user_id = ? AND ${UNRESOLVED} AND ${NOT_DISMISSED} AND (? IS NULL OR a.created_at > ?)`,
    )
      .bind(userId, userId, lastReadAt, lastReadAt)
      .first<{ n: number }>(),
  ]);

  return c.json({
    alerts: list.results,
    unread: unread?.n ?? 0,
    last_read_at: lastReadAt,
  });
});

/**
 * POST /api/alerts/read — mark the feed read up to a point in time.
 *
 * The client sends the timestamp of the newest alert it actually rendered
 * rather than letting the server take "now": an alert raised in the seconds
 * between the fetch and the tap would otherwise be marked read without ever
 * having been on screen. Falls back to now when the body is empty (an empty
 * feed has no newest row to name).
 *
 * Only ever moves forward. A second device opening a stale drawer would
 * otherwise reset the badge backwards and re-raise alerts already read.
 */
alerts.post("/read", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{ up_to?: string }>().catch(() => ({}) as { up_to?: string });

  const upTo = body.up_to && !Number.isNaN(Date.parse(body.up_to))
    ? toSecondPrecision(body.up_to)
    : toSecondPrecision(new Date().toISOString());

  await c.env.DB.prepare(
    `INSERT INTO alert_reads (user_id, last_read_at) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE
        SET last_read_at = MAX(alert_reads.last_read_at, excluded.last_read_at),
            updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`,
  )
    .bind(userId, upTo)
    .run();

  const row = await c.env.DB.prepare("SELECT last_read_at FROM alert_reads WHERE user_id = ?")
    .bind(userId)
    .first<{ last_read_at: string }>();

  return c.json({ ok: true, last_read_at: row?.last_read_at ?? upTo });
});

/**
 * Is this alert the caller's? False both for an alert that doesn't exist and
 * for someone else's, so the 404 can't be used to probe for either.
 */
async function callerMayReadAlert(env: Env, userId: number, alertId: number): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 AS ok FROM alerts WHERE id = ? AND user_id = ?",
  )
    .bind(alertId, userId)
    .first<{ ok: number }>();
  return row !== null;
}

/**
 * POST /api/alerts/:id/dismiss — take one alert off the feed.
 *
 * Hides, never deletes: the row is the record of what fired, and a mis-tap is
 * undone by `/restore`. Idempotent.
 */
alerts.post("/:id/dismiss", async (c) => {
  const userId = c.get("userId");
  const alertId = parseInt(c.req.param("id"), 10);

  if (!alertId || !(await callerMayReadAlert(c.env, userId, alertId))) {
    return c.json({ error: "Not found" }, 404);
  }

  await c.env.DB.prepare(
    `INSERT INTO alert_dismissals (user_id, alert_id) VALUES (?, ?)
     ON CONFLICT (user_id, alert_id) DO NOTHING`,
  )
    .bind(userId, alertId)
    .run();

  return c.json({ ok: true });
});

/** POST /api/alerts/:id/restore — undo a dismissal. Idempotent. */
alerts.post("/:id/restore", async (c) => {
  const userId = c.get("userId");
  const alertId = parseInt(c.req.param("id"), 10);

  if (!alertId || !(await callerMayReadAlert(c.env, userId, alertId))) {
    return c.json({ error: "Not found" }, 404);
  }

  await c.env.DB.prepare("DELETE FROM alert_dismissals WHERE user_id = ? AND alert_id = ?")
    .bind(userId, alertId)
    .run();

  return c.json({ ok: true });
});

/**
 * POST /api/alerts/:id/unread — walk the read mark back to just before this
 * alert, which necessarily reopens anything raised since. The one place the
 * mark is allowed to move backwards, because it is asked for on purpose.
 */
alerts.post("/:id/unread", async (c) => {
  const userId = c.get("userId");
  const alertId = parseInt(c.req.param("id"), 10);

  if (!alertId || !(await callerMayReadAlert(c.env, userId, alertId))) {
    return c.json({ error: "Not found" }, 404);
  }

  const alert = await c.env.DB.prepare("SELECT created_at FROM alerts WHERE id = ?")
    .bind(alertId)
    .first<{ created_at: string }>();
  if (!alert) return c.json({ error: "Not found" }, 404);

  const before = toSecondPrecision(new Date(new Date(alert.created_at).getTime() - 1000).toISOString());

  await c.env.DB.prepare(
    `INSERT INTO alert_reads (user_id, last_read_at) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE
        SET last_read_at = excluded.last_read_at,
            updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE alert_reads.last_read_at > excluded.last_read_at`,
  )
    .bind(userId, before)
    .run();

  const row = await c.env.DB.prepare("SELECT last_read_at FROM alert_reads WHERE user_id = ?")
    .bind(userId)
    .first<{ last_read_at: string }>();

  return c.json({ ok: true, last_read_at: row?.last_read_at ?? before });
});

export { alerts };
