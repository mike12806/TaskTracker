import { Hono } from "hono";
import type { AppEnv } from "../types/env.js";
import { announceChange } from "../live.js";
import { DEFAULT_TIMEZONE, isValidTimezone } from "../time.js";

const settings = new Hono<AppEnv>();

export interface SettingsRow {
  user_id: number;
  theme_mode: "system" | "light" | "dark";
  timezone: string;
  digest_hour: number;
  email_digest: number;
  default_reminder_time: string;
}

const SELECT_SETTINGS =
  "SELECT user_id, theme_mode, timezone, digest_hour, email_digest, default_reminder_time FROM user_settings WHERE user_id = ?";

async function ensureRow(db: D1Database, userId: number): Promise<SettingsRow> {
  await db.prepare("INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)").bind(userId).run();
  return (await db.prepare(SELECT_SETTINGS).bind(userId).first<SettingsRow>())!;
}

/**
 * The user's timezone, for the server-side calendar arithmetic (recurrence,
 * the digest hour, "today"). Falls back rather than failing: a task completing
 * is not a reason to 500 over a settings row that is missing or unreadable.
 */
export async function readTimezone(db: D1Database, userId: number): Promise<string> {
  const row = await db
    .prepare("SELECT timezone FROM user_settings WHERE user_id = ?")
    .bind(userId)
    .first<{ timezone: string }>();
  return row && isValidTimezone(row.timezone) ? row.timezone : DEFAULT_TIMEZONE;
}

// GET /api/settings — auto-creates the row with defaults on first visit.
settings.get("/", async (c) => {
  return c.json(await ensureRow(c.env.DB, c.get("userId")));
});

// PUT /api/settings — partial update; absent fields are left alone.
settings.put("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<Partial<Record<keyof SettingsRow, unknown>>>().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "Invalid JSON body" }, 400);

  const sets: string[] = [];
  const values: (string | number)[] = [];

  if (body.theme_mode !== undefined) {
    if (!["system", "light", "dark"].includes(body.theme_mode as string)) {
      return c.json({ error: "Invalid theme_mode" }, 400);
    }
    sets.push("theme_mode = ?");
    values.push(body.theme_mode as string);
  }
  if (body.timezone !== undefined) {
    if (typeof body.timezone !== "string" || !isValidTimezone(body.timezone)) {
      return c.json({ error: "Invalid timezone" }, 400);
    }
    sets.push("timezone = ?");
    values.push(body.timezone);
  }
  if (body.digest_hour !== undefined) {
    const hour = body.digest_hour;
    if (typeof hour !== "number" || !Number.isInteger(hour) || hour < 0 || hour > 23) {
      return c.json({ error: "digest_hour must be 0-23" }, 400);
    }
    sets.push("digest_hour = ?");
    values.push(hour);
  }
  if (body.email_digest !== undefined) {
    sets.push("email_digest = ?");
    values.push(body.email_digest ? 1 : 0);
  }
  if (body.default_reminder_time !== undefined) {
    if (typeof body.default_reminder_time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.default_reminder_time)) {
      return c.json({ error: "default_reminder_time must be HH:MM" }, 400);
    }
    sets.push("default_reminder_time = ?");
    values.push(body.default_reminder_time);
  }

  await ensureRow(c.env.DB, userId);
  if (sets.length > 0) {
    sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')");
    await c.env.DB.prepare(`UPDATE user_settings SET ${sets.join(", ")} WHERE user_id = ?`)
      .bind(...values, userId)
      .run();
    await announceChange(c, "settings");
  }

  return c.json(await ensureRow(c.env.DB, userId));
});

export { settings };
