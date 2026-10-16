import type { ReminderJob } from "../scheduled/reminders.js";
import type { DigestJob } from "../scheduled/digest.js";
import type { BriefingJob } from "../scheduled/briefing.js";
import type { UserLive } from "../live.js";
import type { DomainEvent } from "../events/types.js";

/**
 * Every binding the Worker reads.
 *
 * The rule from BabyTracker holds throughout: anything that is not D1 is
 * optional, and code that uses it degrades rather than fails without it. With
 * no queue a producer runs its consumer inline; with no `LIVE` the client
 * polls; with no `CACHE` every read goes to D1; with no `AI` the briefing is
 * the template. Tests and local dev run on exactly those fallbacks.
 */
export interface Env {
  DB: D1Database;
  /** Live-update fan-out, one Durable Object per user. See `src/live.ts`. */
  LIVE?: DurableObjectNamespace<UserLive>;
  /** Read-through cache — see `src/kv/cache.ts` for what may go in it. */
  CACHE?: KVNamespace;
  /** The domain event bus — see `src/events/bus.ts`. */
  EVENTS?: Queue<DomainEvent>;
  /** Reminder push delivery, one job per subscribed device. */
  REMINDER_QUEUE?: Queue<ReminderJob>;
  /** Morning digest email delivery. */
  DIGEST_QUEUE?: Queue<DigestJob>;
  /** Daily briefing generation. */
  BRIEFING_QUEUE?: Queue<BriefingJob>;
  /** Workers AI, for the daily briefing. */
  AI?: Ai;
  /** Overrides the model chain the briefing is written with. */
  BRIEFING_MODEL?: string;

  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
  DEV_MODE?: string;

  // Email digest via AWS SES (set via `wrangler secret put`). All optional:
  // without them the digest is simply not sent.
  AWS_SES_ACCESS_KEY?: string;
  AWS_SES_SECRET_KEY?: string;
  AWS_SES_REGION?: string;
  REPORT_FROM_EMAIL?: string;
  /** Where a dead-lettered digest is reported. Falls back to REPORT_FROM_EMAIL. */
  ALERT_EMAIL?: string;

  /** Web Push (VAPID). Set once by the deploy workflow. */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

/** Hono's environment for every route: bindings plus the authenticated user. */
export type AppEnv = {
  Bindings: Env;
  Variables: { userId: number; userEmail: string; userName: string };
};
