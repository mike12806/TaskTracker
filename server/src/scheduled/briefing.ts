/**
 * The daily briefing: two sentences at the top of the Today page about what
 * the day holds and how the week has gone.
 *
 * The same rules as BabyTracker's daily note, for the same reasons:
 *
 * - **Figures are computed in SQL, never by the model.** A model asked to
 *   count overdue tasks will occasionally miscount, and a briefing that says
 *   "nothing overdue" over a list of five overdue tasks is worse than none.
 *   The model is handed finished numbers (and the titles of the few tasks
 *   that matter most today) and only writes the sentences around them.
 * - **Cached in D1, one generation per user per day.** Written by the hourly
 *   cron at the user's digest hour, so opening the app never reaches the
 *   model. Cost is a rounding error against Workers AI's free allocation.
 * - **There is always a true briefing.** The cron writes a deterministic
 *   template first and queues the model call; the consumer replaces it when a
 *   real one arrives, retrying transient model failures. With no AI binding
 *   (local dev, tests) or on any model error, the template stands, and
 *   `source` records which wrote it.
 *
 * Unlike the baby tracker's note, task titles are sent to the model — they are
 * the useful part of a briefing. They go to Workers AI on this same Cloudflare
 * account and nowhere else.
 */

import type { Env } from "../types/env.js";
import { cacheDelete, cached, type WaitUntil } from "../kv/cache.js";
import { briefingKey } from "../kv/keys.js";
import { BRIEFING_TTL_SECONDS } from "../kv/ttl.js";
import { notifyChange } from "../live.js";
import { addDays, localToUtc, toIsoSeconds } from "../time.js";

/** Queue name, as declared in `wrangler.toml`. */
export const BRIEFING_QUEUE = "task-tracker-briefing";

export interface BriefingJob {
  userId: number;
  /** The local date the briefing is for, `YYYY-MM-DD`. */
  date: string;
  timezone: string;
}

/**
 * Models to try, in order, until one writes a usable briefing — the same
 * chain the daily note settled on after it failed three times in the same
 * shape: a thinking MoE that writes well, then a deliberately *unlike*
 * fallback that answers in the flat `{ response }` shape.
 */
export const BRIEFING_MODEL_CHAIN = [
  "@cf/google/gemma-4-26b-a4b-it",
  "@cf/meta/llama-3.1-8b-instruct-fp8-fast",
];

/** The card gives this one line or two; anything longer gets clipped. */
export const MAX_BRIEFING_LENGTH = 280;

/**
 * Reply budget — generous, because the default model thinks before it
 * answers and reasoning tokens come out of the same allowance. Billing is on
 * tokens produced, and `tidyBriefing` clips the stored text regardless.
 */
const MAX_REPLY_TOKENS = 1024;

export interface BriefingStats {
  dueToday: number;
  overdue: number;
  highPriority: number;
  completedYesterday: number;
  /** Completions per day over the seven days before yesterday. */
  weeklyAverage: number;
  /** Up to three titles, most pressing first. */
  focus: string[];
}

export interface BriefingRow {
  user_id: number;
  date: string;
  body: string;
  source: "ai" | "fallback";
  created_at: string;
  updated_at: string;
}

