import { Hono } from "hono";
import type { Env } from "../types/env.js";

type AppEnv = { Bindings: Env; Variables: { userId: number; userEmail: string; userName: string } };

const auth = new Hono<AppEnv>();

// GET /api/auth/me — return current user (identity set by auth middleware)
auth.get("/me", (c) => {
  return c.json({
    id: c.get("userId"),
    email: c.get("userEmail"),
    name: c.get("userName"),
  });
});

// GET /api/auth/login — protected navigation target used to force a fresh
// Cloudflare Access login. The PWA's service worker answers normal
// navigations with cached HTML, so the client re-auths by navigating here
// (/api/* bypasses the SW); Access runs its login flow at the edge, then
// this handler bounces back into the app.
auth.get("/login", (c) => {
  const redirect = c.req.query("redirect") || "/";
  // Same-origin paths only — reject protocol-relative (//host) redirects
  const safe = /^\/(?![/\\])/.test(redirect) ? redirect : "/";
  return c.redirect(safe);
});

export { auth };
