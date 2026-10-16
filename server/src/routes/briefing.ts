import { Hono } from "hono";
import type { AppEnv } from "../types/env.js";
import { backgroundWrites } from "../kv/cache.js";
import { readTimezone } from "./settings.js";
import { computeBriefingStats, generateBriefing, latestBriefing, storeBriefing } from "../scheduled/briefing.js";
import { localDateStr } from "../time.js";

const briefing = new Hono<AppEnv>();

/**
 * GET /api/briefing — today's briefing, or null before the digest hour.
 *
 * The cache holds the newest *row*, and "is it today's?" is asked after the
 * read — caching the answer would freeze the clock at the moment of the miss
 * and serve yesterday's briefing as today's until the TTL ran out.
 */
briefing.get("/", async (c) => {
  const userId = c.get("userId");
  const [row, tz] = await Promise.all([
    latestBriefing(c.env, userId, backgroundWrites(c)),
    readTimezone(c.env.DB, userId),
  ]);
  const today = localDateStr(new Date(), tz);
  return c.json({ briefing: row && row.date === today ? row : null });
});

/**
 * POST /api/briefing/refresh — write today's briefing now.
 *
 * Synchronous on purpose, unlike the cron's queued path: a person is waiting
 * on it, and wants the reason when the model declines. The only way to see a
 * briefing before the digest hour, and it never sends email.
 */
briefing.post("/refresh", async (c) => {
  const userId = c.get("userId");
  const tz = await readTimezone(c.env.DB, userId);
  const date = localDateStr(new Date(), tz);

  const stats = await computeBriefingStats(c.env, userId, date, tz);
  const generated = await generateBriefing(c.env, stats);
  await storeBriefing(c.env, userId, date, generated);

  const row = await c.env.DB.prepare("SELECT * FROM daily_briefings WHERE user_id = ? AND date = ?")
    .bind(userId, date)
    .first();
  return c.json({ briefing: row, source: generated.source, reason: generated.reason ?? null });
});

export { briefing };
