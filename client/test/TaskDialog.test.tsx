import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

vi.mock("../src/api/client", () => ({
  api: {
    get: vi.fn(),
    getOptional: vi.fn(),
    post: vi.fn(),
    postOptional: vi.fn(),
    postSlow: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  pingServer: vi.fn(async () => true),
  API_BASE: "/api",
}));

import { api } from "../src/api/client";
import { DataRefreshProvider } from "../src/hooks/useDataRefresh";
import { NotificationProvider } from "../src/hooks/useNotification";
import { AreasProvider } from "../src/hooks/useAreas";
import { ListsProvider } from "../src/hooks/useLists";
import { TasksProvider } from "../src/hooks/useTasks";
import TaskDialog, { type TaskDefaults } from "../src/components/TaskDialog";
import { resetOutbox } from "../src/api/outbox";
import { addDaysStr, localToIso, todayStr } from "../src/utils/taskDates";
import type { Task } from "../src/types/models";

const mockApi = vi.mocked(api);

function task(overrides: Partial<Task>): Task {
  return {
    id: 7, list_id: null, area_id: 1, title: "Dentist", notes: null, priority: "none", due_date: null, due_time: null,
    remind_at: null, reminded_at: null, recurrence: "none", recurrence_interval: 1, completed: 0, completed_at: null,
    recurred_from_id: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", ...overrides,
  };
}

function renderDialog(props: { task?: Task | null; defaults?: TaskDefaults }) {
  return render(
    <MemoryRouter>
      <DataRefreshProvider>
        <NotificationProvider>
          <AreasProvider>
            <ListsProvider>
              <TasksProvider>
                <TaskDialog open task={props.task ?? null} defaults={props.defaults} onClose={() => {}} />
              </TasksProvider>
            </ListsProvider>
          </AreasProvider>
        </NotificationProvider>
      </DataRefreshProvider>
    </MemoryRouter>,
  );
}

const tomorrow = () => addDaysStr(todayStr(), 1);
const dialog = () => screen.getByRole("dialog");
const reminderSelect = () => within(dialog()).getByRole("combobox", { name: "Reminder" });

beforeEach(() => {
  vi.clearAllMocks();
  resetOutbox();
  localStorage.clear();
  mockApi.get.mockImplementation(async (path: string) => {
    if (path === "/areas") return [{ id: 1, name: "Personal", color: "#30a46c", position: 0, created_at: "", updated_at: "" }];
    if (path === "/tasks") return [];
    if (path === "/lists") return { lists: [], inbox_count: 0, inbox_counts: {} };
    throw new Error(`unexpected GET ${path}`);
  });
  mockApi.post.mockImplementation(async (_path: string, body: unknown) => task(body as Partial<Task>));
  mockApi.put.mockImplementation(async (_path: string, body: unknown) => task(body as Partial<Task>));
});

describe("TaskDialog", () => {
  it("gives a new task 9:00 and a reminder at that time once it has a due date", async () => {
    renderDialog({});
    expect(reminderSelect()).toHaveTextContent("No reminder");

    await userEvent.click(within(dialog()).getByRole("button", { name: "Tomorrow" }));
    expect(within(dialog()).getByLabelText("Time")).toHaveValue("09:00");
    expect(reminderSelect()).toHaveTextContent("At due time");

    await userEvent.type(within(dialog()).getByRole("textbox", { name: "Title" }), "Call the bank");
    await userEvent.click(within(dialog()).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    expect(mockApi.post.mock.calls[0][1]).toMatchObject({
      title: "Call the bank",
      due_date: tomorrow(),
      due_time: "09:00",
      remind_at: localToIso(tomorrow(), "09:00"),
    });
  });

  it("starts with 9:00 when the view supplies the date", () => {
    renderDialog({ defaults: { due_date: tomorrow() } });
    expect(within(dialog()).getByLabelText("Time")).toHaveValue("09:00");
    expect(reminderSelect()).toHaveTextContent("At due time");
  });

  it("reminds ahead of the due time", async () => {
    renderDialog({ defaults: { due_date: tomorrow() } });
    await userEvent.click(reminderSelect());
    const options = within(screen.getByRole("listbox")).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual([
      "No reminder",
      "At due time",
      "15 minutes before",
      "30 minutes before",
      "1 hour before",
      "2 hours before",
      "1 day before",
      "2 days before",
      "1 week before",
      "Custom…",
    ]);
    await userEvent.click(screen.getByRole("option", { name: "1 day before" }));

    await userEvent.type(within(dialog()).getByRole("textbox", { name: "Title" }), "Renew passport");
    await userEvent.click(within(dialog()).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    expect(mockApi.post.mock.calls[0][1]).toMatchObject({ remind_at: localToIso(todayStr(), "09:00") });
  });

  it("drops a relative reminder when the due date is cleared", async () => {
    renderDialog({ defaults: { due_date: tomorrow() } });
    await userEvent.click(within(dialog()).getByRole("button", { name: "Clear" }));
    expect(reminderSelect()).toHaveTextContent("No reminder");
    expect(within(dialog()).getByLabelText("Time")).toHaveValue("");
  });

  it("shows an existing task's reminder as its offset", () => {
    const due = tomorrow();
    renderDialog({
      task: task({ due_date: due, due_time: "14:30", remind_at: new Date(Date.parse(localToIso(due, "14:30")) - 7_200_000).toISOString() }),
    });
    expect(reminderSelect()).toHaveTextContent("2 hours before");
  });

  it("leaves an all-day task all-day when its date moves", async () => {
    renderDialog({ task: task({ due_date: tomorrow() }) });
    await userEvent.click(within(dialog()).getByRole("button", { name: "Next week" }));
    expect(within(dialog()).getByLabelText("Time")).toHaveValue("");
    expect(reminderSelect()).toHaveTextContent("No reminder");
  });
});
