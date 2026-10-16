import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { createTestApp, applyMigrations, testRequest, testEnvFor, testUserId } from "./helpers";
import { runHourlyCron, buildDigest, type DigestJob } from "../src/scheduled/digest.js";
import {
  computeBriefingStats,
  generateBriefing,
  storeBriefing,
  templateBriefing,
  tidyBriefing,
  type BriefingJob,
} from "../src/scheduled/briefing.js";
import type { Env } from "../src/types/env.js";

describe("daily briefing", () => {
  let api: ReturnType<typeof testRequest>;
  let userId: number;

  beforeEach(async () => {
    await applyMigrations(env.DB);
    api = testRequest(createTestApp(), env.DB);
    userId = await testUserId(env.DB);
  });

  it("computes its figures in SQL", async () => {
    await api.post("/api/tasks", { title: "Overdue thing", due_date: "2026-10-14", priority: "high" });
    await api.post("/api/tasks", { title: "Today thing", due_date: "2026-10-16" });
    await api.post("/api/tasks", { title: "Later thing", due_date: "2026-10-20" });
    await env.DB.prepare(
      "INSERT INTO tasks (user_id, title, completed, completed_at) VALUES (?, 'done', 1, '2026-10-15T15:00:00Z')",
    ).bind(userId).run();

    const stats = await computeBriefingStats(testEnvFor(env.DB), userId, "2026-10-16", "America/New_York");
    expect(stats).toMatchObject({ dueToday: 1, overdue: 1, highPriority: 1, completedYesterday: 1 });
    expect(stats.focus[0]).toBe("Overdue thing");
    expect(templateBriefing(stats)).toBe(
      "1 task due today, plus 1 overdue. You finished 1 yesterday, above your recent average of 0 a day.",
    );
  });

  it("uses the model when it answers, in either response shape", async () => {
    const stats = { dueToday: 2, overdue: 0, highPriority: 0, completedYesterday: 3, weeklyAverage: 2, focus: [] };
    const chat = { run: vi.fn(async () => ({ choices: [{ message: { content: "Two tasks today. Good momentum." } }] })) };
    expect(await generateBriefing({ AI: chat } as unknown as Env, stats)).toEqual({
      body: "Two tasks today. Good momentum.",
      source: "ai",
    });

    const broken = { run: vi.fn(async () => ({ choices: [{ message: { content: "" }, finish_reason: "length" }] })) };
    const fell = await generateBriefing({ AI: broken } as unknown as Env, stats);
    expect(fell.source).toBe("fallback");
    expect(fell.reason).toContain("finish=length");
  });

  it("never lets a template overwrite an AI briefing", async () => {
    const e = testEnvFor(env.DB);
    await storeBriefing(e, userId, "2026-10-16", { body: "The real one.", source: "ai" });
    await storeBriefing(e, userId, "2026-10-16", { body: "A template one.", source: "fallback" });
    const row = await env.DB.prepare("SELECT body FROM daily_briefings WHERE user_id = ?").bind(userId).first<{ body: string }>();
    expect(row?.body).toBe("The real one.");
  });

  it("tidies model output", () => {
    expect(tidyBriefing('  "Quoted   reply."  ')).toBe("Quoted reply.");
    expect(tidyBriefing("ok")).toBeNull();
  });
});

describe("hourly cron", () => {
  let userId: number;
  const briefings: BriefingJob[] = [];
  const digests: DigestJob[] = [];
  const cronEnv = (extra: Partial<Env> = {}) =>
    testEnvFor(env.DB, {
      BRIEFING_QUEUE: { send: async (j: BriefingJob) => void briefings.push(j) } as unknown as Queue<BriefingJob>,
      DIGEST_QUEUE: { send: async (j: DigestJob) => void digests.push(j) } as unknown as Queue<DigestJob>,
      ...extra,
    });
  const ses = {
    AWS_SES_REGION: "us-east-1",
    AWS_SES_ACCESS_KEY: "k",
    AWS_SES_SECRET_KEY: "s",
    REPORT_FROM_EMAIL: "tasks@example.com",
  };

  beforeEach(async () => {
    await applyMigrations(env.DB);
    userId = await testUserId(env.DB);
    briefings.length = 0;
    digests.length = 0;
  });

  it("starts the day at the user's local digest hour, once", async () => {
    // 10:00 UTC is 06:00 EDT — not yet.
    await runHourlyCron(cronEnv(ses), new Date("2026-10-16T10:00:00Z"));
    expect(briefings).toHaveLength(0);

    // 11:00 UTC is 07:00 EDT, the default digest hour.
    await runHourlyCron(cronEnv(ses), new Date("2026-10-16T11:00:00Z"));
    await runHourlyCron(cronEnv(ses), new Date("2026-10-16T11:00:05Z"));
    expect(briefings).toEqual([{ userId, date: "2026-10-16", timezone: "America/New_York" }]);
    // The template is on the card before the model has been asked anything.
    const row = await env.DB.prepare("SELECT source FROM daily_briefings WHERE user_id = ?").bind(userId).first<{ source: string }>();
    expect(row?.source).toBe("fallback");
    // Email is opt-in.
    expect(digests).toHaveLength(0);
  });

  it("follows the user's timezone and queues the email when opted in", async () => {
    await env.DB.prepare("INSERT INTO user_settings (user_id, timezone, digest_hour, email_digest) VALUES (?, 'Europe/London', 8, 1)")
      .bind(userId)
      .run();
    await runHourlyCron(cronEnv(ses), new Date("2026-10-16T07:00:00Z")); // 08:00 BST
    expect(digests).toEqual([{ userId, email: "test@example.com", date: "2026-10-16", timezone: "Europe/London" }]);
  });

  it("skips the email without SES configured", async () => {
    await env.DB.prepare("INSERT INTO user_settings (user_id, email_digest) VALUES (?, 1)").bind(userId).run();
    await runHourlyCron(cronEnv(), new Date("2026-10-16T11:00:00Z"));
    expect(briefings).toHaveLength(1);
    expect(digests).toHaveLength(0);
  });

  it("renders overdue, today and upcoming, escaped", async () => {
    const api = testRequest(createTestApp(), env.DB);
    await api.post("/api/tasks", { title: "<b>Old</b>", due_date: "2026-10-10" });
    await api.post("/api/tasks", { title: "Now", due_date: "2026-10-16", due_time: "15:00" });
    await api.post("/api/tasks", { title: "Soon", due_date: "2026-10-18" });
    await api.post("/api/tasks", { title: "Far", due_date: "2026-12-01" });

    const { subject, html } = await buildDigest(testEnvFor(env.DB), {
      userId,
      email: "test@example.com",
      date: "2026-10-16",
      timezone: "America/New_York",
    });
    expect(subject).toBe("Today: 1 due, 1 overdue (2026-10-16)");
    expect(html).toContain("&lt;b&gt;Old&lt;/b&gt;");
    expect(html).toContain("Soon");
    expect(html).not.toContain("Far");
  });
});
