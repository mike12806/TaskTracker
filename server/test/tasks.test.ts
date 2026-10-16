import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { createTestApp, applyMigrations, testRequest } from "./helpers";
import { nextOccurrenceOf } from "../src/routes/tasks.js";

interface Task {
  id: number;
  title: string;
  list_id: number | null;
  due_date: string | null;
  due_time: string | null;
  remind_at: string | null;
  priority: string;
  recurrence: string;
  completed: number;
  completed_at: string | null;
  recurred_from_id: number | null;
}

describe("Tasks API", () => {
  let api: ReturnType<typeof testRequest>;

  beforeEach(async () => {
    await applyMigrations(env.DB);
    api = testRequest(createTestApp(), env.DB);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function create(body: Record<string, unknown>, headers?: Record<string, string>): Promise<Task> {
    const res = await api.post("/api/tasks", body, headers);
    expect(res.status).toBe(201);
    return (await res.json()) as Task;
  }

  it("creates, reads, edits and deletes a task", async () => {
    const task = await create({ title: "  Renew passport  ", priority: "high", due_date: "2026-11-01" });
    expect(task.title).toBe("Renew passport");
    expect(task.priority).toBe("high");

    const edited = (await (await api.put(`/api/tasks/${task.id}`, { notes: "Photos first", due_time: "10:30" })).json()) as Task & { notes: string };
    expect(edited.notes).toBe("Photos first");
    expect(edited.due_time).toBe("10:30");

    expect((await api.delete(`/api/tasks/${task.id}`)).status).toBe(200);
    expect((await api.get(`/api/tasks/${task.id}`)).status).toBe(404);
  });

  it("validates the body", async () => {
    expect((await api.post("/api/tasks", { title: "" })).status).toBe(400);
    expect((await api.post("/api/tasks", { title: "x", priority: "urgent" })).status).toBe(400);
    expect((await api.post("/api/tasks", { title: "x", due_date: "2026-13-01" })).status).toBe(400);
    expect((await api.post("/api/tasks", { title: "x", due_time: "09:00", due_date: null })).status).toBe(400);
    expect((await api.post("/api/tasks", { title: "x", recurrence: "hourly" })).status).toBe(400);
    expect((await api.post("/api/tasks", { title: "x", remind_at: "tomorrow" })).status).toBe(400);
  });

  it("stores reminders at second precision", async () => {
    const task = await create({ title: "x", remind_at: "2026-10-16T13:00:00.123Z" });
    expect(task.remind_at).toBe("2026-10-16T13:00:00Z");
  });

  it("clears the due time with the due date", async () => {
    const task = await create({ title: "x", due_date: "2026-11-01", due_time: "09:00" });
    const edited = (await (await api.put(`/api/tasks/${task.id}`, { due_date: null })).json()) as Task;
    expect(edited.due_date).toBeNull();
    expect(edited.due_time).toBeNull();
  });

  it("deduplicates a replayed create on client_request_id", async () => {
    const first = await api.post("/api/tasks", { title: "Once", client_request_id: "abc" });
    const second = await api.post("/api/tasks", { title: "Once", client_request_id: "abc" });
    expect(((await first.json()) as Task).id).toBe(((await second.json()) as Task).id);
    const open = (await (await api.get("/api/tasks")).json()) as Task[];
    expect(open).toHaveLength(1);
  });

  it("keeps each user's tasks to themselves", async () => {
    const mine = await create({ title: "Mine" });
    const other = { "X-Test-Email": "someone@example.com" };
    expect((await api.get(`/api/tasks/${mine.id}`, other)).status).toBe(404);
    expect((await api.put(`/api/tasks/${mine.id}`, { title: "Theirs" }, other)).status).toBe(404);
    expect((await api.post(`/api/tasks/${mine.id}/complete`, {}, other)).status).toBe(404);
    expect(await (await api.get("/api/tasks", other)).json()).toEqual([]);
  });

  it("refuses a list that is not the caller's", async () => {
    const list = (await (await api.post("/api/lists", { name: "Work" })).json()) as { id: number };
    const res = await api.post("/api/tasks", { title: "x", list_id: list.id }, { "X-Test-Email": "someone@example.com" });
    expect(res.status).toBe(404);
  });

  it("sorts open tasks dated first, then by time and priority", async () => {
    await create({ title: "undated" });
    await create({ title: "later", due_date: "2026-11-02" });
    await create({ title: "low", due_date: "2026-11-01", priority: "low" });
    await create({ title: "high", due_date: "2026-11-01", priority: "high" });
    await create({ title: "timed", due_date: "2026-11-01", due_time: "08:00" });
    const titles = ((await (await api.get("/api/tasks")).json()) as Task[]).map((t) => t.title);
    expect(titles).toEqual(["timed", "high", "low", "later", "undated"]);
  });

  it("searches titles and notes, treating wildcards literally", async () => {
    await create({ title: "Call the bank", notes: "about 100% refund" });
    await create({ title: "Groceries" });
    const byTitle = (await (await api.get("/api/tasks?q=bank")).json()) as Task[];
    expect(byTitle.map((t) => t.title)).toEqual(["Call the bank"]);
    const literal = (await (await api.get("/api/tasks?q=" + encodeURIComponent("100%"))).json()) as Task[];
    expect(literal).toHaveLength(1);
    const wildcard = (await (await api.get("/api/tasks?q=" + encodeURIComponent("%"))).json()) as Task[];
    expect(wildcard).toHaveLength(1);
  });

  it("completes and reopens a one-off task", async () => {
    const task = await create({ title: "x" });
    const done = (await (await api.post(`/api/tasks/${task.id}/complete`, {})).json()) as { task: Task; next: Task | null };
    expect(done.task.completed).toBe(1);
    expect(done.next).toBeNull();
    expect(await (await api.get("/api/tasks")).json()).toEqual([]);
    const completed = (await (await api.get("/api/tasks?status=completed")).json()) as Task[];
    expect(completed.map((t) => t.id)).toEqual([task.id]);

    const reopened = (await (await api.post(`/api/tasks/${task.id}/reopen`, {})).json()) as Task;
    expect(reopened.completed).toBe(0);
    expect(reopened.completed_at).toBeNull();
  });

  it("spawns exactly one next occurrence however often a recurring task is completed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T14:00:00Z"));
    const task = await create({
      title: "Water plants",
      due_date: "2026-10-16",
      due_time: "09:00",
      remind_at: "2026-10-16T13:00:00Z",
      recurrence: "weekly",
    });

    const first = (await (await api.post(`/api/tasks/${task.id}/complete`, {})).json()) as { next: Task };
    expect(first.next.due_date).toBe("2026-10-23");
    expect(first.next.remind_at).toBe("2026-10-23T13:00:00Z");
    expect(first.next.recurred_from_id).toBe(task.id);

    // Double tap, then undo and redo: still one successor.
    await api.post(`/api/tasks/${task.id}/complete`, {});
    await api.post(`/api/tasks/${task.id}/reopen`, {});
    await api.post(`/api/tasks/${task.id}/complete`, {});

    const { results } = await env.DB.prepare("SELECT id FROM tasks WHERE recurred_from_id = ?").bind(task.id).all();
    expect(results).toHaveLength(1);
  });

  it("snoozes a task's reminder", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T14:00:00Z"));
    const task = await create({ title: "x", remind_at: "2026-10-16T13:00:00Z" });

    const snoozed = (await (await api.post(`/api/tasks/${task.id}/snooze`, {})).json()) as Task;
    expect(snoozed.remind_at).toBe("2026-10-16T14:10:00Z");
    const hour = (await (await api.post(`/api/tasks/${task.id}/snooze`, { minutes: 60 })).json()) as Task;
    expect(hour.remind_at).toBe("2026-10-16T15:00:00Z");

    expect((await api.post(`/api/tasks/${task.id}/snooze`, { minutes: 0 })).status).toBe(400);
    expect((await api.post(`/api/tasks/${task.id}/snooze`, { until: "2026-10-16T13:00:00Z" })).status).toBe(400);
  });

  it("moves a deleted list's tasks to the Inbox", async () => {
    const list = (await (await api.post("/api/lists", { name: "Errands" })).json()) as { id: number };
    const task = await create({ title: "Post office", list_id: list.id });
    expect((await api.delete(`/api/lists/${list.id}`)).status).toBe(200);
    const after = (await (await api.get(`/api/tasks/${task.id}`)).json()) as Task;
    expect(after.list_id).toBeNull();
    const inbox = (await (await api.get("/api/tasks?list_id=inbox")).json()) as Task[];
    expect(inbox.map((t) => t.id)).toEqual([task.id]);
  });

  it("counts open tasks per list", async () => {
    const list = (await (await api.post("/api/lists", { name: "Home" })).json()) as { id: number };
    await create({ title: "a", list_id: list.id });
    await create({ title: "b" });
    const res = (await (await api.get("/api/lists")).json()) as { lists: { open_count: number }[]; inbox_count: number };
    expect(res.lists[0].open_count).toBe(1);
    expect(res.inbox_count).toBe(1);
  });
});

describe("nextOccurrenceOf", () => {
  const NY = "America/New_York";

  it("skips past today for an overdue daily task", () => {
    const next = nextOccurrenceOf(
      { due_date: "2026-10-10", remind_at: "2026-10-10T13:00:00Z", recurrence: "daily", recurrence_interval: 1 },
      NY,
      new Date("2026-10-16T14:00:00Z"),
    );
    expect(next).toEqual({ due_date: "2026-10-17", remind_at: "2026-10-17T13:00:00Z" });
  });

  it("anchors an undated recurring task on its reminder", () => {
    const next = nextOccurrenceOf(
      { due_date: null, remind_at: "2026-10-16T12:00:00Z", recurrence: "daily", recurrence_interval: 1 },
      NY,
      new Date("2026-10-16T14:00:00Z"),
    );
    expect(next).toEqual({ due_date: "2026-10-17", remind_at: "2026-10-17T12:00:00Z" });
  });

  it("returns null for a one-off task", () => {
    expect(
      nextOccurrenceOf({ due_date: "2026-10-10", remind_at: null, recurrence: "none", recurrence_interval: 1 }, NY),
    ).toBeNull();
  });
});
