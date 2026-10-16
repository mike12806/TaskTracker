export interface User {
  id: number;
  email: string;
  name: string;
}

export type Priority = "none" | "low" | "medium" | "high";
export type Recurrence = "none" | "daily" | "weekdays" | "weekly" | "monthly" | "yearly";

export interface Task {
  id: number;
  list_id: number | null;
  title: string;
  notes: string | null;
  priority: Priority;
  /** Calendar date in the user's timezone, `YYYY-MM-DD`. */
  due_date: string | null;
  /** Wall-clock time on `due_date`, `HH:MM`. */
  due_time: string | null;
  /** When to push a reminder — an instant (ISO 8601, UTC). */
  remind_at: string | null;
  /** The `remind_at` value the reminder last fired for. */
  reminded_at: string | null;
  recurrence: Recurrence;
  recurrence_interval: number;
  completed: number;
  completed_at: string | null;
  recurred_from_id: number | null;
  created_at: string;
  updated_at: string;
  /** Present only on a task queued on this device — see `api/outbox.ts`. */
  pending?: true;
  pending_failure?: string;
}

/** The fields a create or edit sends. */
export type TaskInput = Pick<
  Task,
  "title" | "notes" | "priority" | "list_id" | "due_date" | "due_time" | "remind_at" | "recurrence" | "recurrence_interval"
>;

export interface TaskList {
  id: number;
  name: string;
  color: string;
  position: number;
  archived: number;
  open_count: number;
  created_at: string;
  updated_at: string;
}

export interface UserSettings {
  user_id: number;
  theme_mode: "system" | "light" | "dark";
  timezone: string;
  digest_hour: number;
  email_digest: number;
  default_reminder_time: string;
}

export interface Alert {
  id: number;
  task_id: number | null;
  kind: "reminder";
  title: string;
  body: string;
  url: string;
  created_at: string;
}

export interface Briefing {
  date: string;
  body: string;
  source: "ai" | "fallback";
  created_at: string;
  updated_at: string;
}
