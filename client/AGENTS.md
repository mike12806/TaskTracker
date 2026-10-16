# Client — React + Vite + Material UI

## Stack

- React 18+ with TypeScript
- Vite for bundling and dev server
- Material UI (MUI) for all UI components
- Deployed to Cloudflare Pages

## Structure

- `src/components/` — Reusable UI components
- `src/pages/` — Top-level route pages
- `src/api/` — API client functions (fetch wrappers)
- `src/hooks/` — Custom React hooks
- `src/types/` — Shared TypeScript types
- `src/theme/` — MUI theme customization

## Conventions

- Use MUI components exclusively — do not mix in raw HTML elements for UI controls, inputs, or layout
- Use MUI's `sx` prop for one-off styling; use `styled()` or theme overrides for reusable styles
- Use React Router for client-side routing
- API calls go through a centralized client in `src/api/` — never call `fetch` directly from components
- Use ISO 8601 strings for all date/time values; format for display at the component level
- Prefer controlled components for forms
- Use `useQuery`/`useMutation` patterns (e.g., TanStack Query) for server state management

## Data Freshness

The app is installed as a PWA and left running for days, so anything on screen
is read as the current state of things — what is due, what is done. A task
completed on the laptop that still shows as open on the phone is a correctness
bug here, not a cosmetic one.

Priorities, in this order: **never show stale data, then cost, then
performance.** Decisions below follow from that ordering; don't trade upward.

- **API data is never cached. Anywhere.** The service worker (`src/sw.ts`,
  hand-written via `injectManifest`) has no route for `/api/*`; requests pass
  through and fail honestly when the network is down. The server sends
  `Cache-Control: no-store` so no HTTP cache answers either. Every scheme that
  kept an offline copy needed a second mechanism to label it, and each had
  windows where old data slipped through as current — keeping no copy is the
  only version with nothing to get wrong. Do not add a runtime cache for
  `/api/*` back, however tempting for offline support: readable-but-wrong lost
  to unavailable-but-honest by design.
- That rule is about the *server's answers*. It is not about the user's own
  unsent writes, which are kept — see **Offline writes** below. The two are
  opposites: a stored copy of a server reply is a claim about the tasks that may
  since have become false, while a queued write is a fact about what this user
  did that no unreachable server can contradict.
- When the server is unreachable the app keeps its last-rendered data, raises
  the banner in `Layout` (driven by `freshness.ts` — `markOffline` on a failed
  request, cleared by the next success), and retries: `STALE_RETRY_MS` pings
  `pingServer` and refreshes only when the ping succeeds, so an outage costs
  one tiny request per cycle instead of a full failed refresh and its error
  toasts. An `online` event refreshes immediately.
- Every fetch must key its effect on `refreshKey` from `useDataRefresh`. The open
  tasks are fetched once, by `TasksProvider`, and every view filters them; lists
  by `ListsProvider`. A page that fetches on its own (Completed, the briefing)
  keys on `refreshKey` too.
- `DataRefreshProvider` bumps `refreshKey` when the app is reopened
  (`visibilitychange`, `focus`, bfcache `pageshow`), on a live nudge, on a
  poll, and whenever an entry is saved. It holds refreshes back while a form is
  open — see `isUserBusy` — so nothing rebuilds under a half-filled dialog.
- **The live socket replaces one trigger, not the machinery.** `api/live.ts`
  holds one WebSocket per tab (opened by `components/LiveConnection.tsx`, one
  Durable Object per user on the server), and what arrives on it is a nudge
  with no task data in it — the app still fetches over `/api/*`, so the no-cache rule
  above is unaffected. Everything else here is unchanged and still needed: the
  page is frozen on an installed PWA, so the socket is usually dead by the time
  it thaws and the resume handlers are what notice. A change published while
  the socket was down reached nobody and is never re-sent, which is why
  reconnecting after a gap longer than `REFRESH_THROTTLE_MS` refetches.
- **A nudge is not subject to `REFRESH_THROTTLE_MS`.** That throttle suppresses
  duplicate refreshes of data nobody touched; a nudge is the server stating
  that something *was* touched, so putting it behind the throttle would
  silently drop the second of two changes made seconds apart — the exact case
  the socket exists for. `LIVE_COALESCE_MS` collapses bursts instead. A nudge
  held by an open form re-checks itself every `LIVE_HELD_RECHECK_MS` rather
  than waiting on `focusout`, which a backdrop-dismissed dialog never fires.
- **The poll stays, slower.** `LIVE_BACKSTOP_POLL_MS` (5 min) while the socket
  is delivering, `FOREGROUND_POLL_MS` (1 min) whenever it is not. Do not delete
  the poll: a socket that has quietly stopped delivering looks exactly like a
  quiet afternoon, and the ordering at the top of
  this section puts never showing stale data above both cost and performance.
  The 45s heartbeat in `api/live.ts` is the fast detector; the poll is the slow
  one underneath it.
- **A socket that will not open is a supported state.** A browser is never told
  why an upgrade failed — the WebSocket API hides the HTTP status — so an
  Access policy that rejects upgrades, a proxy that strips them and a dead
  network are indistinguishable from the client. After `COLD_ATTEMPT_LIMIT`
  attempts that never reached the server's greeting, the app stops trying and
  goes back to the 1-minute poll, re-probing when it is next brought to the
  front. Nothing else changes; only latency does.
- `FOREGROUND_POLL_MS` is a freshness lever first. A refresh here is a handful
  of small requests (open tasks, lists, alerts), so polling is cheap; with the
  socket up it is the fallback rather than the main path anyway.
