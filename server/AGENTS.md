# Server — Hono Cloudflare Worker + D1

## Stack

- Hono as the HTTP router
- Cloudflare D1 (SQLite) for persistence
- Cloudflare KV (`CACHE`) as a read cache in front of D1 — never a source of truth
- Cloudflare Access for auth (JWT validation)
- Deployed as a single Cloudflare Worker

## Structure

- `src/index.ts` — Worker entry point, mounts route modules
- `src/routes/` — One file per resource (tasks, lists, settings, alerts, push, briefing, live)
- `src/scheduled/` — Cron and queue work: `reminders.ts` (every minute), `digest.ts` (hourly: briefing, email, housekeeping), `briefing.ts`
- `src/time.ts` — Every piece of timezone-aware calendar arithmetic. Nothing else converts between local dates and instants
- `src/middleware/` — Hono middleware (auth, error handling)
- `src/kv/` — The KV read cache: `keys.ts` (every key, all versioned), `ttl.ts` (how long each may be wrong for), `cache.ts` (the read-through helpers)
- `src/events/` — The domain event bus: `types.ts` (every event shape), `bus.ts` (publish and dispatch), `subscribers.ts` (what reacts to what)
- `src/types/` — Shared TypeScript types
- `migrations/` — D1 migration SQL files
- `kv-migrations/` — KV migrations, run by `scripts/kv-migrate.mjs`

## Conventions

- Every route file exports a `Hono` instance that gets mounted in `index.ts`
- All routes are prefixed with `/api/`
- Use Hono's `c.env.DB` to access the D1 binding
- Validate request bodies by hand at the route (see `readTaskInput` in `routes/tasks.ts`) and answer 400 with `{ error }`
- Return JSON responses with `c.json()` — include appropriate HTTP status codes
- Use `c.var` for middleware-injected values (e.g., authenticated user email)

## Auth — Cloudflare Access

- Cloudflare Access handles login — the Worker never sees credentials
- Auth middleware validates the `Cf-Access-Jwt-Assertion` header on every request
- Extract the user's email from the JWT payload
- Auto-create/match user by email in the `users` table (cached in KV; upserted when the JWT name changes)
- Set `c.set('userId', id)` and `c.set('userEmail', email)` for downstream route handlers
- `/api/auth/me` returns the current user profile from the JWT identity
- Reject requests with missing or invalid JWT with 401
- CF Access policy team domain and audience (AUD) come from Worker env bindings

## D1 Patterns

- All queries use prepared statements: `c.env.DB.prepare(sql).bind(...params)`
- Use `.all()` for SELECT queries, `.run()` for INSERT/UPDATE/DELETE
- Never string-concatenate user input into SQL
- Wrap multi-table writes in D1 batch: `c.env.DB.batch([stmt1, stmt2])`
- Return `created_at` and `updated_at` in all responses

## KV Patterns

- `cached(env, key, ttl, load)` is the only way to read: cache hit, or `load()` and write back. `load` is not wrapped — a D1 failure is real and belongs to the caller, unlike a KV one
- Every write path drops the keys it invalidates, at the single choke point where the row is written (`storeBriefing`) rather than at each call site
- Cache `null` where "there is nothing" is a real answer — the envelope in `cache.ts` exists to tell it apart from a miss, and without it a user with no briefing yet would read D1 on every Today load
- Cache the *row*, not the answer. Anything time-dependent (an age cutoff, a "within N days" filter) is re-applied after the read, or the cache freezes the clock at the moment of the miss
- Never cache tasks, lists or user settings — see the rule in the root `AGENTS.md`. If you are reaching for a cache to make a list endpoint faster, the answer is an index, not KV
- `JWKS_TTL_SECONDS` is the one TTL here that is a *security* bound, not a freshness one: it governs how long a signing key Cloudflare has withdrawn stays trusted. Raising it to save fetches trades a revocation window for nothing that matters — a new key is already picked up on the first request that carries it

## Event Patterns

- `emit(env, entryEvent(type, fields), waitUntil)` is the only way to publish. Pass `waitUntil` from anything serving a request so the send never lands on the response path
- Events carry identity (`userId`, `taskId`), never the row's contents — re-read D1 in the subscriber
- A new reaction to a write is a new `Subscriber` in `subscribers.ts`, not a call added to the route. If you are editing `routes/tasks.ts` to make something happen after a save, that is the signal you want a subscriber
- Subscribers must be idempotent and must not depend on each other or on order
- `EVENTS` is optional; without it `emit` dispatches inline, which is what the tests run on. A test that needs the queued path passes its own fake binding (see `test/events.test.ts`)
- Adding a queue means adding it to the `Create queues` step in `deploy-server.yml` — wrangler rejects a deploy whose binding names a queue that does not exist

## Error Handling

- Use Hono's `onError` handler for global error catching
- Return consistent error JSON: `{ error: string }` with the right status code
- Log errors but never expose internal details to the client

## Migrations

- Files named sequentially: `0001_initial_schema.sql`, `0002_…`. No semicolons inside SQL comments — `test/helpers.ts` splits scripts on them
- Each migration should be reversible when possible (include comments with rollback SQL)
- Applied automatically on deploy — `deploy-server.yml` runs `wrangler d1 migrations apply task-tracker-db --remote` ahead of `wrangler deploy` on every push to main. It is idempotent (wrangler records which migrations have run), so merging the file is all that is needed; there is no manual step to remember or to tell anyone about.
- Locally: `npx wrangler d1 migrations apply <DB_NAME> --local`
- KV has its own runner, `scripts/kv-migrate.mjs`, run by the same workflow but *after* the upload rather than before it. Numbered `.mjs` files in `kv-migrations/` run once each; the version sweep runs every time and is never recorded. Also idempotent, also nothing to apply by hand. `npm run kv:migrate` for local, `npm run kv:status` to see what a remote run would do

## Scheduled work

- The every-minute cron's claim is the `UPDATE … RETURNING` in `runReminderCron`. Keep the decision and the claim in that one statement; a separate SELECT then UPDATE would let two overlapping invocations both fire a reminder
- Record the alert at the claim, before queueing pushes, and never in the queue consumer
- Anything that depends on "what time is it for the user" goes through `time.ts` and the user's stored timezone — never the Worker's UTC clock directly
- The hourly cron's per-day claim is `digest_runs`; add new once-a-day-per-user work behind it rather than inventing another claim
- Every queue consumer acks or retries per message, never per batch
