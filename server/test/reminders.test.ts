import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { createTestApp, applyMigrations, testRequest, testEnvFor } from "./helpers";
import { runReminderCron, deliverReminder, type ReminderJob } from "../src/scheduled/reminders.js";

interface AlertFeed {
  alerts: { id: number; task_id: number; title: string; body: string }[];
  unread: number;
}

describe("reminder cron", () => {
  let api: ReturnType<typeof testRequest>;
  const sent: ReminderJob[] = [];
  const queue = { send: async (job: ReminderJob) => void sent.push(job) } as unknown as Queue<ReminderJob>;

  beforeEach(async () => {
    await applyMigrations(env.DB);
    api = testRequest(createTestApp(), env.DB);
    sent.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const cronEnv = () => testEnvFor(env.DB, { REMINDER_QUEUE: queue });

  async function createTask(body: Record<string, unknown>): Promise<{ id: number }> {
    return (await (await api.post("/api/tasks", body)).json()) as { id: number };
  }

  async function subscribe(endpoint = "https://push.example.com/abc") {
    // Straight to D1: the subscribe route would also queue a confirmation push.
    const user = await env.DB.prepare("SELECT id FROM users WHERE email = 'test@example.com'").first<{ id: number }>();
    await env.DB.prepare("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, 'k', 'a')")
      .bind(user!.id, endpoint)
      .run();
  }

  it("fires a due reminder once, to every device, and records it on the bell", async () => {
    const task = await createTask({ title: "Call dentist", due_date: "2026-10-16", remind_at: "2026-10-16T13:00:00Z" });
    await subscribe("https://push.example.com/phone");
    await subscribe("https://push.example.com/laptop");

    expect(await runReminderCron(cronEnv(), new Date("2026-10-16T12:59:00Z"))).toBe(0);
    expect(await runReminderCron(cronEnv(), new Date("2026-10-16T13:00:30Z"))).toBe(1);
    // A doubled or later tick finds nothing left to claim.
    expect(await runReminderCron(cronEnv(), new Date("2026-10-16T13:01:00Z"))).toBe(0);

    expect(sent).toHaveLength(2);
    expect(sent.every((j) => j.taskId === task.id && j.title === "Call dentist")).toBe(true);

    const feed = (await (await api.get("/api/alerts")).json()) as AlertFeed;
    expect(feed.alerts).toHaveLength(1);
    expect(feed.alerts[0]).toMatchObject({ task_id: task.id, title: "Call dentist", body: "Due 2026-10-16." });
    expect(feed.unread).toBe(1);
  });

  it("records the alert even when nothing is subscribed", async () => {
    await createTask({ title: "x", remind_at: "2026-10-16T13:00:00Z" });
    await runReminderCron(cronEnv(), new Date("2026-10-16T13:05:00Z"));
    const feed = (await (await api.get("/api/alerts")).json()) as AlertFeed;
    expect(feed.alerts).toHaveLength(1);
    expect(sent).toHaveLength(0);
  });

  it("does not fire for a completed task", async () => {
    const task = await createTask({ title: "x", remind_at: "2026-10-16T13:00:00Z" });
    await api.post(`/api/tasks/${task.id}/complete`, {});
    expect(await runReminderCron(cronEnv(), new Date("2026-10-16T13:05:00Z"))).toBe(0);
  });

  it("re-arms on snooze and resolves the old alert", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T13:05:00Z"));
    const task = await createTask({ title: "x", remind_at: "2026-10-16T13:00:00Z" });
    await runReminderCron(cronEnv(), new Date());

    await api.post(`/api/tasks/${task.id}/snooze`, { minutes: 10 });
    // The snoozed-away reminder leaves the bell straight away.
    expect(((await (await api.get("/api/alerts")).json()) as AlertFeed).alerts).toHaveLength(0);

    expect(await runReminderCron(cronEnv(), new Date("2026-10-16T13:10:00Z"))).toBe(0);
    expect(await runReminderCron(cronEnv(), new Date("2026-10-16T13:15:00Z"))).toBe(1);
    expect(((await (await api.get("/api/alerts")).json()) as AlertFeed).alerts).toHaveLength(1);
  });

  it("takes the alert off the bell when the task is completed or deleted", async () => {
    const a = await createTask({ title: "a", remind_at: "2026-10-16T13:00:00Z" });
    const b = await createTask({ title: "b", remind_at: "2026-10-16T13:00:00Z" });
    await runReminderCron(cronEnv(), new Date("2026-10-16T13:05:00Z"));
    expect(((await (await api.get("/api/alerts")).json()) as AlertFeed).alerts).toHaveLength(2);

    await api.post(`/api/tasks/${a.id}/complete`, {});
    await api.delete(`/api/tasks/${b.id}`);
    expect(((await (await api.get("/api/alerts")).json()) as AlertFeed).alerts).toHaveLength(0);

    // Resolved, not deleted: the record of what fired is still there.
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM alerts WHERE resolved_at IS NOT NULL").first<{ n: number }>();
    expect(rows?.n).toBe(2);
  });

  it("skips delivery for a task completed after it was claimed", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const task = await createTask({ title: "x", remind_at: "2026-10-16T13:00:00Z" });
    await subscribe();
    await runReminderCron(cronEnv(), new Date("2026-10-16T13:05:00Z"));
    await api.post(`/api/tasks/${task.id}/complete`, {});

    await deliverReminder(testEnvFor(env.DB, { VAPID_PUBLIC_KEY: "x", VAPID_PRIVATE_KEY: "y", VAPID_SUBJECT: "mailto:a@b.c" }), sent[0]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("alerts feed", () => {
  let api: ReturnType<typeof testRequest>;

  beforeEach(async () => {
    await applyMigrations(env.DB);
    api = testRequest(createTestApp(), env.DB);
    await api.post("/api/tasks", { title: "x", remind_at: "2026-10-16T13:00:00Z" });
    await runReminderCron(testEnvFor(env.DB), new Date("2026-10-16T13:05:00Z"));
  });

  it("marks read, dismisses and restores, per user", async () => {
    const feed = (await (await api.get("/api/alerts")).json()) as AlertFeed & { alerts: { created_at: string }[] };
    const [alert] = feed.alerts;

    await api.post("/api/alerts/read", { up_to: alert.created_at });
    expect(((await (await api.get("/api/alerts")).json()) as AlertFeed).unread).toBe(0);

    await api.post(`/api/alerts/${alert.id}/dismiss`, {});
    expect(((await (await api.get("/api/alerts")).json()) as AlertFeed).alerts).toHaveLength(0);
    await api.post(`/api/alerts/${alert.id}/restore`, {});
    expect(((await (await api.get("/api/alerts")).json()) as AlertFeed).alerts).toHaveLength(1);

    const other = { "X-Test-Email": "someone@example.com" };
    expect(((await (await api.get("/api/alerts", other)).json()) as AlertFeed).alerts).toHaveLength(0);
    expect((await api.post(`/api/alerts/${alert.id}/dismiss`, {}, other)).status).toBe(404);
  });
});
