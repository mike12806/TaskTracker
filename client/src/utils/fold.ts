/**
 * Where the fold is, if the screen has one.
 *
 * Written for the iPhone Duo, Apple's book-style foldable: open flat it is a
 * landscape inner display of roughly 890 × 626 points with the crease running
 * down the middle; closed it is an ordinary phone (about 466 × 678). Open, a
 * phone layout stretched across both halves puts the crease through every
 * card, and the bottom nav's centre button lands right on it, so the app lays
 * itself out as two panes, one per half.
 *
 * Two browser APIs describe the fold properly, the Viewport Segments API
 * (`window.viewport.segments`) and the Device Posture API
 * (`navigator.devicePosture`). Safari 27.1 ships both only behind feature
 * flags, which nobody turns on, so neither can be required:
 *
 * - When the browser reports two segments, their geometry is used as-is,
 *   including any hinge gap. That covers the flag being on, a later Safari
 *   that ships it, and Chrome on Android foldables.
 * - Otherwise the fold is inferred from the shape of the screen: an Apple
 *   touch screen whose short side is at least 560 points is the inner display
 *   of a foldable, because no slab iPhone is wider than 440 and no iPad is
 *   shorter than 1133 on its long side. The crease is at its centre.
 *
 * The inference only splits a page that spans the whole display, because
 * only then is the page's centre the crease: in a split-screen window the
 * app is just a narrower app. Pure functions so the rules can be tested
 * without a device; `hooks/useFold.tsx` feeds them from the window.
 */

