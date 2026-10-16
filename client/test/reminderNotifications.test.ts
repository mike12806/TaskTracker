import { describe, it, expect, vi, afterEach } from "vitest";
import { closeAnsweredReminderNotifications, reminderTag } from "../src/utils/reminderNotifications";
import type { Alert } from "../src/types/models";

function stubNotifications(tags: (string | undefined)[]) {
  const notifications = tags.map((tag) => ({ tag, close: vi.fn() }));
  vi.stubGlobal("navigator", {
    serviceWorker: { getRegistration: async () => ({ getNotifications: async () => notifications }) },
  });
  return notifications;
}

const alert = (task_id: number): Alert => ({
  id: task_id,
  task_id,
  kind: "reminder",
  title: "t",
  body: "b",
  url: "/",
  created_at: "2026-10-16T13:00:00Z",
});

describe("closeAnsweredReminderNotifications", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("closes reminders the feed no longer has, and nothing else", async () => {
    const [stillOpen, answered, other] = stubNotifications([reminderTag(1), reminderTag(2), "something-else"]);
    await closeAnsweredReminderNotifications([alert(1)]);
    expect(stillOpen.close).not.toHaveBeenCalled();
    expect(answered.close).toHaveBeenCalled();
    expect(other.close).not.toHaveBeenCalled();
  });

  it("matches the server's tag format exactly", () => {
    // server/src/scheduled/reminders.ts: reminderNotificationTag
    expect(reminderTag(42)).toBe("reminder:42");
  });
});
