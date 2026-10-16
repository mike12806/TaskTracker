import { Component, type ErrorInfo, type ReactNode } from "react";
import { Box, Button, Stack, Typography } from "@mui/material";
import ReportProblemOutlinedIcon from "@mui/icons-material/ReportProblemOutlined";

/**
 * Catches a render error and shows it, instead of letting React unmount the
 * tree and leave a blank page.
 *
 * Without one of these, any throw anywhere takes the whole app down to a white
 * screen with nothing on it: no message on the device, nothing in a log, and —
 * because an installed PWA can sit several builds behind — no way to tell a
 * bug that is still shipping from one that was fixed a week ago. The first
 * round of this was a hook-order violation on the section pages, and the only
 * evidence available was "the screen goes white".
 *
 * The build id is on screen deliberately. It is the first thing worth knowing
 * when a crash is reported, and the one thing that is impossible to recover
 * afterwards.
 */
interface Props {
  children: ReactNode;
  /** Shown above the error; defaults to the whole-app wording. */
  scope?: string;
}

interface State {
  error: Error | null;
  /** Set once an automatic reload has been triggered for a chunk-load failure. */
  reloading: boolean;
}

/**
 * A lazy route chunk from a build that's no longer served. Each page is
 * `React.lazy`-loaded (see `App.tsx`), and a device can still be showing the
 * app shell from a build whose JS chunks were deleted from the server by a
 * later deploy — the fetch for the chunk 404s, the server answers with the
 * SPA's `index.html` fallback instead, and the browser refuses to run HTML as
 * a module. Every engine phrases that refusal differently, hence the list.
 *
 * This is not a bug in the page that failed to load — the fix is just to
 * fetch the current `index.html`, which is what a reload does. Unlike the
 * service worker's `onNeedReload` signal (deferred until it can't cost
 * anyone a half-typed form, see `deferredReload.ts`), this page is already
 * blank/crashed, so there is nothing a reload could still destroy.
 */
const CHUNK_LOAD_ERROR_PATTERN =
  /dynamically imported module|error loading dynamically imported module|importing a module script failed|is not a valid javascript mime type/i;

/** sessionStorage key: `<build id>:<auto-reloads already spent on it>`. */
const CHUNK_RELOAD_KEY = "chunkReloadBuild";

/**
 * How long to wait before each successive auto-reload, and — by its length —
 * how many to allow per build.
 *
 * One immediate reload is not enough. A deploy is not a single instant: the
 * new `index.html` goes live before the edge stops answering the new chunk
 * URLs from cache, so a device that loads mid-deploy gets the new shell and a
 * stale answer for its chunks, and retrying in the same millisecond just gets
 * the same stale answer. That is exactly the window a reload has to outlast,
 * and it closes in seconds rather than instantly — so the retries spread out
 * to cover it (immediately, then +5s, then +15s) instead of spending the only
 * attempt before anything can have changed.
 *
 * It stays bounded: after the last one the app stops reloading itself and
 * shows the card with the manual button, because past this point the cause is
 * not a deploy in flight — it is a broken deploy or a dead network, and
 * neither is fixed by looping.
 */
const CHUNK_RELOAD_DELAYS_MS = [0, 5_000, 15_000];

function isChunkLoadError(error: Error): boolean {
  return CHUNK_LOAD_ERROR_PATTERN.test(error.message);
}

/**
 * How long to wait before the next auto-reload, or null when this build has
 * used them all up (or storage is unavailable, so spent attempts can't be
 * counted and looping can't be ruled out).
 *
 * The count is keyed by build id: a device that reloads into a *different*
 * build has escaped the failure that was being retried, and starts fresh.
 */
function nextChunkReloadDelay(): number | null {
  try {
    const [build, spent] = (sessionStorage.getItem(CHUNK_RELOAD_KEY) ?? "").split(":");
    const attempts = build === __BUILD_ID__ ? Number(spent) || 0 : 0;
    if (attempts >= CHUNK_RELOAD_DELAYS_MS.length) return null;
    sessionStorage.setItem(CHUNK_RELOAD_KEY, `${__BUILD_ID__}:${attempts + 1}`);
    return CHUNK_RELOAD_DELAYS_MS[attempts];
  } catch {
    return null;
  }
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, reloading: false };

  private reloadTimer: ReturnType<typeof setTimeout> | null = null;

  static getDerivedStateFromError(error: Error): State {
    return { error, reloading: false };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Nothing collects these centrally yet, so the console is the only record
    // there is. Keep the component stack — it is what names the culprit.
    console.error("Unhandled render error", error, info.componentStack);

    if (!isChunkLoadError(error)) return;

    const delay = nextChunkReloadDelay();
    if (delay === null) return;

    // Skip the alarming crash card for a case that isn't really a crash —
    // just an app shell fetching a chunk out from under it. The reload
    // navigates away, so this state never has to be unwound.
    this.setState({ reloading: true });
    this.reloadTimer = setTimeout(() => window.location.reload(), delay);
  }

  componentWillUnmount(): void {
    // Navigating away from the failed page (the nav stays live around it)
    // cancels the pending reload — the user has moved on, and pulling the
    // page out from under them seconds later would be the bug, not the fix.
    if (this.reloadTimer !== null) clearTimeout(this.reloadTimer);
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error, reloading } = this.state;
    if (!error) return this.props.children;

    if (reloading) {
      return (
        <Box sx={{ p: 3, maxWidth: 680, mx: "auto", textAlign: "center" }}>
          <Typography color="text.secondary">Updating to the latest version…</Typography>
        </Box>
      );
    }

    return (
      <Box sx={{ p: 3, maxWidth: 680, mx: "auto", textAlign: "center" }}>
        <ReportProblemOutlinedIcon sx={{ fontSize: 56, color: "warning.main", mb: 1.5 }} />
        <Typography variant="h6" sx={{ mb: 1 }}>
          {this.props.scope ?? "Something went wrong"}
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          The screen below this point failed to render. Nothing you have logged
          is affected.
        </Typography>

        <Box
          component="pre"
          sx={{
            textAlign: "left",
            p: 1.5,
            mb: 2,
            borderRadius: 2,
            bgcolor: "action.hover",
            border: 1,
            borderColor: "divider",
            fontSize: 12,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            overflowX: "auto",
          }}
        >
          {error.message || String(error)}
        </Box>

        <Stack direction="row" spacing={1} sx={{ justifyContent: "center", mb: 2 }}>
          <Button variant="contained" onClick={this.handleReload}>
            Reload
          </Button>
        </Stack>

        <Typography sx={{ fontSize: 11, color: "text.secondary" }}>
          Build {__BUILD_ID__} · {new Date(__BUILD_TIME__).toLocaleString()}
        </Typography>
      </Box>
    );
  }
}
