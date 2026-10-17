/// <reference types="vite/client" />
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { createTestApp, applyMigrations, testRequest, execScript } from "./helpers";
import migration0001 from "../migrations/0001_initial_schema.sql?raw";
import migration0002 from "../migrations/0002_add_areas.sql?raw";

interface Area {
  id: number;
  name: string;
}
interface Task {
  id: number;
  list_id: number | null;
  area_id: number;
}

describe("Areas", () => {
  let api: ReturnType<typeof testRequest>;
  let personal: Area;
  let work: Area;

  beforeEach(async () => {
    await applyMigrations(env.DB);
    api = testRequest(createTestApp(), env.DB);
    [personal, work] = (await (await api.get("/api/areas")).json()) as Area[];
  });

  const task = async (body: Record<string, unknown>) => {
    const res = await api.post("/api/tasks", { title: "t", ...body });
    return { status: res.status, task: (await res.json()) as Task };
  };
  const list = async (body: Record<string, unknown>) =>
    (await (await api.post("/api/lists", { name: "L", ...body })).json()) as { id: number; area_id: number };

  it("gives a new user Personal and Work", () => {
    expect([personal.name, work.name]).toEqual(["Personal", "Work"]);
  });

  it("puts a task in its list's area, or the requested area's Inbox", async () => {
    const q4 = await list({ name: "Q4", area_id: work.id });
    expect((await task({ list_id: q4.id })).task.area_id).toBe(work.id);
    expect((await task({ area_id: work.id })).task).toMatchObject({ list_id: null, area_id: work.id });
    // Nothing said: the first area.
    expect((await task({})).task.area_id).toBe(personal.id);
  });

  it("refuses a list and an area that disagree", async () => {
    const q4 = await list({ area_id: work.id });
    expect((await task({ list_id: q4.id, area_id: personal.id })).status).toBe(400);
  });

  it("moves a task to another area's Inbox when only the area changes", async () => {
    const home = await list({ area_id: personal.id });
    const { task: t } = await task({ list_id: home.id });
    const moved = (await (await api.put(`/api/tasks/${t.id}`, { area_id: work.id })).json()) as Task;
    expect(moved).toMatchObject({ list_id: null, area_id: work.id });
  });

  it("moves a list's tasks when the list changes area", async () => {
    const l = await list({ area_id: personal.id });
    const { task: t } = await task({ list_id: l.id });
    await api.put(`/api/lists/${l.id}`, { area_id: work.id });
    expect(((await (await api.get(`/api/tasks/${t.id}`)).json()) as Task).area_id).toBe(work.id);
  });

  it("counts each area's Inbox separately", async () => {
    await task({ area_id: personal.id });
    await task({ area_id: work.id });
    await task({ area_id: work.id });
    const res = (await (await api.get("/api/lists")).json()) as { inbox_count: number; inbox_counts: Record<string, number> };
    expect(res.inbox_counts).toEqual({ [personal.id]: 1, [work.id]: 2 });
    expect(res.inbox_count).toBe(3);
  });

  it("filters tasks by area", async () => {
    await task({ area_id: personal.id });
    const { task: w } = await task({ area_id: work.id });
    const rows = (await (await api.get(`/api/tasks?area_id=${work.id}`)).json()) as Task[];
    expect(rows.map((r) => r.id)).toEqual([w.id]);
  });

  it("keeps a recurring task's area on its next occurrence", async () => {
    const { task: t } = await task({ area_id: work.id, due_date: "2026-10-16", recurrence: "daily" });
    const done = (await (await api.post(`/api/tasks/${t.id}/complete`, {})).json()) as { next: Task };
    expect(done.next.area_id).toBe(work.id);
  });

  it("moves everything to another area when one is deleted, and keeps the last one", async () => {
    const extra = (await (await api.post("/api/areas", { name: "Side projects" })).json()) as Area;
    const l = await list({ area_id: extra.id });
    const { task: t } = await task({ list_id: l.id });

    const res = await api.delete(`/api/areas/${extra.id}?move_to=${work.id}`);
    expect(res.status).toBe(200);
    expect(((await (await api.get(`/api/tasks/${t.id}`)).json()) as Task).area_id).toBe(work.id);

    await api.delete(`/api/areas/${work.id}`);
    expect((await api.delete(`/api/areas/${personal.id}`)).status).toBe(400);
  });

  it("keeps areas to their user", async () => {
    const other = { "X-Test-Email": "someone@example.com" };
    expect((await api.put(`/api/areas/${work.id}`, { name: "Mine now" }, other)).status).toBe(404);
    expect((await api.post("/api/tasks", { title: "x", area_id: work.id }, other)).status).toBe(404);
  });
});

describe("migration 0002", () => {
  it("puts existing lists and tasks in Personal", async () => {
    const tables = ["areas", "digest_runs", "daily_briefings", "alert_dismissals", "alert_reads", "alerts",
      "push_subscriptions", "client_requests", "tasks", "lists", "user_settings", "users"];
    await execScript(env.DB, tables.map((t) => `DROP TABLE IF EXISTS ${t};`).join("\n") + migration0001);
    await env.DB.prepare("INSERT INTO users (email, name) VALUES ('a@example.com', 'A')").run();
    await env.DB.prepare("INSERT INTO lists (user_id, name) VALUES (1, 'Old list')").run();
    await env.DB.prepare("INSERT INTO tasks (user_id, list_id, title) VALUES (1, 1, 'In a list'), (1, NULL, 'In the Inbox')").run();

    await execScript(env.DB, migration0002);

    const areas = (await env.DB.prepare("SELECT id, name FROM areas ORDER BY position").all<{ id: number; name: string }>()).results;
    expect(areas.map((a) => a.name)).toEqual(["Personal", "Work"]);
    const missing = await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM lists WHERE area_id IS NOT ?) + (SELECT COUNT(*) FROM tasks WHERE area_id IS NOT ?) AS n",
    ).bind(areas[0].id, areas[0].id).first<{ n: number }>();
    expect(missing?.n).toBe(0);
  });
});
