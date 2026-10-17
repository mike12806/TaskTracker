/**
 * The hourly cron: the morning digest, and housekeeping.
 *
 * "7am" is a local time and cron is UTC, so rather than one fixed trigger
 * that drifts with DST (BabyTracker fires at both translations and discards
 * one), this runs every hour and asks each user's own timezone what hour it
 * is. When it is their digest hour it writes the day's briefing, and — if
 * they opted in — queues the email. A user who flies to another timezone gets
 * their digest at 7am wherever they land, with no cron edit.
 *
 * `digest_runs` is the claim: one row per user per local date, written before
 * anything is queued, so a doubled cron firing cannot double-send.
 */

import type { Env } from "../types/env.js";
import { emailConfigured, escapeHtml, sendEmail } from "../email.js";
import { pruneAlerts } from "../alerts.js";
import { pruneClientRequests } from "../routes/idempotency.js";
import { latestBriefing, pruneBriefings, startBriefing } from "./briefing.js";
import { addDays, DEFAULT_TIMEZONE, isValidTimezone, localDateStr, localParts } from "../time.js";

/** Queue names, as declared in `wrangler.toml`. */
export const DIGEST_QUEUE = "task-tracker-digest";
export const DIGEST_DLQ = "task-tracker-digest-dlq";

/** Where the digest's links point. */
export const APP_URL = "https://tasks.mfaherty.net";

export interface DigestJob {
  userId: number;
  email: string;
  date: string;
  timezone: string;
}

/**
 * How long the email waits behind the briefing it includes (s). The briefing
 * consumer usually finishes in seconds; this is the margin for one retry.
 */
const DIGEST_DELAY_SECONDS = 120;

interface DigestCandidate {
  id: number;
  email: string;
  timezone: string | null;
  digest_hour: number | null;
  email_digest: number | null;
}

/** Run on the hourly cron. */
export async function runHourlyCron(env: Env, now = new Date()): Promise<void> {
  const users = await env.DB.prepare(
    `SELECT u.id, u.email, s.timezone, s.digest_hour, s.email_digest
       FROM users u LEFT JOIN user_settings s ON s.user_id = u.id`,
  ).all<DigestCandidate>();

  for (const user of users.results) {
    try {
      await maybeStartDay(env, user, now);
    } catch (err) {
      console.error(`Digest for user ${user.id} failed:`, err);
    }
  }

  // Housekeeping, once a day at 05:00 UTC. Independent of the digest — an
  // expired row is nobody's dependency — so failures are logged, not chained.
  if (now.getUTCHours() === 5) {
    await Promise.all([
      pruneAlerts(env, now).catch((err) => console.error("Alert prune failed:", err)),
      pruneClientRequests(env.DB).catch((err) => console.error("Client request prune failed:", err)),
      pruneBriefings(env, now).catch((err) => console.error("Briefing prune failed:", err)),
    ]);
  }
}

async function maybeStartDay(env: Env, user: DigestCandidate, now: Date): Promise<void> {
  const timezone = user.timezone && isValidTimezone(user.timezone) ? user.timezone : DEFAULT_TIMEZONE;
  const hour = user.digest_hour ?? 7;
  if (localParts(now, timezone).hour !== hour) return;

  const date = localDateStr(now, timezone);
  const claim = await env.DB.prepare("INSERT OR IGNORE INTO digest_runs (user_id, date) VALUES (?, ?)")
    .bind(user.id, date)
    .run();
  if ((claim.meta?.changes ?? 0) === 0) return;

  await startBriefing(env, { userId: user.id, date, timezone });

  if (!user.email_digest) return;
  if (!emailConfigured(env)) {
    console.warn(`Email digest is on for user ${user.id} but SES is not configured — skipped.`);
    return;
  }

  const job: DigestJob = { userId: user.id, email: user.email, date, timezone };
  if (env.DIGEST_QUEUE) await env.DIGEST_QUEUE.send(job, { delaySeconds: DIGEST_DELAY_SECONDS });
  else await deliverDigest(env, job);
}

interface DigestTask {
  id: number;
  title: string;
  due_date: string | null;
  due_time: string | null;
  priority: string;
  list_name: string | null;
}

