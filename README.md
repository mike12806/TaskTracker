# Tasks

A personal task and reminder PWA, built for Cloudflare's edge platform. One user,
many devices: the phone it's installed on, and whatever laptop is open.

Its infrastructure and capabilities are modeled on
[BabyTracker](https://github.com/mike12806/BabyTracker) — same stack, same
deploy pipeline, and the same rules about stale data, offline writes and push.

## Features

- **Tasks** with notes, priority, a due date and optional time, and a list
  (or the Inbox)
- **Views** — Today (overdue + due today), Upcoming (grouped by day), Inbox, each
  list, All, Completed, and Search
- **Reminders** — a push notification at the minute a task's reminder comes due,
  with **Done** and **Snooze** buttons right on the notification (where the
  platform shows them; iOS opens the task instead)
- **Recurring tasks** — daily, weekdays, weekly, monthly, yearly, with an
  interval. Completing one schedules the next; the reminder keeps its local
  time across DST changes
- **Quick add** — type and press Enter. `!high`/`!m`/`!3` set priority,
  `@today`/`@tomorrow`/`@fri`/`@next-week` set the due date
- **In-app alerts** — the bell lists every reminder that fired, so one that was
  swiped away or never reached this device is still there. Completing,
  snoozing or deleting the task takes it off the bell *and* off the lock screen
- **Daily briefing** — two sentences on the Today page each morning about what
  the day holds, written by Workers AI from figures computed in SQL
- **Email digest** (optional) — the day's overdue, due and upcoming tasks via SES
  at the same hour
- **Live updates** — complete a task on the phone and it leaves the laptop's
  list straight away
- **Offline adds** — a task added with no signal is kept on the device, shown
  marked as unsynced, and sent when the connection returns; idempotency keys
  mean a resend can't add it twice
- **Secure by default** — Cloudflare Access in front of everything; no login UI

## Architecture

| Component | Technology | Deployment |
|-----------|-----------|------------|
| Client | React + Vite + MUI, installable PWA | Cloudflare Pages |
| Server | Hono (TypeScript) | Cloudflare Workers |
| Database | D1 (SQLite) | Cloudflare D1 |
| Read cache | Workers KV | In front of D1 and the Access JWKS; never a source of truth |
| Auth | Cloudflare Access | JWT validation in the Worker |
| Reminders | Every-minute cron + Cloudflare Queues | Claimed by one UPDATE, delivered per device via Web Push |
| Live updates | Durable Object per user (hibernating WebSockets) | Nudges only, never data |
| Domain events | Cloudflare Queues | `task.*` events; subscribers resolve stale alerts |
| Daily briefing | Workers AI, queued | Template written first, AI version replaces it |
| Email digest | Cloudflare Queues + SES | Retried, with a dead letter queue |
| CI secrets | Vault, via Tailscale OIDC | Role `tasktracker-deploy` in gh_hdc `vault/` |

## How reminders work

A task's `remind_at` is an instant. Every minute the Worker runs one statement:

```sql
UPDATE tasks SET reminded_at = remind_at
 WHERE completed = 0 AND remind_at <= :now
   AND (reminded_at IS NULL OR reminded_at != remind_at)
RETURNING …
```

That UPDATE *is* the claim: two overlapping cron invocations cannot both see
the same task, so a reminder fires exactly once per `remind_at` value.
Snoozing moves `remind_at`, which makes the task claimable again; nothing else
does. For each claimed task the cron writes an alert row (the bell's record —
written even when no device is subscribed) and queues one push per device. The
queue consumer re-checks that the task is still open before sending, so a task
finished in the seconds after its claim doesn't buzz anyone.

When the task is completed, snoozed, deleted, or has its reminder moved, a
`task.*` event goes on the event bus and the `reminder-resolution` subscriber
resolves the alert. The next time any device refreshes the bell it closes the
matching notification — the push is tagged `reminder:<task id>`.

## Recurrence

Completing a recurring task inserts its successor in the same `D1.batch()` (a
transaction). A unique index on `recurred_from_id` makes completion idempotent:
a double tap, a retry, or complete → undo → complete still yields exactly one
next occurrence. The next due date steps forward until it lands after today, so
finishing a daily task that is three days overdue schedules tomorrow, not three
more overdue copies.

## The daily briefing

Same design as BabyTracker's daily note: the hourly cron checks each user's own
timezone and, at their digest hour (default 7am), computes the day's figures in
SQL, writes a template briefing immediately, and queues the model call. The
consumer replaces it with the AI version, retrying transient failures. The
model can only write sentences around numbers it is handed. Unlike the baby
tracker, the titles of up to three of the day's most pressing tasks are
included — they go to Workers AI on this same account and nowhere else.

**Settings → Rewrite** regenerates it on demand.

## Getting started

```sh
npm install

# Apply migrations to the local D1, then start the API (DEV_MODE skips Access)
cp server/.dev.vars.example server/.dev.vars
npm run db:migrate -w server
npm run dev:server

# In another terminal
npm run dev:client
```

```sh
npm test                 # everything
npm run test:server      # Workers pool (Miniflare: real D1, KV, Durable Objects)
npm run test:client      # jsdom
```

## Deployment

Merging to `main` deploys: `deploy-server.yml` applies D1 migrations, creates the
queues, checks the KV namespace, deploys the Worker, runs KV migrations, and
sets the VAPID keys once; `deploy-client.yml` builds and deploys Pages and wires
up `tasks.mfaherty.net`. Both read their Cloudflare credentials from Vault.

### One-time setup

Already done: the D1 database (`task-tracker-db`) and the KV namespace
(`task-tracker-cache`) exist and are bound by id in `server/wrangler.toml`.

Still needed before the first deploy:

1. **Cloudflare Access application** — a self-hosted application on
   `tasks.mfaherty.net` (hostname-based, *not* Worker-level: a Worker-level
   policy rejects WebSocket upgrades). Policy: allow only your email. Copy its
   **Application Audience (AUD) tag** into `CF_ACCESS_AUD` in
   `server/wrangler.toml`. Both deploy workflows refuse to run while it is the
   placeholder.
2. **Vault** — the `tasktracker-deploy` role and policy (gh_hdc `vault/`), and the
   secret `kv/github/TaskTracker/cloudflare` with `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID`. The token needs Workers Scripts, D1, Queues, Workers
   KV Storage, Pages, DNS and Cache Purge — the same scope BabyTracker's has.
3. **GitHub environment** — a `production` environment on the repo (the deploy
   jobs target it).
4. **Email digest (optional)** — `wrangler secret put` `AWS_SES_ACCESS_KEY`,
   `AWS_SES_SECRET_KEY`, `REPORT_FROM_EMAIL` (and optionally `ALERT_EMAIL`), then
   turn it on in Settings. Without them the digest is skipped and logged.

## Project structure

```
├── client/              # React + Vite PWA
│   ├── src/
│   │   ├── api/         # API client, offline outbox, live socket, freshness
│   │   ├── components/  # Layout, task row/editor, bell, banners
│   │   ├── hooks/       # Tasks, lists, settings, refresh, push providers
│   │   ├── pages/       # Today, Upcoming, list views, Completed, Search, Settings
│   │   ├── utils/       # Dates, quick-add parser, app shell, reload deferral
│   │   └── sw.ts        # Service worker: precache, push, notification actions
│   └── test/
├── server/              # Hono Cloudflare Worker
│   ├── src/
│   │   ├── events/      # Domain event bus
│   │   ├── kv/          # Read cache (keys, TTLs, helpers)
│   │   ├── middleware/  # Access JWT auth, Cache-Control
│   │   ├── routes/      # REST API
│   │   ├── scheduled/   # Reminders, briefing, digest
│   │   └── time.ts      # Timezone-aware calendar arithmetic
│   ├── migrations/      # D1 SQL migrations
│   ├── kv-migrations/   # KV migrations
│   └── test/
└── package.json         # npm workspaces root
```

## License

[MIT](LICENSE)
