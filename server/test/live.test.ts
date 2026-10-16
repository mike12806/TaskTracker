import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { createTestApp, applyMigrations, testRequest } from "./helpers";
import { LIVE_CLIENT_HEADER } from "../src/live";
import type { LiveMessage } from "../src/live";
import type { Env } from "../src/types/env.js";

/** Open a live socket through the real app — auth, route, Durable Object. */
async function openSocket(api: ReturnType<typeof testRequest>, clientId: string, headers: Record<string, string> = {}) {
  const res = await api.get(`/api/live?client=${clientId}`, { Upgrade: "websocket", ...headers });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  const messages: LiveMessage[] = [];
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => (markReady = resolve));
  ws.addEventListener("message", (event: MessageEvent) => {
    const parsed = JSON.parse(event.data as string) as LiveMessage;
    messages.push(parsed);
    if (parsed.type === "ready") markReady();
  });
  ws.accept();
  await ready;
  return { messages, close: () => ws.close() };
}

async function changesWithin(messages: LiveMessage[], timeoutMs = 300): Promise<LiveMessage[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const changes = messages.filter((m) => m.type === "change");
    if (changes.length > 0) return changes;
    await scheduler.wait(10);
  }
  return [];
}

describe("live updates", () => {
  let api: ReturnType<typeof testRequest>;

  beforeEach(async () => {
    await applyMigrations(env.DB);
    api = testRequest(createTestApp(), env.DB, { LIVE: (env as unknown as Env).LIVE });
  });

  it("nudges the user's other devices, not the one that saved", async () => {
    const phone = await openSocket(api, "phone");
    const laptop = await openSocket(api, "laptop");

    await api.post("/api/tasks", { title: "x" }, { [LIVE_CLIENT_HEADER]: "phone" });

    const onLaptop = await changesWithin(laptop.messages);
    expect(onLaptop).toHaveLength(1);
    expect(onLaptop[0]).toMatchObject({ type: "change", kind: "tasks" });
    expect(await changesWithin(phone.messages)).toHaveLength(0);
    phone.close();
    laptop.close();
  });

  it("keeps one user's changes off another user's socket", async () => {
    const someoneElse = await openSocket(api, "other", { "X-Test-Email": "someone@example.com" });
    await api.post("/api/tasks", { title: "x" });
    expect(await changesWithin(someoneElse.messages)).toHaveLength(0);
    someoneElse.close();
  });

  it("refuses a plain GET", async () => {
    expect((await api.get("/api/live")).status).toBe(426);
  });
});