export interface FoldSegment {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Two panes side by side — the inner display held open like a book. */
export interface FoldColumns {
  kind: "columns";
  /** Width of the pane left of the fold, in CSS px from the viewport's left edge. */
  start: number;
  /** Width of the fold itself: 0 for a crease, the hinge for a device that reports one. */
  hinge: number;
  /** Width of the pane right of the fold, to the viewport's right edge. */
  end: number;
  /** Measured by the browser, or inferred from the screen's shape. */
  source: "segments" | "inferred";
}

/** One pane above the other — the inner display turned sideways and half-closed. */
export interface FoldRows {
  kind: "rows";
  top: number;
  hinge: number;
  bottom: number;
  source: "segments" | "inferred";
}

export type FoldLayout = { kind: "single" } | FoldColumns | FoldRows;

export const SINGLE: FoldLayout = { kind: "single" };

export interface FoldInputs {
  viewportWidth: number;
  viewportHeight: number;
  screenWidth: number;
  screenHeight: number;
  userAgent: string;
  maxTouchPoints: number;
  /** `window.viewport.segments`, or null where the API is missing. */
  segments: readonly FoldSegment[] | null;
  /** `navigator.devicePosture.type`, or null where the API is missing. */
  posture: "continuous" | "folded" | null;
}

/**
 * Narrower than this and a pane can't hold the phone layout it is given, so
 * the page stays whole. Each half of the iPhone Duo is about 445.
 */
export const MIN_PANE_WIDTH = 320;
/** The same floor for a pane above or below a horizontal fold. */
export const MIN_PANE_HEIGHT = 240;

/** A slab iPhone is at most 440 points across; a foldable's inner display is not. */
const INNER_DISPLAY_MIN_SHORT_SIDE = 560;
/** The smallest iPad's long side is 1133, so anything under this is a phone. */
const INNER_DISPLAY_MAX_LONG_SIDE = 1000;
/**
 * How much of the display the page must cover before its centre is taken to
 * be the crease — slack for safe-area insets and rounding, not for a
 * split-screen window, which is far narrower than this.
 */
const SPANS_DISPLAY = 0.9;

function isAppleTouch(userAgent: string, maxTouchPoints: number): boolean {
  // An iPad, and an iPhone asking for desktop sites, call themselves a Mac;
  // a real Mac has no touch points.
  return /iPhone/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

/** Is this screen the inner display of a book-style foldable iPhone? */
export function isFoldableInnerDisplay(i: FoldInputs): boolean {
  if (!isAppleTouch(i.userAgent, i.maxTouchPoints)) return false;
  const short = Math.min(i.screenWidth, i.screenHeight);
  const long = Math.max(i.screenWidth, i.screenHeight);
  return short >= INNER_DISPLAY_MIN_SHORT_SIDE && long <= INNER_DISPLAY_MAX_LONG_SIDE;
}

function columns(start: number, hinge: number, end: number, source: FoldColumns["source"]): FoldLayout {
  if (start < MIN_PANE_WIDTH || end < MIN_PANE_WIDTH) return SINGLE;
  return { kind: "columns", start, hinge, end, source };
}

function rows(top: number, hinge: number, bottom: number, source: FoldRows["source"]): FoldLayout {
  if (top < MIN_PANE_HEIGHT || bottom < MIN_PANE_HEIGHT) return SINGLE;
  return { kind: "rows", top, hinge, bottom, source };
}

/** The browser's own report, when it has two segments to give. */
function fromSegments(i: FoldInputs): FoldLayout | null {
  if (!i.segments || i.segments.length !== 2) return null;
  const [a, b] = [...i.segments].sort((x, y) => x.left - y.left || x.top - y.top);
  const aRight = a.left + a.width;
  const aBottom = a.top + a.height;
  // Measured to the viewport's edges rather than taken from each segment's
  // width, so the three parts always add up to the page.
  if (b.left >= aRight - 1) {
    const start = Math.round(aRight);
    const hinge = Math.max(0, Math.round(b.left - aRight));
    return columns(start, hinge, i.viewportWidth - start - hinge, "segments");
  }
  if (b.top >= aBottom - 1) {
    const top = Math.round(aBottom);
    const hinge = Math.max(0, Math.round(b.top - aBottom));
    return rows(top, hinge, i.viewportHeight - top - hinge, "segments");
  }
  return null;
}

function inferred(i: FoldInputs): FoldLayout {
  // A device that says it is folded has its crease across the middle whatever
  // it is; otherwise only the iPhone Duo's inner display is assumed to have one.
  const folded = i.posture === "folded";
  if (!folded && !isFoldableInnerDisplay(i)) return SINGLE;
  const long = Math.max(i.screenWidth, i.screenHeight);
  if (i.viewportWidth > i.viewportHeight) {
    if (i.viewportWidth < long * SPANS_DISPLAY) return SINGLE;
    const start = Math.floor(i.viewportWidth / 2);
    return columns(start, 0, i.viewportWidth - start, "inferred");
  }
  // Turned sideways the crease runs across the page. Opened flat that is just
  // a tall screen, and one column suits it; only a device that says it is
  // half-closed, like a laptop, gets a top and a bottom.
  if (!folded || i.viewportHeight < long * SPANS_DISPLAY) return SINGLE;
  const top = Math.floor(i.viewportHeight / 2);
  return rows(top, 0, i.viewportHeight - top, "inferred");
}

export function computeFold(i: FoldInputs): FoldLayout {
  return fromSegments(i) ?? inferred(i);
}

export function sameFold(a: FoldLayout, b: FoldLayout): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "columns" && b.kind === "columns") {
    return a.start === b.start && a.hinge === b.hinge && a.end === b.end && a.source === b.source;
  }
  if (a.kind === "rows" && b.kind === "rows") {
    return a.top === b.top && a.hinge === b.hinge && a.bottom === b.bottom && a.source === b.source;
  }
  return true;
}

/**
 * How much wider the viewport is than the narrower pane. Every breakpoint in
 * the theme is pushed out by this, so `sm`, `md` and every `useMediaQuery`
 * answer for one pane rather than for the whole page — which is what lets
 * every existing screen render its phone layout inside a half without each one
 * being taught about folds.
 */
export function paneBreakpointOffset(fold: FoldLayout): number {
  if (fold.kind !== "columns") return 0;
  return fold.start + fold.hinge + fold.end - Math.min(fold.start, fold.end);
}