/** Every figure the briefing quotes, for one user on one local date. */
export async function computeBriefingStats(
  env: Env,
  userId: number,
  date: string,
  tz: string,
): Promise<BriefingStats> {
  const yesterday = addDays(date, -1);
  const yesterdayStart = toIsoSeconds(localToUtc(yesterday, "00:00", tz));
  const todayStart = toIsoSeconds(localToUtc(date, "00:00", tz));
  const weekStart = toIsoSeconds(localToUtc(addDays(yesterday, -7), "00:00", tz));

  const [counts, done, focus] = await Promise.all([
    env.DB.prepare(
      `SELECT
         SUM(CASE WHEN due_date = ? THEN 1 ELSE 0 END) AS due_today,
         SUM(CASE WHEN due_date < ? THEN 1 ELSE 0 END) AS overdue,
         SUM(CASE WHEN due_date <= ? AND priority = 'high' THEN 1 ELSE 0 END) AS high_priority
       FROM tasks WHERE user_id = ? AND completed = 0 AND due_date IS NOT NULL`,
    )
      .bind(date, date, date, userId)
      .first<{ due_today: number | null; overdue: number | null; high_priority: number | null }>(),
    env.DB.prepare(
      `SELECT
         SUM(CASE WHEN completed_at >= ? AND completed_at < ? THEN 1 ELSE 0 END) AS yesterday,
         SUM(CASE WHEN completed_at >= ? AND completed_at < ? THEN 1 ELSE 0 END) AS week
       FROM tasks WHERE user_id = ? AND completed = 1 AND completed_at >= ?`,
    )
      .bind(yesterdayStart, todayStart, weekStart, yesterdayStart, userId, weekStart)
      .first<{ yesterday: number | null; week: number | null }>(),
    env.DB.prepare(
      `SELECT title FROM tasks
        WHERE user_id = ? AND completed = 0 AND due_date IS NOT NULL AND due_date <= ?
        ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
                 due_date, due_time IS NULL, due_time
        LIMIT 3`,
    )
      .bind(userId, date)
      .all<{ title: string }>(),
  ]);

  return {
    dueToday: counts?.due_today ?? 0,
    overdue: counts?.overdue ?? 0,
    highPriority: counts?.high_priority ?? 0,
    completedYesterday: done?.yesterday ?? 0,
    weeklyAverage: Math.round(((done?.week ?? 0) / 7) * 10) / 10,
    focus: focus.results.map((r) => r.title),
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The deterministic briefing — the same true figures, in a fixed voice. */
export function templateBriefing(stats: BriefingStats): string {
  const { dueToday, overdue, completedYesterday, weeklyAverage } = stats;

  const today =
    dueToday === 0 && overdue === 0
      ? "Nothing is due today."
      : overdue === 0
        ? `${plural(dueToday, "task")} due today.`
        : dueToday === 0
          ? `Nothing new is due today, but ${plural(overdue, "task is", "tasks are")} overdue.`
          : `${plural(dueToday, "task")} due today, plus ${overdue} overdue.`;

  const yesterday =
    completedYesterday === 0
      ? "Nothing was checked off yesterday."
      : completedYesterday > weeklyAverage
        ? `You finished ${completedYesterday} yesterday, above your recent average of ${weeklyAverage} a day.`
        : `You finished ${completedYesterday} yesterday.`;

  return tidyBriefing(`${today} ${yesterday}`) ?? today;
}

export function buildPrompt(stats: BriefingStats): { system: string; user: string } {
  const facts = [
    `Due today: ${stats.dueToday}`,
    `Overdue: ${stats.overdue}`,
    `High priority due or overdue: ${stats.highPriority}`,
    `Completed yesterday: ${stats.completedYesterday}`,
    `Average completed per day over the previous week: ${stats.weeklyAverage}`,
    ...(stats.focus.length > 0 ? [`Most pressing today: ${stats.focus.map((t) => `"${t}"`).join(", ")}`] : []),
  ].join("\n");

  return {
    system: [
      "You write a short morning briefing for a personal to-do app, read by its one user as they start the day.",
      "Write exactly two sentences, under 260 characters total.",
      "First sentence: what today holds, using the figures given; you may name one or two of the most pressing tasks.",
      "Second sentence: one plain, specific line about yesterday's progress or a nudge for today.",
      "Use only the numbers provided — never invent, recompute, or round them differently.",
      "Plain-spoken and calm. No emoji, no hashtags, no exclamation marks, no greeting, no sign-off, no quotation marks around the briefing.",
      "If nothing is due and nothing is overdue, say so without inventing work.",
    ].join(" "),
    user: `${facts}\n\nWrite the briefing.`,
  };
}

/** Clean a model reply into something fit for the card, or null if unusable. */
export function tidyBriefing(text: string): string | null {
  let cleaned = text.replace(/\s+/g, " ").trim();
  cleaned = cleaned.replace(/^["'“”]+|["'“”]+$/g, "").trim();
  if (cleaned.length < 10) return null;
  if (cleaned.length > MAX_BRIEFING_LENGTH) {
    const clipped = cleaned.slice(0, MAX_BRIEFING_LENGTH);
    const lastStop = clipped.lastIndexOf(". ");
    cleaned = lastStop > 40 ? clipped.slice(0, lastStop + 1) : `${clipped.trimEnd()}…`;
  }
  return cleaned;
}

/**
 * Workers AI answers in two shapes: `{ response }` for simpler models, and the
 * OpenAI chat-completions shape (`choices[0].message.content`) for thinking
 * models like the default here. Reading only one of them silently produces a
 * template briefing every day, which is how BabyTracker's note failed first.
 */
interface AiTextResponse {
  response?: string;
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  usage?: { completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
}

function extractModelText(result: AiTextResponse): string {
  return result.response ?? result.choices?.[0]?.message?.content ?? "";
}

/** Log-safe metadata about an unusable reply — never the text itself. */
function describeReply(result: AiTextResponse): string {
  const bits = [`keys=${Object.keys(result ?? {}).join("|") || "none"}`];
  const finish = result.choices?.[0]?.finish_reason;
  if (finish) bits.push(`finish=${finish}`);
  if (result.usage?.completion_tokens !== undefined) bits.push(`out=${result.usage.completion_tokens}`);
  const reasoning = result.usage?.completion_tokens_details?.reasoning_tokens;
  if (reasoning !== undefined) bits.push(`reasoning=${reasoning}`);
  return bits.join(" ");
}

export interface GeneratedBriefing {
  body: string;
  source: "ai" | "fallback";
  /** Why the template was used, or which model wrote it after earlier failures. */
  reason?: string;
}

/** Ask the model chain for a briefing, falling back to the template. */
export async function generateBriefing(env: Env, stats: BriefingStats): Promise<GeneratedBriefing> {
  const fallback = (reason: string): GeneratedBriefing => ({
    body: templateBriefing(stats),
    source: "fallback",
    reason,
  });
  if (!env.AI) return fallback("no AI binding");

  const { system, user } = buildPrompt(stats);
  const models = env.BRIEFING_MODEL ? [env.BRIEFING_MODEL] : BRIEFING_MODEL_CHAIN;
  const failures: string[] = [];

  for (const model of models) {
    try {
      const result = (await env.AI.run(model as Parameters<Ai["run"]>[0], {
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: MAX_REPLY_TOKENS,
        temperature: 0.6,
      } as never)) as AiTextResponse;

      const text = extractModelText(result);
      const tidied = tidyBriefing(text);
      if (tidied) {
        return failures.length > 0
          ? { body: tidied, source: "ai", reason: `wrote with ${model} after: ${failures.join("; ")}` }
          : { body: tidied, source: "ai" };
      }
      failures.push(`${model}: unusable reply (${text.length} chars) — ${describeReply(result)}`);
    } catch (error) {
      failures.push(`${model}: threw ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return fallback(failures.join("; "));
}

/**
 * Write a briefing, the single choke point for the row and its cache key.
 *
 * An AI briefing always replaces; a template only fills a gap or replaces
 * another template — a retried cron must never overwrite the real briefing
 * that the queue already delivered with the fallback.
 */
export async function storeBriefing(
  env: Env,
  userId: number,
  date: string,
  briefing: GeneratedBriefing,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO daily_briefings (user_id, date, body, source) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, date) DO UPDATE
        SET body = excluded.body, source = excluded.source,
            updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE excluded.source = 'ai' OR daily_briefings.source = 'fallback'`,
  )
    .bind(userId, date, briefing.body, briefing.source)
    .run();
  await cacheDelete(env, briefingKey(userId));
  await notifyChange(env, userId, "briefing");
}

/**
 * Write today's template briefing now and queue the model call, so the card
 * has something true on it from the first second. Without a queue bound the
 * generation runs inline.
 */
export async function startBriefing(env: Env, job: BriefingJob): Promise<void> {
  const stats = await computeBriefingStats(env, job.userId, job.date, job.timezone);
  await storeBriefing(env, job.userId, job.date, { body: templateBriefing(stats), source: "fallback" });
  if (env.BRIEFING_QUEUE) await env.BRIEFING_QUEUE.send(job);
  else await writeBriefingForJob(env, job);
}

/** The queue consumer's half: generate and store. Returns what was written. */
export async function writeBriefingForJob(env: Env, job: BriefingJob): Promise<GeneratedBriefing> {
  // Recomputed rather than carried on the job: a message that is retried an
  // hour later should describe the tasks as they are, not as they were.
  const stats = await computeBriefingStats(env, job.userId, job.date, job.timezone);
  const briefing = await generateBriefing(env, stats);
  if (briefing.source === "fallback") {
    console.warn(`Briefing for user ${job.userId} on ${job.date} fell back: ${briefing.reason}`);
  }
  await storeBriefing(env, job.userId, job.date, briefing);
  return briefing;
}

/** The newest briefing for a user, from KV when possible. */
export async function latestBriefing(env: Env, userId: number, waitUntil?: WaitUntil): Promise<BriefingRow | null> {
  return cached(
    env,
    briefingKey(userId),
    BRIEFING_TTL_SECONDS,
    async () =>
      (await env.DB.prepare(
        "SELECT * FROM daily_briefings WHERE user_id = ? ORDER BY date DESC LIMIT 1",
      )
        .bind(userId)
        .first<BriefingRow>()) ?? null,
    waitUntil,
  );
}

/** Drop briefings older than a month. Run from the hourly cron. */
export async function pruneBriefings(env: Env, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 31 * 86_400_000).toISOString().slice(0, 10);
  const result = await env.DB.prepare("DELETE FROM daily_briefings WHERE date < ?").bind(cutoff).run();
  return result.meta?.changes ?? 0;
}
