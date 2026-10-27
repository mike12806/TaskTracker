import { describe, it, expect } from "vitest";
import { computeFold, paneBreakpointOffset, sameFold, SINGLE, type FoldInputs } from "../src/utils/fold";

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 27_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.1 Mobile/15E148 Safari/604.1";
const IPAD_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.1 Safari/605.1.15";
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

/** The iPhone Duo open flat and held like a book, installed to the Home Screen. */
const duoOpen: FoldInputs = {
  viewportWidth: 890,
  viewportHeight: 626,
  screenWidth: 626,
  screenHeight: 890,
  userAgent: IPHONE_UA,
  maxTouchPoints: 5,
  segments: null,
  posture: null,
};

describe("computeFold", () => {
  it("splits the iPhone Duo's inner display down the middle", () => {
    expect(computeFold(duoOpen)).toEqual({ kind: "columns", start: 445, hinge: 0, end: 445, source: "inferred" });
  });

  it("splits it whichever way round iOS reports the screen", () => {
    expect(computeFold({ ...duoOpen, screenWidth: 890, screenHeight: 626 })).toMatchObject({ kind: "columns", start: 445 });
  });

  it("keeps the three parts adding up to the page on an odd width", () => {
    const fold = computeFold({ ...duoOpen, viewportWidth: 891 });
    expect(fold).toMatchObject({ kind: "columns", start: 445, hinge: 0, end: 446 });
  });

  it("still finds the crease when Safari asks for desktop sites and calls the phone a Mac", () => {
    expect(computeFold({ ...duoOpen, userAgent: IPAD_UA })).toMatchObject({ kind: "columns" });
  });

  it("leaves the outer display alone", () => {
    expect(
      computeFold({ ...duoOpen, viewportWidth: 466, viewportHeight: 678, screenWidth: 466, screenHeight: 678 }),
    ).toEqual(SINGLE);
  });

  it("leaves the outer display alone in landscape too", () => {
    expect(
      computeFold({ ...duoOpen, viewportWidth: 678, viewportHeight: 466, screenWidth: 466, screenHeight: 678 }),
    ).toEqual(SINGLE);
  });

  it("does not split the largest slab iPhone on its side", () => {
    expect(
      computeFold({ ...duoOpen, viewportWidth: 956, viewportHeight: 440, screenWidth: 440, screenHeight: 956 }),
    ).toEqual(SINGLE);
  });

  it("does not split an iPad mini on its side", () => {
    expect(
      computeFold({
        ...duoOpen,
        userAgent: IPAD_UA,
        viewportWidth: 1133,
        viewportHeight: 744,
        screenWidth: 744,
        screenHeight: 1133,
      }),
    ).toEqual(SINGLE);
  });

  it("does not split a Mac, which has no touch points", () => {
    expect(computeFold({ ...duoOpen, userAgent: IPAD_UA, maxTouchPoints: 0 })).toEqual(SINGLE);
  });

  it("does not split a desktop window sized like the Duo", () => {
    expect(
      computeFold({ ...duoOpen, userAgent: DESKTOP_UA, maxTouchPoints: 0, screenWidth: 1920, screenHeight: 1080 }),
    ).toEqual(SINGLE);
  });

  it("does not split a split-screen window, whose centre is not the crease", () => {
    expect(computeFold({ ...duoOpen, viewportWidth: 600 })).toEqual(SINGLE);
  });

  it("keeps the inner display in one column when it is turned sideways and flat", () => {
    expect(computeFold({ ...duoOpen, viewportWidth: 626, viewportHeight: 890 })).toEqual(SINGLE);
  });

  it("gives a half-closed, sideways inner display a top and a bottom", () => {
    expect(computeFold({ ...duoOpen, viewportWidth: 626, viewportHeight: 890, posture: "folded" })).toEqual({
      kind: "rows",
      top: 445,
      hinge: 0,
      bottom: 445,
      source: "inferred",
    });
  });

  it("trusts a device that says it is folded, whatever it is", () => {
    expect(
      computeFold({
        ...duoOpen,
        userAgent: DESKTOP_UA,
        viewportWidth: 840,
        viewportHeight: 700,
        screenWidth: 840,
        screenHeight: 700,
        posture: "folded",
      }),
    ).toMatchObject({ kind: "columns", start: 420, end: 420 });
  });

  it("uses the browser's segments when it reports them, hinge included", () => {
    const fold = computeFold({
      ...duoOpen,
      userAgent: DESKTOP_UA,
      segments: [
        { left: 0, top: 0, width: 430, height: 626 },
        { left: 460, top: 0, width: 430, height: 626 },
      ],
    });
    expect(fold).toEqual({ kind: "columns", start: 430, hinge: 30, end: 430, source: "segments" });
  });

  it("reads segments in whatever order they come", () => {
    const fold = computeFold({
      ...duoOpen,
      segments: [
        { left: 445, top: 0, width: 445, height: 626 },
        { left: 0, top: 0, width: 445, height: 626 },
      ],
    });
    expect(fold).toEqual({ kind: "columns", start: 445, hinge: 0, end: 445, source: "segments" });
  });

  it("reads stacked segments as rows", () => {
    const fold = computeFold({
      ...duoOpen,
      viewportWidth: 626,
      viewportHeight: 890,
      segments: [
        { left: 0, top: 0, width: 626, height: 440 },
        { left: 0, top: 450, width: 626, height: 440 },
      ],
    });
    expect(fold).toEqual({ kind: "rows", top: 440, hinge: 10, bottom: 440, source: "segments" });
  });

  it("falls back to the screen's shape when the browser reports one segment", () => {
    // Opened flat, a foldable reports a single segment — the crease is still there.
    expect(computeFold({ ...duoOpen, segments: [{ left: 0, top: 0, width: 890, height: 626 }] })).toMatchObject({
      kind: "columns",
      source: "inferred",
    });
  });

  it("keeps the page whole when a pane would be too narrow for a phone layout", () => {
    const fold = computeFold({
      ...duoOpen,
      viewportWidth: 600,
      segments: [
        { left: 0, top: 0, width: 300, height: 626 },
        { left: 300, top: 0, width: 300, height: 626 },
      ],
    });
    expect(fold).toEqual(SINGLE);
  });
});

