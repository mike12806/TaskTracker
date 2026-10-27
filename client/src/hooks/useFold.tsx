import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { computeFold, sameFold, SINGLE, type FoldInputs, type FoldLayout, type FoldSegment } from "../utils/fold";

// Neither API is in TypeScript's DOM library yet.
interface ViewportSegments {
  segments?: readonly FoldSegment[] | null;
}
interface DevicePosture extends EventTarget {
  type?: string;
}

function readInputs(): FoldInputs {
  const viewport = (window as Window & { viewport?: ViewportSegments }).viewport;
  const posture = (navigator as Navigator & { devicePosture?: DevicePosture }).devicePosture?.type;
  return {
    // clientWidth rather than innerWidth: a scrollbar is not part of either pane.
    viewportWidth: document.documentElement.clientWidth || window.innerWidth,
    viewportHeight: window.innerHeight,
    screenWidth: window.screen?.width ?? 0,
    screenHeight: window.screen?.height ?? 0,
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    segments: viewport?.segments ?? null,
    posture: posture === "folded" || posture === "continuous" ? posture : null,
  };
}

function measure(): FoldLayout {
  try {
    return computeFold(readInputs());
  } catch {
    return SINGLE;
  }
}

const FoldContext = createContext<FoldLayout>(SINGLE);

/**
 * Where the fold is right now — see `utils/fold.ts`. Opening, closing or
 * turning the phone resizes the window, and half-closing it changes the
 * segments and the posture without resizing anything, so all three are
 * listened to. The value only changes identity when the fold actually moves,
 * because the theme is rebuilt from it.
 */
export function FoldProvider({ children }: { children: ReactNode }) {
  const [fold, setFold] = useState<FoldLayout>(measure);

  useEffect(() => {
    let frame = 0;
    // One measurement per frame: opening the phone fires a resize, an
    // orientation change and a segment change together.
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = measure();
        setFold((prev) => (sameFold(prev, next) ? prev : next));
      });
    };
    const posture = (navigator as Navigator & { devicePosture?: DevicePosture }).devicePosture;
    const segmentQueries =
      typeof window.matchMedia === "function"
        ? ["(horizontal-viewport-segments: 2)", "(vertical-viewport-segments: 2)"].map((q) => window.matchMedia(q))
        : [];

    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    posture?.addEventListener("change", update);
    segmentQueries.forEach((mq) => mq?.addEventListener?.("change", update));
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
      posture?.removeEventListener("change", update);
      segmentQueries.forEach((mq) => mq?.removeEventListener?.("change", update));
    };
  }, []);

  return <FoldContext.Provider value={fold}>{children}</FoldContext.Provider>;
}

export function useFold(): FoldLayout {
  return useContext(FoldContext);
}
