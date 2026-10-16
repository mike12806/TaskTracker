import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { createTestApp, applyMigrations, testRequest } from "./helpers";

describe("Auth API", () => {
  let api: ReturnType<typeof testRequest>;

  beforeEach(async () => {
    await applyMigrations(env.DB);
    api = testRequest(createTestApp(), env.DB);
  });

  it("GET /api/auth/me returns current user", async () => {
    const res = await api.get("/api/auth/me");
    expect(res.status).toBe(200);
    const user = (await res.json()) as Record<string, unknown>;
    expect(user.email).toBe("test@example.com");
    expect(user.name).toBe("Test User");
  });

  it("GET /api/auth/login redirects to the requested path", async () => {
    const res = await api.get("/api/auth/login?redirect=%2Flists%2F3%3Fq%3Dx");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/lists/3?q=x");
  });

  it("GET /api/auth/login rejects non-relative redirects", async () => {
    for (const bad of ["https://evil.com", "//evil.com", "/\\evil.com"]) {
      const res = await api.get(`/api/auth/login?redirect=${encodeURIComponent(bad)}`);
      expect(res.headers.get("Location")).toBe("/");
    }
  });
});

describe("Cache-Control", () => {
  it("marks API replies no-store", async () => {
    await applyMigrations(env.DB);
    const api = testRequest(createTestApp(), env.DB);
    for (const path of ["/api/tasks", "/api/lists", "/api/settings", "/api/tasks/999"]) {
      expect((await api.get(path)).headers.get("Cache-Control")).toBe("no-store");
    }
  });
});

describe("Settings API", () => {
  it("creates defaults and validates updates", async () => {
    await applyMigrations(env.DB);
    const api = testRequest(createTestApp(), env.DB);
    const initial = (await (await api.get("/api/settings")).json()) as Record<string, unknown>;
    expect(initial).toMatchObject({ timezone: "America/New_York", digest_hour: 7, email_digest: 0 });

    expect((await api.put("/api/settings", { timezone: "Mars/Olympus" })).status).toBe(400);
    expect((await api.put("/api/settings", { digest_hour: 24 })).status).toBe(400);
    const updated = (await (await api.put("/api/settings", { timezone: "Europe/Paris", email_digest: true })).json()) as Record<string, unknown>;
    expect(updated).toMatchObject({ timezone: "Europe/Paris", email_digest: 1 });
  });
});