describe("paneBreakpointOffset", () => {
  it("pushes the breakpoints out by the other pane, so they measure one pane", () => {
    // 445 + 600 = 1045: neither half of an 890-wide page reaches `sm`.
    expect(paneBreakpointOffset(computeFold(duoOpen))).toBe(445);
  });

  it("counts the hinge as part of the other pane", () => {
    expect(paneBreakpointOffset({ kind: "columns", start: 430, hinge: 30, end: 430, source: "segments" })).toBe(460);
  });

  it("measures by the narrower pane when they differ", () => {
    expect(paneBreakpointOffset({ kind: "columns", start: 445, hinge: 0, end: 446, source: "inferred" })).toBe(446);
  });

  it("leaves the breakpoints alone with no side-by-side fold", () => {
    expect(paneBreakpointOffset(SINGLE)).toBe(0);
    expect(paneBreakpointOffset({ kind: "rows", top: 445, hinge: 0, bottom: 445, source: "inferred" })).toBe(0);
  });
});

describe("sameFold", () => {
  it("is true for the same geometry, so the theme isn't rebuilt on every resize", () => {
    expect(sameFold(computeFold(duoOpen), computeFold({ ...duoOpen }))).toBe(true);
    expect(sameFold(SINGLE, { kind: "single" })).toBe(true);
  });

  it("is false when the fold moves or appears", () => {
    expect(sameFold(computeFold(duoOpen), computeFold({ ...duoOpen, viewportWidth: 892 }))).toBe(false);
    expect(sameFold(SINGLE, computeFold(duoOpen))).toBe(false);
  });
});
