# TaskTracker

A personal task and reminder PWA for one user on several devices. Its
infrastructure is deliberately modeled on BabyTracker
(`mike12806/BabyTracker`): when a pattern here looks over-engineered for a
to-do app, it is usually one BabyTracker learned the hard way — check there
before simplifying it away.

## Project Overview

Monorepo, two packages:

- `client/` — React + Vite + MUI PWA, deployed to Cloudflare Pages at `tasks.mfaherty.net`
- `server/` — Hono Worker on `tasks.mfaherty.net/api/*`, backed by D1

## Architecture

- **Auth**: Cloudflare Access in front of both. The Worker validates `Cf-Access-Jwt-Assertion` (or the `CF_Authorization` cookie), and auto-creates a `users` row from the JWT email. Access must stay a **hostname-based (self-hosted) application** — a Worker-level policy rejects WebSocket upgrades and takes live updates out. Every query is still scoped by `user_id` even though only one identity is allowed in.
- **Database**: D1, the source of truth for everything. Migrations in `server/migrations/`, applied by `deploy-server.yml` before every deploy — merging the file *is* shipping it.
- **Read cache**: KV (`CACHE`), never a source of truth. The rule is "is an answer up to a minute old still correct" — so the Access JWKS, the `users` row and the daily briefing qualify; **tasks, lists and settings never do**. Optional binding; every helper degrades to a miss.
- **Reminders**: the every-minute cron (`scheduled/reminders.ts`) claims due tasks with a single `UPDATE … SET reminded_at = remind_at … RETURNING`. That statement is the idempotency guard: a reminder fires once per `remind_at` value, and snoozing (moving `remind_at`) is the only way to re-arm it. The alert row is written at the claim, before any push is queued; pushes go one job per device on `task-tracker-reminders`, and the consumer re-checks the task is still open.
- **Alerts feed**: `alerts` is the record behind the pushes — written even with no subscribed device, resolved (never deleted) when the task is completed, snoozed, deleted, or has its reminder moved. Dismissals hide, per user, with an undo. Notifications are tagged `reminder:<task id>`; the client closes any whose alert is no longer open.
- **Domain events**: every task write emits `task.*` with identity only (`userId`, `taskId`), never the row. Subscribers live in `events/subscribers.ts` and must be idempotent. The live nudge (`announceChange`) stays inline, never on the bus.
- **Live updates**: one Durable Object per user (`user:<id>`), hibernating WebSockets. What crosses the socket is a nudge with no data; the client refetches over `/api/*`. Optional; the client polls without it.
- **Recurrence**: completing a recurring task spawns the successor in the same `D1.batch()`. The unique index on `recurred_from_id` makes completion idempotent. Calendar arithmetic is timezone-aware and lives in `server/src/time.ts` only.
- **Briefing and digest**: the hourly cron checks each user's timezone and digest hour, claims the day in `digest_runs`, writes a template briefing, and queues the AI call (and the email, if opted in). Figures are computed in SQL; the model only writes prose around them and can never invent a number.
- **Offline writes**: task creates that can't reach the server are queued on the device (`client/src/api/outbox.ts`) with their `client_request_id`, so a replay is deduplicated. Only creates are queued.

## Domain Model

- **Task** — title, notes, priority (none/low/medium/high), `due_date` (local calendar date) and optional `due_time`, `remind_at` (UTC instant), recurrence + interval, completed/completed_at, list
- **Area** — the level above lists (Personal, Work, …). Every list and every task has one: a task in a list is in the list's area (the server enforces it — `placeTask` in `routes/tasks.ts`), a task with no list is in that area's Inbox. Moving a list moves its tasks; deleting an area moves its contents to another; the last area can't be deleted. Which area the app shows is a per-device view filter (`hooks/useAreas.tsx`, localStorage), never a server setting, and reminders fire for every area
- **List** — name, colour, position, area. Deleting a list moves its tasks to its area's Inbox (`list_id IS NULL`, `area_id` kept)
- **Settings** — theme, timezone (kept in step with the device by the client), digest hour, email digest on/off, default reminder time
- **Alert**, **push subscription**, **daily briefing** — as above

## Code Style

- TypeScript everywhere, ES modules, strict mode, `const` over `let`, never `var`
- Match the surrounding comment density: comments explain *why*, especially where a simpler-looking alternative was tried and failed

## Conventions

- REST under `/api/`; ISO 8601 for instants, `YYYY-MM-DD` / `HH:MM` for local dates and times
- D1 queries use prepared statements with bound parameters — never interpolate user input
- POST creates accept an optional `client_request_id` and deduplicate on it via `insertOnce`. Any new create route must support it
- Multi-row writes use `D1.batch()` so they cannot half-apply
- Every route scopes by `c.get("userId")`. A row that isn't the caller's is a 404, indistinguishable from a missing one
- Bindings come from `Env`, never `process.env`. Everything except `DB` is optional and must degrade

## Build and Test

- `npm install` at the root (workspaces)
- `npm test` — server tests run in the Workers pool against real Miniflare D1/KV/Durable Objects; client tests run in jsdom
- `npm run build:client`, `npm run build:server` (a `wrangler deploy --dry-run`)
- Never deploy by hand; merge to `main`

## Database

- Plain SQL migrations, numbered, in `server/migrations/`; no semicolons inside comments (the test helper splits on them)
- `INTEGER` 0/1 for booleans, ISO 8601 text timestamps at second precision, `created_at`/`updated_at` on every table
- Adding a queue means adding it to the `Create queues` step in `deploy-server.yml`

## KV

- Keys in `server/src/kv/keys.ts`, all behind `KV_SCHEMA_VERSION`; TTLs in `ttl.ts`, each documented by how long the value may be wrong for
- KV migrations run *after* the deploy (`scripts/kv-migrate.mjs`) and must be safe to re-run
