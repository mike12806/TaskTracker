/// <reference types="vite/client" />
import { Hono } from "hono";
import { env as testEnv } from "cloudflare:test";
import type { MiddlewareHandler } from "hono";
import type { AppEnv, Env } from "../src/types/env.js";
import { cacheControlMiddleware } from "../src/middleware/cacheControl.js";
import { auth } from "../src/routes/auth.js";
import { tasks } from "../src/routes/tasks.js";
import { lists } from "../src/routes/lists.js";
import { areas } from "../src/routes/areas.js";
import { settings } from "../src/routes/settings.js";
import { alerts } from "../src/routes/alerts.js";
import { push } from "../src/routes/push.js";
import { briefing } from "../src/routes/briefing.js";
import { live } from "../src/routes/live.js";
import migration0001 from "../migrations/0001_initial_schema.sql?raw";
import migration0002 from "../migrations/0002_add_areas.sql?raw";

/**
 * Auth middleware for tests — bypasses JWT verification. Upserts the user
 * named by `X-Test-Email`, same as the real middleware's result.
 */
const testAuthMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const email = c.req.header("X-Test-Email") || "test@example.com";
  const name = c.req.header("X-Test-Name") || "Test User";

  const user = await c.env.DB.prepare(
    "INSERT INTO users (email, name) VALUES (?, ?) ON CONFLICT(email) DO UPDATE SET name = excluded.name RETURNING id, email, name",
  )
    .bind(email, name)
    .first<{ id: number; email: string; name: string }>();
  if (!user) return c.json({ error: "Failed to resolve user" }, 500);

  c.set("userId", user.id);
  c.set("userEmail", user.email);
  c.set("userName", user.name);
  await next();
};

/** A test app with the same routes as production but the test auth middleware. */
export function createTestApp() {
  const app = new Hono<AppEnv>();
  app.use("/api/*", testAuthMiddleware);
  // Mounted between the middlewares exactly as in src/index.ts.
  app.route("/api/live", live);
  app.use("/api/*", cacheControlMiddleware);
  app.route("/api/auth", auth);
  app.route("/api/tasks", tasks);
  app.route("/api/lists", lists);
  app.route("/api/areas", areas);
  app.route("/api/settings", settings);
  app.route("/api/alerts", alerts);
  app.route("/api/push", push);
  app.route("/api/briefing", briefing);
  return app;
}

/** Run a multi-statement SQL script against D1, one statement at a time. */
export async function execScript(db: D1Database, script: string) {
  const statements = script
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.replace(/--[^\n]*/g, "").trim().length > 0);
  for (const sql of statements) {
    await db.prepare(sql).run();
  }
}

/**
 * Empty the KV cache namespace. Everything in KV is derived from D1, so
 * resetting one without the other leaves a copy of a world that no longer
 * exists — and it would be served.
 */
export async function resetCache(cache: KVNamespace = testEnv.CACHE) {
  if (!cache) return;
  const { keys } = await cache.list();
  await Promise.all(keys.map((key) => cache.delete(key.name)));
}

const TABLES = [
  "digest_runs",
  "daily_briefings",
  "alert_dismissals",
  "alert_reads",
  "alerts",
  "push_subscriptions",
  "client_requests",
  "tasks",
  "lists",
  "areas",
  "user_settings",
  "users",
];

/** Drop and recreate every table from the real migrations, and empty KV. */
export async function applyMigrations(db: D1Database) {
  const drop = TABLES.map((t) => `DROP TABLE IF EXISTS ${t};`).join("\n");
  await execScript(db, drop + "\n" + [migration0001, migration0002].join("\n"));
  await resetCache();
}

/** The env a request runs with. `LIVE` and the queues are absent unless asked for. */
export function testEnvFor(db: D1Database, extraEnv?: Partial<Env>): Env {
  return {
    DB: db,
    CF_ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com",
    CF_ACCESS_AUD: "test-aud",
    ...extraEnv,
  } as Env;
}

/** Helper to make requests to the test app. */
export function testRequest(app: ReturnType<typeof createTestApp>, db: D1Database, extraEnv?: Partial<Env>) {
  const env = testEnvFor(db, extraEnv);
  const json = (method: string) => (path: string, body?: unknown, headers?: Record<string, string>) =>
    app.request(
      path,
      {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: { "Content-Type": "application/json", ...headers },
      },
      env,
    );
  return {
    env,
    get: (path: string, headers?: Record<string, string>) => app.request(path, { method: "GET", headers }, env),
    post: json("POST"),
    put: json("PUT"),
    delete: (path: string, headers?: Record<string, string>) => app.request(path, { method: "DELETE", headers }, env),
  };
}

/** The id of the default test user, creating it if needed. */
export async function testUserId(db: D1Database, email = "test@example.com"): Promise<number> {
  const row = await db
    .prepare("INSERT INTO users (email, name) VALUES (?, 'Test User') ON CONFLICT(email) DO UPDATE SET name = name RETURNING id")
    .bind(email)
    .first<{ id: number }>();
  return row!.id;
}