- `FROM_CACHE_HEADER` handling in `freshness.ts` is inherited from BabyTracker,
  where it covered upgrading off a build that cached API replies. No build of
  this app ever did, so it never fires here; it is kept as belt and braces
  against an intermediary that ignores `no-store`.
- What *is* cached: the precached app shell (versioned per build) and Google
  Fonts. Neither is data, and neither can be stale in the data sense.
- **Navigations ask the network for the shell first** (`utils/appShell.ts`),
  with the precached shell as the fallback after `SHELL_NETWORK_TIMEOUT_MS`,
  on a network error, on a 5xx, or when the browser reports itself offline.
  Serving the precached shell first meant every launch after a deploy started
  on the previous build and then reloaded itself once the worker had fetched
  the new one — the app visibly loading twice, most often when it was brought
  back to the front. Everything the edge answers is passed through as-is,
  including the redirect Cloudflare Access replies to an expired session with.
- **An update only reloads the page if it changes the build on screen.** The
  worker reports every build it activates, and after the change above that
  routinely includes the build the page fetched at launch a few seconds
  earlier. `utils/workerBuild.ts` asks the worker over a `MessageChannel`
  (`BUILD_ID_REQUEST`) and compares against `__BUILD_ID__`; only a genuine
  difference reaches `createDeferredReload`. No answer counts as a difference —
  a needless reload costs one launch, a skipped one leaves the device on an old
  build, which is the failure this path exists to prevent.
- API responses are `Cache-Control: no-store` so no HTTP cache in between can
  answer on the server's behalf.

## Offline Writes

Reads keep nothing; writes keep everything. A task create that cannot reach the
server goes into a durable queue on the device (`src/api/outbox.ts`) and is
sent on the next signal that the server is back.

- **Only creates are queued.** An edit, completion or delete is an operation on
  a row the server owns, which another device may have changed in the meantime.
  Lists are not queued either: a task can't be filed under a list id the server
  has never issued.
- **Safety is the idempotency key, not the queue.** Every queued create carries
  the `client_request_id` `useSaveGuard` gave it when Save was pressed (see
  `server/src/routes/idempotency.ts`). Never strip or regenerate it.
- **Queued tasks appear in the lists, marked.** `TasksProvider` merges them in
  and sorts them where their saved version will land; `PendingChip` marks each
  one and `PendingSyncBanner` counts them. A pending row keeps a **negative
  `id`** — `isPending` — which is what stops it being completed, edited, or sent
  as `DELETE /api/tasks/-1`. Deleting one discards it from the queue.
- **What is retried and what is not.** No status (dropped connection, deadline),
  5xx, 429 and an expired session are held and retried; any other 4xx is set
  aside with the server's message for the user to fix or discard. Nothing is
  dropped silently.
- **Flush triggers** live in `DataRefreshProvider`: `online`, becoming visible,
  a successful stale-data ping, app launch, and `OUTBOX_RETRY_MS`.

### PWA limits this design is shaped by

- **No Background Sync on iOS Safari**, so the queue drains from the foreground
  only. The banner is what makes that visible.
- **iOS evicts a backgrounded PWA whenever it likes**, so the queue is on disk
  and a flush is resumable from nothing.
- **Storage can refuse a write** (quota, private browsing). `enqueue` returns
  null and the save is reported as failed.
- **A backgrounded PWA's WebSocket dies, usually silently**, so the socket is
  probed (`revalidateLive`) on resume rather than waited on.
- **Web Push on iOS needs the app installed to the Home Screen**, and iOS does
  not show notification action buttons — Done/Snooze in `sw.ts` work on
  desktop and Android; on iOS a tap opens the task.

## Alerts feed

The bell (`AlertsBell.tsx`, `api/alerts.ts`) reads back the reminders the
server fired. It is the app's own copy of what push delivers, because push is
the unreliable half: a notification swiped away is gone while the task is
still undone, and it only ever reached the devices that opted in.

- **It renders, it does not decide.** The sentence in a row is the one the
  server sent, stored as sent.
- **Not cached**, like every other read. Refetches on `refreshKey`.
- **`getOptional`/`postOptional`.** Nobody opened the app to read the bell, so
  neither the fetch nor the read mark may raise the stale-data banner.
- **Read is marked to the newest row that was on screen**, never to `now`.
- **It tidies the lock screen.** Every successful fetch closes the reminder
  notifications (tag `reminder:<task id>`) whose alert is no longer open — see
  `utils/reminderNotifications.ts`.
- **Dismissing is optimistic and undoable**, with the undo rendered inside the
  drawer (a portalled snackbar would be `aria-hidden` behind the modal).

## Auth

- Cloudflare Access handles login — no login page or auth UI needed in the app
- The client and API are both behind Cloudflare Access, so the browser automatically has a valid CF Access cookie
- The API client includes credentials with every request (`credentials: 'include'`)
- On 401 responses, redirect the user to re-authenticate via Cloudflare Access
- A `/api/auth/me` endpoint returns the current user's profile (email, name)
- No logout button needed — session lifecycle is managed by Cloudflare Access

## Component Patterns

- Every task view is `components/TaskListView.tsx` with a different filter and
  grouping; the views share `TasksProvider`'s one fetch
- `TaskDialog` creates and edits; it keeps a draft of an unsaved new task
  (`formDraft.ts`) so an Access re-auth or an iOS eviction doesn't lose it
- Completing is optimistic with an Undo — the endpoint is idempotent server-side
- `?task=<id>` on any view opens that task; notifications and alerts link there
- Dates: `utils/taskDates.ts` on the client, `server/src/time.ts` on the server.
  Due dates are local calendar dates, never instants
