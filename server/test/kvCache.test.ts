/// <reference types="vite/client" />
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { env } from "cloudflare:test";
import { cached, cacheDelete, cacheGet, cachePut, MIN_TTL_SECONDS } from "../src/kv/cache.js";
import {
  KV_SCHEMA_VERSION,
  KV_PREFIX,
  MIGRATION_KEY_PREFIX,
  briefingKey,
  jwksKey,
  userKey,
} from "../src/kv/keys.js";
import { authMiddleware } from "../src/middleware/auth.js";
import { storeBriefing } from "../src/scheduled/briefing.js";
import { applyMigrations, createTestApp, resetCache, testRequest, testUserId } from "./helpers";
import type { Env } from "../src/types/env.js";
import keysSource from "../src/kv/keys.ts?raw";
import migrationRunnerSource from "../scripts/kv-migrate.mjs?raw";

type TestEnv = typeof env & Env;

// ── The cache primitives ─────────────────────────────────────────────────────

describe("kv/cache", () => {
  beforeEach(() => resetCache());

  it("runs the loader once and serves the second read from KV", async () => {
    const load = vi.fn(async () => ({ answer: 42 }));

    expect(await cached(env as TestEnv, "test:hit", 60, load)).toEqual({ answer: 42 });
    expect(await cached(env as TestEnv, "test:hit", 60, load)).toEqual({ answer: 42 });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("caches null, so a legitimately empty answer is not re-read every time", async () => {
    const load = vi.fn(async () => null);

    expect(await cached(env as TestEnv, "test:null", 60, load)).toBeNull();
    expect(await cached(env as TestEnv, "test:null", 60, load)).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("sends the next read back to the loader once the key is dropped", async () => {
    const load = vi.fn(async () => "first");
    await cached(env as TestEnv, "test:drop", 60, load);

    await cacheDelete(env as TestEnv, "test:drop");

    load.mockResolvedValue("second");
    expect(await cached(env as TestEnv, "test:drop", 60, load)).toBe("second");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("reads through on every call when there is no binding at all", async () => {
    const load = vi.fn(async () => "uncached");
    const noKv = { ...env, CACHE: undefined } as unknown as Env;

    await cached(noKv, "test:absent", 60, load);
    await cached(noKv, "test:absent", 60, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("degrades to the loader when KV itself throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      ...env,
      CACHE: {
        get: async () => {
          throw new Error("KV unavailable");
        },
        put: async () => {
          throw new Error("KV unavailable");
        },
        delete: async () => {
          throw new Error("KV unavailable");
        },
      },
    } as unknown as Env;

    expect(await cached(broken, "test:broken", 60, async () => "from d1")).toBe("from d1");
    // And the write-back failure is swallowed rather than surfacing to the caller.
    await expect(cacheDelete(broken, "test:broken")).resolves.toBeUndefined();
  });

  it("treats a value that is not an envelope as a miss", async () => {
    await env.CACHE.put("test:corrupt", JSON.stringify("bare string"));
    expect(await cacheGet(env as TestEnv, "test:corrupt")).toBeUndefined();
  });

  it("clamps a TTL below KV's 60-second floor rather than failing the write", async () => {
    // KV rejects expirationTtl < 60 outright, so an un-clamped 5 would mean no
    // cache at all — silently, since cachePut swallows its errors.
    await cachePut(env as TestEnv, "test:ttl", "value", 5);
    expect(await cacheGet(env as TestEnv, "test:ttl")).toBe("value");
    expect(MIN_TTL_SECONDS).toBe(60);
  });
});

// ── Key layout ───────────────────────────────────────────────────────────────

describe("kv/keys", () => {
  it("puts every cache key behind the schema version", () => {
    for (const key of [jwksKey(), userKey("a@b.com"), briefingKey(1)]) {
      expect(key.startsWith(KV_PREFIX)).toBe(true);
      expect(key.startsWith(`v${KV_SCHEMA_VERSION}:`)).toBe(true);
    }
  });

  it("keeps the migration ledger outside the versioned prefix", () => {
    // A bump that abandoned the ledger would re-run every migration ever
    // written, including the sweeps that clean up after the bump itself.
    expect(MIGRATION_KEY_PREFIX.startsWith(KV_PREFIX)).toBe(false);
    expect(/^v\d+:/.test(MIGRATION_KEY_PREFIX)).toBe(false);
  });

  it("keys a user by their email exactly as D1 stores it", () => {
    // `users.email` is case-sensitive in SQLite, so two casings are two rows.
    // Folding them into one cache key would make the cache partition
    // differently from the table it stands in for.
    expect(userKey("Me@Example.com")).not.toBe(userKey("me@example.com"));
    expect(userKey("me@example.com")).toBe(`${KV_PREFIX}user:me@example.com`);
  });

  it("declares the version in the form the migration runner reads it back", () => {
    // scripts/kv-migrate.mjs reads KV_SCHEMA_VERSION out of this file as text
    // rather than importing it, so the two have to agree on the shape of the
    // declaration. This is that agreement, written down.
    const pattern = /export const KV_SCHEMA_VERSION\s*=\s*(\d+)/;
    expect(migrationRunnerSource).toContain("export const KV_SCHEMA_VERSION");
    expect(keysSource.match(pattern)?.[1]).toBe(String(KV_SCHEMA_VERSION));
  });
});

// ── Identity resolution ──────────────────────────────────────────────────────

describe("auth middleware identity cache", () => {
  beforeEach(() => applyMigrations(env.DB));

  /** The real middleware, on its DEV_MODE path so no JWT is needed. */
  function devApp() {
    const app = new Hono<{ Bindings: Env; Variables: { userId: number; userName: string } }>();
    app.use("/api/*", authMiddleware);
    app.get("/api/whoami", (c) => c.json({ id: c.get("userId"), name: c.get("userName") }));
    return app;
  }

  const devEnv = () => ({ ...env, DEV_MODE: "true" }) as unknown as Env;

  it("caches the resolved user after the first request", async () => {
    const app = devApp();
    await app.request("/api/whoami", { headers: { "X-Dev-Email": "a@example.com" } }, devEnv());

    const cachedUser = await cacheGet<{ email: string }>(env as TestEnv, userKey("a@example.com"));
    expect(cachedUser?.email).toBe("a@example.com");
  });

  it("serves the cached row without touching D1", async () => {
    // Nothing has ever inserted this user, so an id coming back at all proves
    // the read went to KV and not to the users table.
    await cachePut(
      env as TestEnv,
      userKey("ghost@example.com"),
      { id: 4242, email: "ghost@example.com", name: "Ghost" },
      60,
    );

    const res = await app_request("ghost@example.com", "Ghost");
    expect(await res.json()).toEqual({ id: 4242, name: "Ghost" });

    const row = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
      .bind("ghost@example.com")
      .first();
    expect(row).toBeNull();
  });

  it("busts the cache when the name in the identity changes", async () => {
    await app_request("b@example.com", "Old Name");
    const res = await app_request("b@example.com", "New Name");
    expect((await res.json() as { name: string }).name).toBe("New Name");

    const row = await env.DB.prepare("SELECT name FROM users WHERE email = ?")
      .bind("b@example.com")
      .first<{ name: string }>();
    expect(row?.name).toBe("New Name");
  });

  it("still auto-creates a user nobody has seen before", async () => {
    await app_request("fresh@example.com", "Fresh");
    const row = await env.DB.prepare("SELECT name FROM users WHERE email = ?")
      .bind("fresh@example.com")
      .first<{ name: string }>();
    expect(row?.name).toBe("Fresh");
  });

  async function app_request(email: string, name: string) {
    const app = devApp();
    return app.request(
      "/api/whoami",
      { headers: { "X-Dev-Email": email, "X-Dev-Name": name } },
      devEnv(),
    );
  }
});

// ── Daily briefing ───────────────────────────────────────────────────────────

describe("briefing cache", () => {
  let api: ReturnType<typeof testRequest>;
  let userId: number;

  beforeEach(async () => {
    await applyMigrations(env.DB);
    api = testRequest(createTestApp(), env.DB, { CACHE: env.CACHE });
    userId = await testUserId(env.DB);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

  it("caches the absence of a briefing", async () => {
    expect(await (await api.get("/api/briefing")).json()).toEqual({ briefing: null });
    expect(await cacheGet(env as TestEnv, briefingKey(userId))).toBeNull();

    // Written straight to D1, so nothing invalidated the cached `null`.
    await env.DB.prepare("INSERT INTO daily_briefings (user_id, date, body, source) VALUES (?, ?, 'Hi.', 'ai')")
      .bind(userId, today())
      .run();
    expect(await (await api.get("/api/briefing")).json()).toEqual({ briefing: null });
  });

  it("drops the cached briefing when a new one is stored", async () => {
    await api.get("/api/briefing");
    await storeBriefing({ ...env, CACHE: env.CACHE } as unknown as Env, userId, today(), {
      body: "Two tasks due today.",
      source: "fallback",
    });
    const body = (await (await api.get("/api/briefing")).json()) as { briefing: { body: string } | null };
    expect(body.briefing?.body).toBe("Two tasks due today.");
  });

  it("applies the date check to the cached row rather than freezing it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T14:00:00.000Z"));
    await env.DB.prepare("INSERT INTO daily_briefings (user_id, date, body, source) VALUES (?, '2026-06-01', 'Hi.', 'ai')")
      .bind(userId)
      .run();
    const fresh = (await (await api.get("/api/briefing")).json()) as { briefing: { body: string } | null };
    expect(fresh.briefing?.body).toBe("Hi.");

    // Same cached row the next day: yesterday's briefing is not today's.
    vi.setSystemTime(new Date("2026-06-02T14:00:00.000Z"));
    expect(await (await api.get("/api/briefing")).json()).toEqual({ briefing: null });
    expect(await cacheGet(env as TestEnv, briefingKey(userId))).not.toBeNull();
  });
});
