import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material/styles";

vi.mock("../src/api/client", () => ({
  api: {
    get: vi.fn(),
    getOptional: vi.fn(),
    post: vi.fn(),
    postOptional: vi.fn(),
    postSlow: vi.fn(),
    put: vi.fn(async () => ({})),
    delete: vi.fn(),
  },
  pingServer: vi.fn(async () => true),
  API_BASE: "/api",
}));

vi.mock("../src/api/userSettings", () => ({
  loadUserSettings: vi.fn(async () => null),
}));

import TaskItem from "../src/components/TaskItem";
import TaskRows from "../src/components/TaskRows";
import { AppThemeProvider, useThemeMode } from "../src/hooks/useTheme";
import { FoldProvider } from "../src/hooks/useFold";
import { buildTheme } from "../src/theme/theme";
import type { Task } from "../src/types/models";

function task(overrides: Partial<Task>): Task {
  return {
    id: 1, list_id: null, area_id: 1, title: "t", notes: null, priority: "none", due_date: null, due_time: null,
    remind_at: null, reminded_at: null, recurrence: "none", recurrence_interval: 1, completed: 0, completed_at: null,
    recurred_from_id: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", ...overrides,
  };
}

const separator = (title: string) => {
  const column = screen.getByText(title).closest(".task-text")!;
  return getComputedStyle(column).borderBottomStyle;
};

function rows(wrap: boolean) {
  const items = ["First", "Second", "Third"].map((title, i) => {
    const item = <TaskItem key={i} task={task({ id: i + 1, title })} onToggle={() => {}} onOpen={() => {}} hideList />;
    return wrap ? <div key={i}>{item}</div> : item;
  });
  return render(
    <ThemeProvider theme={buildTheme("light")}>
      <MemoryRouter>
        <TaskRows>{items}</TaskRows>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe("TaskRows", () => {
  it("separates every row but the last", () => {
    rows(false);
    expect(separator("First")).toBe("solid");
    expect(separator("Second")).toBe("solid");
    expect(separator("Third")).not.toBe("solid");
  });

  // Completed used to wrap each row in a box of its own, and a rule on the
  // row (`:last-of-type`) then saw every row as the last and drew nothing.
  it("still separates rows when each is wrapped in an element of its own", () => {
    rows(true);
    expect(separator("First")).toBe("solid");
    expect(separator("Second")).toBe("solid");
    expect(separator("Third")).not.toBe("solid");
  });
});

describe("TaskItem", () => {
  it("shows what it is given at the end of the title line", () => {
    render(
      <ThemeProvider theme={buildTheme("light")}>
        <TaskItem task={task({ title: "Filed taxes" })} onToggle={() => {}} onOpen={() => {}} trailing={<span>2h ago</span>} />
      </ThemeProvider>,
    );
    const title = screen.getByText("Filed taxes");
    expect(title.parentElement).toContainElement(screen.getByText("2h ago"));
  });
});

describe("theme-color", () => {
  function Switcher() {
    const { setPreference } = useThemeMode();
    return (
      <>
        <button onClick={() => setPreference("dark")}>dark</button>
        <button onClick={() => setPreference("light")}>light</button>
      </>
    );
  }

  beforeEach(() => {
    localStorage.clear();
    document.head.innerHTML = `
      <meta name="theme-color" content="#f4f3ef" media="(prefers-color-scheme: light)" />
      <meta name="theme-color" content="#0c1018" media="(prefers-color-scheme: dark)" />`;
  });

  const colours = () => [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.getAttribute("content"));

  it("follows the theme chosen in Settings, not just the system's", async () => {
    render(
      <FoldProvider>
        <AppThemeProvider>
          <Switcher />
        </AppThemeProvider>
      </FoldProvider>,
    );
    screen.getByText("dark").click();
    await waitFor(() => expect(colours()).toEqual(["#0c1018", "#0c1018"]));
    screen.getByText("light").click();
    await waitFor(() => expect(colours()).toEqual(["#f4f3ef", "#f4f3ef"]));
  });
});
