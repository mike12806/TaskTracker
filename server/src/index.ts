import { Hono } from "hono";
import type { AppEnv, Env } from "./types/env.js";
import { authMiddleware } from "./middleware/auth.js";
import { cacheControlMiddleware } from "./middleware/cacheControl.js";
import { auth } from "./routes/auth.js";
import { tasks } from "./routes/tasks.js";
import { lists } from "./routes/lists.js";
import { areas } from "./routes/areas.js";
import { settings } from "./routes/settings.js";
import { alerts } from "./routes/alerts.js";
import { push } from "./routes/push.js";
import { briefing } from "./routes/briefing.js";
import { live } from "./routes/live.js";
import { runReminderCron, deliverReminder, REMINDER_QUEUE } from "./scheduled/reminders.js";
import type { ReminderJob } from "./scheduled/reminders.js";
import {
  runHourlyCron,
  deliverDigest,
  alertDeadLetteredDigest,
  DIGEST_QUEUE,
  DIGEST_DLQ,
} from "./scheduled/digest.js";
import type { DigestJob } from "./scheduled/digest.js";
import { writeBriefingForJob, BRIEFING_QUEUE } from "./scheduled/briefing.js";
import type { BriefingJob } from "./scheduled/briefing.js";
import { dispatch, EVENTS_QUEUE } from "./events/bus.js";
import type { DomainEvent } from "./events/types.js";

const app = new Hono<AppEnv>();

// All API routes require Cloudflare Access authentication.
app.use("/api/*", authMiddleware);

// Live updates, mounted between the two middlewares on purpose: below auth
// because a socket is authenticated like everything else, above
// `cacheControlMiddleware` because a 101's `webSocket` does not survive the
// response being rebuilt to add a header.
app.route("/api/live", live);

// No intermediary may hand back a stale copy of a reply — see the middleware.
app.use("/api/*", cacheControlMiddleware);

app.route("/api/auth", auth);
app.route("/api/tasks", tasks);
app.route("/api/lists", lists);
app.route("/api/areas", areas);
app.route("/api/settings", settings);
app.route("/api/alerts", alerts);
app.route("/api/push", push);
app.route("/api/briefing", briefing);

app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json({ error: "Internal server error" }, 500);
});

/**
 * The hourly cron, exactly as it appears in `wrangler.toml`; the other one is
 * the every-minute reminder cron. Not exported: every named export of the
 * entry module must be a handler or a Durable Object class, and workerd
 * refuses to start a Worker that exports a string.
 */
const HOURLY_CRON = "0 * * * *";

/** Re-exported so wrangler can resolve the Durable Object class. */
export { UserLive } from "./live.js";

type QueueBody = ReminderJob | DigestJob | BriefingJob | DomainEvent;

/**
 * Run one consumer over a batch, acking and retrying per message.
 *
 * Per message rather than per batch, as in BabyTracker: a batch-level retry
 * would redeliver the pushes that already went out alongside the one that
 * failed, and a duplicate reminder is the failure this is meant to avoid.
 */
async function consumeEach<T>(
  batch: MessageBatch<QueueBody>,
  label: (body: T) => string,
  handle: (body: T, attempts: number) => Promise<boolean | void>,
): Promise<void> {
  for (const message of batch.messages) {
    const body = message.body as T;
    try {
      const ok = await handle(body, message.attempts);
      if (ok === false) message.retry();
      else message.ack();
    } catch (err) {
      console.error(`${batch.queue}: ${label(body)} failed:`, err);
      message.retry();
    }
  }
}

export default {
  fetch: app.fetch,

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === HOURLY_CRON) {
      ctx.waitUntil(runHourlyCron(env).catch((err) => console.error("Hourly cron failed:", err)));
      return;
    }
    // Anything else is the every-minute reminder cron — including the minute
    // the hourly one also fires on, which Cloudflare delivers as two events.
    ctx.waitUntil(runReminderCron(env).catch((err) => console.error("Reminder cron failed:", err)));
  },

  async queue(batch: MessageBatch<QueueBody>, env: Env): Promise<void> {
    switch (batch.queue) {
      // The domain event bus. A retry re-runs every subscriber on the event,
      // which is why each of them must be idempotent — see events/bus.ts.
      case EVENTS_QUEUE:
        return consumeEach<DomainEvent>(batch, (e) => `${e?.type} on task ${e?.taskId}`, (e) => dispatch(env, e));

      case REMINDER_QUEUE:
        return consumeEach<ReminderJob>(batch, (j) => `push to subscription ${j?.subscriptionId}`, (j) =>
          deliverReminder(env, j),
        );

      // A template briefing is already on the card, so a fallback here is a
      // transient model failure worth retrying, not a final answer.
      case BRIEFING_QUEUE:
        return consumeEach<BriefingJob>(batch, (j) => `briefing for user ${j?.userId}`, async (j) => {
          const written = await writeBriefingForJob(env, j);
          return written.source === "ai";
        });

      case DIGEST_DLQ:
        return consumeEach<DigestJob>(batch, (j) => `dead-letter report for ${j?.date}`, (j, attempts) =>
          alertDeadLetteredDigest(env, j, attempts),
        );

      case DIGEST_QUEUE:
        return consumeEach<DigestJob>(batch, (j) => `digest for ${j?.date}`, (j) => deliverDigest(env, j));

      default:
        console.error(`Message on unknown queue ${batch.queue}; acking so it is not redelivered forever.`);
        batch.ackAll();
    }
  },
};
