import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ThemeProvider, createTheme } from "@mui/material/styles";
import ErrorBoundary from "../src/components/ErrorBoundary";

const theme = createTheme();

function Boom(): never {
  throw new Error("grouped is not a function");
}

function BoomWithMessage({ message }: { message: string }): never {
  throw new Error(message);
}

let consoleError: ReturnType<typeof vi.spyOn>;
let reloadSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // React logs the caught error itself; silence it so a passing run is quiet.
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  sessionStorage.clear();
  reloadSpy = vi.fn();
  vi.stubGlobal("location", { ...window.location, reload: reloadSpy });
});

afterEach(() => {
  consoleError.mockRestore();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function renderBoundary(children: React.ReactNode, scope?: string) {
  return render(
    <ThemeProvider theme={theme}>
      <ErrorBoundary scope={scope}>{children}</ErrorBoundary>
    </ThemeProvider>,
  );
}

describe("ErrorBoundary", () => {
  it("renders its children when nothing throws", () => {
    renderBoundary(<p>All fine</p>);

    expect(screen.getByText("All fine")).toBeInTheDocument();
  });

  it("shows the error instead of blanking the screen", () => {
    renderBoundary(<Boom />);

    // The message is the whole point: a white screen reports nothing, on the
    // device or anywhere else.
    expect(screen.getByText("grouped is not a function")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
  });

  it("shows the build id, so a crash report says which build crashed", () => {
    renderBoundary(<Boom />);

    // An installed PWA can sit builds behind, so "is this bug still shipping?"
    // is unanswerable without it.
    expect(screen.getByText(/Build test/)).toBeInTheDocument();
  });

  it("uses the caller's scope wording", () => {
    renderBoundary(<Boom />, "This page failed to load");

    expect(screen.getByText("This page failed to load")).toBeInTheDocument();
  });

  it("logs the error and component stack for the console record", () => {
    renderBoundary(<Boom />);

    expect(consoleError).toHaveBeenCalledWith(
      "Unhandled render error",
      expect.objectContaining({ message: "grouped is not a function" }),
      expect.any(String),
    );
  });

  it("reloads instead of showing the crash card for a stale chunk load", () => {
    vi.useFakeTimers();
    renderBoundary(
      <BoomWithMessage message="'text/html' is not a valid JavaScript MIME type." />,
    );

    // The first retry is immediate — usually the new index.html is already
    // there and one reload is the whole fix.
    expect(screen.getByText("Updating to the latest version…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reload" })).not.toBeInTheDocument();
    vi.advanceTimersByTime(0);
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it("reloads for the other browsers' chunk-load wording too", () => {
    vi.useFakeTimers();
    renderBoundary(
      <BoomWithMessage message="Failed to fetch dynamically imported module: https://app/assets/ActivityPage.js" />,
    );

    vi.advanceTimersByTime(0);
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  /**
   * The failure that stranded a device seconds after a deploy: the shell was
   * new, but the edge was still answering the new chunk URL with index.html.
   * Retrying in the same millisecond gets the same stale answer, so the one
   * allowed reload was spent before anything could have changed.
   */
  it("waits before retrying, so a deploy in flight has time to settle", () => {
    vi.useFakeTimers();
    sessionStorage.setItem("chunkReloadBuild", "test:1");

    renderBoundary(
      <BoomWithMessage message="'text/html' is not a valid JavaScript MIME type." />,
    );

    vi.advanceTimersByTime(4_000);
    expect(reloadSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it("falls back to the manual crash card once the build's retries are spent", () => {
    vi.useFakeTimers();
    sessionStorage.setItem("chunkReloadBuild", "test:3");

    renderBoundary(
      <BoomWithMessage message="'text/html' is not a valid JavaScript MIME type." />,
    );
    vi.advanceTimersByTime(60_000);

    // Past this point it is a broken deploy or a dead network, not one in
    // flight, and looping on it would never end.
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(
      screen.getByText("'text/html' is not a valid JavaScript MIME type."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
  });

  it("counts retries per build, so a device reloading into a new one starts fresh", () => {
    vi.useFakeTimers();
    sessionStorage.setItem("chunkReloadBuild", "older-build:3");

    renderBoundary(
      <BoomWithMessage message="'text/html' is not a valid JavaScript MIME type." />,
    );
    vi.advanceTimersByTime(0);

    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending reload if the user navigates away first", () => {
    vi.useFakeTimers();
    sessionStorage.setItem("chunkReloadBuild", "test:1");

    const { unmount } = renderBoundary(
      <BoomWithMessage message="'text/html' is not a valid JavaScript MIME type." />,
    );
    // The nav stays live around the failure, so leaving before the retry
    // lands must not yank the page out from under them seconds later.
    unmount();
    vi.advanceTimersByTime(60_000);

    expect(reloadSpy).not.toHaveBeenCalled();
  });
});
