import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "@mui/material/styles";

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
import Layout from "../src/components/Layout";
import { DataRefreshProvider } from "../src/hooks/useDataRefresh";
import { NotificationProvider } from "../src/hooks/useNotification";
import { AreasProvider } from "../src/hooks/useAreas";
import { ListsProvider } from "../src/hooks/useLists";
import { TasksProvider } from "../src/hooks/useTasks";
import { FoldProvider, useFold } from "../src/hooks/useFold";
import { buildTheme } from "../src/theme/theme";
import TodayPage from "../src/pages/TodayPage";
import { resetOutbox } from "../src/api/outbox";
import { addDaysStr, todayStr } from "../src/utils/taskDates";
import type { Task } from "../src/types/models";

const mockApi = vi.mocked(api);
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 27_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.1 Mobile/15E148 Safari/604.1";

function task(overrides: Partial<Task>): Task {
  return {
    id: 1, list_id: null, area_id: 1, title: "t", notes: null, priority: "none", due_date: todayStr(), due_time: null,
    remind_at: null, reminded_at: null, recurrence: "none", recurrence_interval: 1, completed: 0, completed_at: null,
    recurred_from_id: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", ...overrides,
  };
}

function define(target: object, key: string, value: unknown) {
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
}

/** Put the window in the shape of one of the iPhone Duo's displays. */
function showDisplay(display: "outer" | "inner") {
  const [w, h] = display === "inner" ? [890, 626] : [466, 678];
  define(window, "innerWidth", w);
  define(window, "innerHeight", h);
  define(window.screen, "width", Math.min(w, h));
  define(window.screen, "height", Math.max(w, h));
  define(window.navigator, "userAgent", IPHONE_UA);
  define(window.navigator, "maxTouchPoints", 5);
}

/** The theme follows the fold, as AppThemeProvider's does. */
function Themed({ children }: { children: ReactNode }) {
  const fold = useFold();
  return <ThemeProvider theme={buildTheme("light", fold)}>{children}</ThemeProvider>;
}

function renderAt(path: string) {
  return render(
    <FoldProvider>
      <Themed>
        <MemoryRouter initialEntries={[path]}>
          <DataRefreshProvider>
            <NotificationProvider>
              <AreasProvider>
                <ListsProvider>
                  <TasksProvider>
                    <Routes>
                      <Route element={<Layout />}>
                        <Route path="/" element={<TodayPage />} />
                        <Route path="/settings" element={<div>Settings page</div>} />
                      </Route>
                    </Routes>
                  </TasksProvider>
                </ListsProvider>
              </AreasProvider>
            </NotificationProvider>
          </DataRefreshProvider>
        </MemoryRouter>
      </Themed>
    </FoldProvider>,
  );
}

const secondView = () => screen.queryByRole("complementary", { name: "Second view" });

beforeEach(() => {
  vi.clearAllMocks();
  resetOutbox();
  localStorage.clear();
  const today = todayStr();
  mockApi.get.mockImplementation(async (path: string) => {
    if (path === "/areas") return [{ id: 1, name: "Personal", color: "#30a46c", position: 0, created_at: "", updated_at: "" }];
    if (path === "/tasks")
      return [
        task({ id: 1, title: "Pay rent", due_date: today }),
        task({ id: 2, title: "Dentist", due_date: addDaysStr(today, 3) }),
      ];
    if (path === "/lists") return { lists: [], inbox_count: 2, inbox_counts: { 1: 2 } };
    throw new Error(`unexpected GET ${path}`);
  });
  mockApi.getOptional.mockResolvedValue(null);
});

describe("Layout on the iPhone Duo", () => {
  it("is one view on the outer display", async () => {
    showDisplay("outer");
    renderAt("/");
    expect(await screen.findByText("Pay rent")).toBeInTheDocument();
    expect(secondView()).toBeNull();
    expect(screen.queryByText("Dentist")).toBeNull();
  });

  it("shows Upcoming beside Today on the inner display, with one add field between them", async () => {
    showDisplay("inner");
    renderAt("/");
    expect(await screen.findByText("Pay rent")).toBeInTheDocument();
    const aside = secondView()!;
    expect(await within(aside).findByText("Dentist")).toBeInTheDocument();
    expect(within(aside).getByText("Upcoming")).toBeInTheDocument();
    expect(screen.getAllByRole("textbox", { name: "Add a task" })).toHaveLength(1);
  });

  it("shows Today beside any other page", async () => {
    showDisplay("inner");
    renderAt("/settings");
    expect(screen.getByText("Settings page")).toBeInTheDocument();
    expect(await within(secondView()!).findByText("Pay rent")).toBeInTheDocument();
  });

  it("opens a linked task once, not once per view", async () => {
    showDisplay("inner");
    renderAt("/?task=2");
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("adds the second view when the phone is opened, and drops it when closed", async () => {
    showDisplay("outer");
    renderAt("/");
    expect(await screen.findByText("Pay rent")).toBeInTheDocument();
    expect(secondView()).toBeNull();

    showDisplay("inner");
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    await waitFor(() => expect(secondView()).not.toBeNull());
    expect(await within(secondView()!).findByText("Dentist")).toBeInTheDocument();

    showDisplay("outer");
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    await waitFor(() => expect(secondView()).toBeNull());
    expect(screen.getByText("Pay rent")).toBeInTheDocument();
  });
});