function taskLine(task: DigestTask, showDate: boolean): string {
  const when = [showDate ? task.due_date : null, task.due_time].filter(Boolean).join(" ");
  const meta = [when, task.list_name, task.priority !== "none" ? `${task.priority} priority` : null]
    .filter(Boolean)
    .map((s) => escapeHtml(String(s)))
    .join(" · ");
  return `<li style="margin:0 0 6px"><a href="${APP_URL}/?task=${task.id}" style="color:#1f2937;text-decoration:none">${escapeHtml(task.title)}</a>${
    meta ? `<br><span style="color:#6b7280;font-size:13px">${meta}</span>` : ""
  }</li>`;
}

function section(title: string, tasks: DigestTask[], showDate: boolean): string {
  if (tasks.length === 0) return "";
  return `<h3 style="margin:20px 0 8px;font-size:15px;color:#111827">${escapeHtml(title)} (${tasks.length})</h3>
<ul style="margin:0;padding-left:18px">${tasks.map((t) => taskLine(t, showDate)).join("")}</ul>`;
}

/** Render the digest for one user and date. Exported for the tests. */
export async function buildDigest(env: Env, job: DigestJob): Promise<{ subject: string; html: string }> {
  const weekOut = addDays(job.date, 7);
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.title, t.due_date, t.due_time, t.priority,
            COALESCE(l.name, ar.name || ' Inbox') AS list_name
       FROM tasks t
       LEFT JOIN lists l ON l.id = t.list_id
       LEFT JOIN areas ar ON ar.id = t.area_id
      WHERE t.user_id = ? AND t.completed = 0 AND t.due_date IS NOT NULL AND t.due_date <= ?
      ORDER BY t.due_date, t.due_time IS NULL, t.due_time,
               CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END`,
  )
    .bind(job.userId, weekOut)
    .all<DigestTask>();

  const overdue = results.filter((t) => t.due_date! < job.date);
  const today = results.filter((t) => t.due_date === job.date);
  const upcoming = results.filter((t) => t.due_date! > job.date);

  const briefing = await latestBriefing(env, job.userId);
  const note = briefing && briefing.date === job.date ? briefing.body : null;

  const subject =
    today.length + overdue.length === 0
      ? `Today: nothing due (${job.date})`
      : `Today: ${today.length} due${overdue.length ? `, ${overdue.length} overdue` : ""} (${job.date})`;

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f6fb;font-family:-apple-system,Segoe UI,Roboto,sans-serif">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:24px">
<h2 style="margin:0 0 4px;font-size:20px;color:#111827">Your day</h2>
<p style="margin:0 0 12px;color:#6b7280;font-size:13px">${escapeHtml(job.date)}</p>
${note ? `<p style="margin:0 0 8px;color:#374151;font-size:15px;line-height:1.5">${escapeHtml(note)}</p>` : ""}
${section("Overdue", overdue, true)}
${section("Today", today, false)}
${section("Next 7 days", upcoming, true)}
${results.length === 0 ? '<p style="color:#374151">Nothing scheduled this week.</p>' : ""}
<p style="margin:24px 0 0"><a href="${APP_URL}" style="color:#5b5dff">Open Tasks</a></p>
</div></body></html>`;

  return { subject, html };
}

/** Send one digest; run from the queue consumer (or inline without a queue). */
export async function deliverDigest(env: Env, job: DigestJob): Promise<void> {
  const { subject, html } = await buildDigest(env, job);
  await sendEmail(env, job.email, subject, html);
}

/**
 * Report a digest that exhausted its retries, to ALERT_EMAIL (falling back to
 * REPORT_FROM_EMAIL). Over the same channel that just failed, so this can fail
 * too — the consumer retries it, and the Worker log is the last word.
 */
export async function alertDeadLetteredDigest(env: Env, job: DigestJob, attempts: number): Promise<void> {
  const to = env.ALERT_EMAIL || env.REPORT_FROM_EMAIL;
  if (!to) throw new Error("No ALERT_EMAIL or REPORT_FROM_EMAIL to report to");
  await sendEmail(
    env,
    to,
    `Task digest for ${job.date} could not be delivered`,
    `<p>The morning digest for ${escapeHtml(job.email)} on ${escapeHtml(job.date)} failed after ${attempts} attempts and was dead-lettered. Check the Worker logs for the SES error.</p>`,
  );
}
