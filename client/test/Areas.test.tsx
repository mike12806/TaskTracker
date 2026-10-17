import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
import { AreasProvider } from "../src/hooks/useAreas";
import { ListsProvider } from "../src/hooks/useLists";
import { TasksProvider } from "../src/hooks/useTasks";
import TodayPage from "../src/pages/TodayPage";
import { resetOutbox } from "../src/api/outbox";
import { todayStr } from "../src/utils/taskDates";
import type { Task } from "../src/types/models";

const mockApi = vi.mocked(api);
const PERSONAL = { id: 1, name: "Personal", color: "#30a46c", position: 0, created_at: "", updated_at: "" };
const WORK = { id: 2, name: "Work", color: "#0090ff", position: 1, created_at: "", updated_at: "" };

function task(overrides: Partial<Task>): Task {
  return {
    id: 1, list_id: null, area_id: 1, title: "t", notes: null, priority: "none", due_date: todayStr(), due_time: null,
    remind_at: null, reminded_at: null, recurrence: "none", recurrence_interval: 1, completed: 0, completed_at: null,
    recurred_from_id: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", ...overrides,
  };
}

function renderToday() {
  return render(
    <MemoryRouter>
      <DataRefreshProvider>
        <NotificationProvider>
          <AreasProvider>
            <ListsProvider>
              <TasksProvider>
                <Routes>
                  <Route path="/" element={<TodayPage />} />
                </Routes>
              </TasksProvider>
            </ListsProvider>
          </AreasProvider>
        </NotificationProvider>
      </DataRefreshProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resetOutbox();
  localStorage.clear();
  mockApi.get.mockImplementation(async (path: string) => {
    if (path === "/areas") return [PERSONAL, WORK];
    if (path === "/tasks") return [task({ id: 1, title: "Groceries", area_id: 1 }), task({ id: 2, title: "Standup notes", area_id: 2 })];
    if (path === "/lists") return { lists: [], inbox_count: 2, inbox_counts: { 1: 1, 2: 1 } };
    throw new Error(`unexpected GET ${path}`);
  });
  mockApi.getOptional.mockResolvedValue({ briefing: null });
});

describe("areas", () => {
  it("shows every area's tasks, labelled, when all areas are selected", async () => {
    renderToday();
    expect(await screen.findByText("Groceries")).toBeInTheDocument();
    expect(screen.getByText("Standup notes")).toBeInTheDocument();
    expect(await screen.findByText("Work")).toBeInTheDocument();
  });

  it("shows only the selected area, remembered on this device, and adds into it", async () => {
    localStorage.setItem("tasktracker.area", "2");
    mockApi.post.mockResolvedValueOnce(task({ id: 9, title: "Expense report", area_id: 2 }));
    renderToday();

    expect(await screen.findByText("Standup notes")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Groceries")).not.toBeInTheDocument());

    await userEvent.type(screen.getByRole("textbox", { name: "Add a task" }), "Expense report{Enter}");
    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    expect(mockApi.post.mock.calls[0][1]).toMatchObject({ title: "Expense report", area_id: 2 });
  });

  it("falls back to all areas when the remembered one no longer exists", async () => {
    localStorage.setItem("tasktracker.area", "99");
    renderToday();
    expect(await screen.findByText("Groceries")).toBeInTheDocument();
    expect(screen.getByText("Standup notes")).toBeInTheDocument();
  });
});
