-- Initial schema.
--
-- Single-user in practice (Cloudflare Access only lets one identity in), but
-- every row is still scoped by user_id: it is the same cost as not doing it,
-- and it means a second Access identity — a test account, a future shared
-- list — can never see the first one's tasks by accident.
--
-- Conventions, as in BabyTracker: INTEGER 0/1 for booleans, ISO 8601 text for
-- timestamps (UTC, second precision), created_at/updated_at on every table.

-- Users (auto-created from the Cloudflare Access JWT)
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE user_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  theme_mode TEXT NOT NULL DEFAULT 'system' CHECK(theme_mode IN ('system', 'light', 'dark')),
  -- IANA zone. Due dates are calendar dates *in this zone*, and the digest
  -- hour and recurrence arithmetic are evaluated in it. The client keeps it
  -- in step with the device's own zone.
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  -- Morning digest: the briefing is written at this local hour every day, and the
  -- email goes out with it only when email_digest = 1.
  digest_hour INTEGER NOT NULL DEFAULT 7 CHECK(digest_hour BETWEEN 0 AND 23),
  email_digest INTEGER NOT NULL DEFAULT 0,
  -- Pre-filled reminder time for a task that has a due date but no due time.
  default_reminder_time TEXT NOT NULL DEFAULT '09:00',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Lists (projects). A task with no list is in the Inbox.
CREATE TABLE lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#5b5dff',
  position INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_lists_user_id ON lists(user_id, position);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Deleting a list moves its tasks to the Inbox rather than deleting them:
  -- losing a list's worth of tasks to one mis-tap is the worse mistake.
  list_id INTEGER REFERENCES lists(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  notes TEXT,
  priority TEXT NOT NULL DEFAULT 'none' CHECK(priority IN ('none', 'low', 'medium', 'high')),
  -- Calendar date in the user's timezone (YYYY-MM-DD), and optionally a
  -- wall-clock time on it (HH:MM). Kept as local values rather than an
  -- instant because "due Friday" is a statement about a calendar day, and an
  -- instant would move it to Thursday the moment the user flew west.
  due_date TEXT,
  due_time TEXT,
  -- When to push a reminder — an instant, because a reminder is a moment.
  remind_at TEXT,
  -- The remind_at value the reminder cron last fired for. The cron claims a
  -- task by setting this equal to remind_at, so a reminder fires once per
  -- remind_at value: snoozing (moving remind_at) arms it again, and a doubled
  -- cron cannot fire it twice. See scheduled/reminders.ts.
  reminded_at TEXT,
  recurrence TEXT NOT NULL DEFAULT 'none'
    CHECK(recurrence IN ('none', 'daily', 'weekdays', 'weekly', 'monthly', 'yearly')),
  recurrence_interval INTEGER NOT NULL DEFAULT 1 CHECK(recurrence_interval BETWEEN 1 AND 365),
  completed INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  -- The occurrence this one was spawned from when a recurring task was
  -- completed. Unique, which is what makes completion idempotent: completing
  -- the same occurrence twice (a double tap, a retried request, complete →
  -- undo → complete) can only ever spawn one next occurrence.
  recurred_from_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_tasks_open ON tasks(user_id, completed, due_date);
CREATE INDEX idx_tasks_completed_at ON tasks(user_id, completed_at) WHERE completed = 1;
CREATE INDEX idx_tasks_list ON tasks(list_id);
CREATE UNIQUE INDEX idx_tasks_recurred_from ON tasks(recurred_from_id) WHERE recurred_from_id IS NOT NULL;
-- The reminder cron runs every minute and asks one question of this table, so
-- that question gets its own partial index: open tasks with a reminder armed.
CREATE INDEX idx_tasks_reminders ON tasks(remind_at) WHERE completed = 0 AND remind_at IS NOT NULL;

-- Deduplication log for client-supplied idempotency keys — see
-- routes/idempotency.ts. Pruned by the hourly cron after 7 days.
CREATE TABLE client_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  row_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE UNIQUE INDEX idx_client_requests_key
  ON client_requests (user_id, table_name, client_request_id);
CREATE INDEX idx_client_requests_created_at ON client_requests (created_at);

-- One row per browser/device push subscription.
CREATE TABLE push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_push_subscriptions_user_id ON push_subscriptions(user_id);

-- The in-app alerts feed: one row per alert the server decided to raise,
-- whether or not a push was delivered for it. Push is the notification, this
-- is the record — a push swiped off the lock screen is gone while the task it
-- was about is still undone, and on an installed iOS PWA push is the least
-- reliable link in the chain. Written at the decision (the cron's claim),
-- never at delivery.
CREATE TABLE alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- SET NULL rather than CASCADE: the alert is the record of what fired, and
  -- that record outlives the task. A deleted task's alerts are resolved by
  -- the event bus before the row goes (see events/subscribers.ts).
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK(kind IN ('reminder')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '/',
  -- The occasion: reminder:<task id>:<remind_at>. A doubled cron cannot
  -- double-log it.
  dedupe_key TEXT NOT NULL UNIQUE,
  -- Set when the thing the alert was about stopped being true — the task was
  -- completed, snoozed, or deleted. Resolved alerts leave the bell.
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_alerts_user_created ON alerts(user_id, created_at DESC);
CREATE INDEX idx_alerts_open_by_task ON alerts(task_id) WHERE resolved_at IS NULL;

-- How far the user has read the feed: one watermark, not a flag per alert.
CREATE TABLE alert_reads (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_read_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Dismissed alerts. Hides, never deletes, so a mis-tap is undoable.
CREATE TABLE alert_dismissals (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alert_id INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (user_id, alert_id)
);

CREATE INDEX idx_alert_dismissals_alert_id ON alert_dismissals(alert_id);

-- The daily briefing: a short note on the Today page about what the day holds,
-- one per user per local date. Figures are computed in SQL, and the model only
-- writes the sentences around them. `source` records which wrote it, so a run
-- of fallbacks is how a misconfigured AI binding shows itself.
CREATE TABLE daily_briefings (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  body TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('ai', 'fallback')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (user_id, date)
);

-- The digest's claim: one row per user per local date, written before the
-- email is queued, so an hourly cron that fires twice cannot send it twice.
CREATE TABLE digest_runs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (user_id, date)
);
