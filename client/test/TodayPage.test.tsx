import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

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
import { ListsProvider } from "../src/hooks/useLists";
import { TasksProvider } from "../src/hooks/useTasks";
import TodayPage from "../src/pages/TodayPage";
import { resetOutbox } from "../src/api/outbox";
import { todayStr, addDaysStr } from "../src/utils/taskDates";
import type { Task } from "../src/types/models";

const mockApi = vi.mocked(api);

function task(overrides: Partial<Task>): Task {
  return {
    id: 1,
    list_id: null,
    title: "t",
    notes: null,
    priority: "none",
    due_date: null,
    due_time: null,
    remind_at: null,
    reminded_at: null,
    recurrence: "none",
    recurrence_interval: 1,
    completed: 0,
    completed_at: null,
    recurred_from_id: null,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

let openTasks: Task[];

function renderToday() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <DataRefreshProvider>
        <NotificationProvider>
          <ListsProvider>
            <TasksProvider>
              <Routes>
                <Route path="/" element={<TodayPage />} />
              </Routes>
            </TasksProvider>
          </ListsProvider>
        </NotificationProvider>
      </DataRefreshProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resetOutbox();
  const today = todayStr();
  openTasks = [
    task({ id: 1, title: "Overdue bill", due_date: addDaysStr(today, -2) }),
    task({ id: 2, title: "Today's call", due_date: today }),
    task({ id: 3, title: "Next week thing", due_date: addDaysStr(today, 7) }),
    task({ id: 4, title: "Someday", due_date: null }),
  ];
  mockApi.get.mockImplementation(async (path: string) => {
    if (path === "/tasks") return openTasks;
    if (path === "/lists") return { lists: [], inbox_count: 0 };
    throw new Error(`unexpected GET ${path}`);
  });
  mockApi.getOptional.mockResolvedValue({ briefing: { date: today, body: "Two things today.", source: "ai" } });
});

describe("Today", () => {
  it("shows overdue and today's tasks, grouped, and nothing else", async () => {
    renderToday();
    expect(await screen.findByText("Overdue bill")).toBeInTheDocument();
    expect(screen.getByText("Today's call")).toBeInTheDocument();
    expect(screen.queryByText("Next week thing")).not.toBeInTheDocument();
    expect(screen.queryByText("Someday")).not.toBeInTheDocument();
    expect(screen.getByText("Overdue · 1")).toBeInTheDocument();
    expect(await screen.findByText("Two things today.")).toBeInTheDocument();
  });

  it("completes a task optimistically and offers an undo", async () => {
    mockApi.post.mockResolvedValueOnce({ task: { ...openTasks[1], completed: 1 }, next: null });
    renderToday();
    await screen.findByText("Today's call");

    // The server's next answer no longer has it.
    openTasks = openTasks.filter((t) => t.id !== 2);
    await userEvent.click(screen.getByRole("checkbox", { name: "Complete Today's call" }));

    expect(mockApi.post).toHaveBeenCalledWith("/tasks/2/complete", {});
    await waitFor(() => expect(screen.queryByText("Today's call")).not.toBeInTheDocument());
    const toast = await screen.findByRole("alert");
    expect(within(toast).getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("adds a task due today from the quick-add box", async () => {
    mockApi.post.mockResolvedValueOnce(task({ id: 9, title: "Buy milk", due_date: todayStr() }));
    renderToday();
    await screen.findByText("Today's call");

    await userEvent.type(screen.getByRole("textbox", { name: "Add a task" }), "Buy milk !high{Enter}");

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    const [path, body] = mockApi.post.mock.calls[0];
    expect(path).toBe("/tasks");
    expect(body).toMatchObject({ title: "Buy milk", priority: "high", due_date: todayStr() });
    expect((body as { client_request_id: string }).client_request_id).toBeTruthy();
  });
});
