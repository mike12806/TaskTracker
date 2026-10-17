import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchAreas } from "../api/tasks";
import { useDataRefresh } from "./useDataRefresh";
import type { Area } from "../types/models";

/** Which area the app is showing: one of them, or everything. */
export type AreaSelection = number | "all";

const STORAGE_KEY = "tasktracker.area";

interface AreasContextValue {
  areas: Area[];
  loaded: boolean;
  selected: AreaSelection;
  select: (selection: AreaSelection) => void;
  areaById: (id: number | null | undefined) => Area | undefined;
  /** Whether something in `areaId` belongs on screen under the current selection. */
  inSelection: (areaId: number | null | undefined) => boolean;
  /**
   * Where a new task or list goes when nothing else says: the selected area,
   * or the first one while showing everything.
   */
  defaultAreaId: number | undefined;
}

const AreasContext = createContext<AreasContextValue>({
  areas: [],
  loaded: false,
  selected: "all",
  select: () => {},
  areaById: () => undefined,
  inSelection: () => true,
  defaultAreaId: undefined,
});

function readStored(): AreaSelection {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw || raw === "all") return "all";
    const id = Number(raw);
    return Number.isInteger(id) && id > 0 ? id : "all";
  } catch {
    return "all";
  }
}

/**
 * The user's areas, and which one this device is showing.
 *
 * The selection is per device on purpose — the laptop can live in Work while
 * the phone shows everything — so it is kept in localStorage, not settings.
 * It is a view filter only: nothing is hidden from the server, and reminders
 * fire for every area whatever is selected here.
 *
 * Refetched on `refreshKey` like every read. If the selected area disappears
 * (deleted on another device) the selection falls back to everything rather
 * than showing an empty app.
 */
export function AreasProvider({ children }: { children: ReactNode }) {
  const { refreshKey } = useDataRefresh();
  const [areas, setAreas] = useState<Area[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<AreaSelection>(readStored);

  useEffect(() => {
    let cancelled = false;
    fetchAreas()
      .then((rows) => {
        if (cancelled) return;
        setAreas(rows);
        setLoaded(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const select = useCallback((selection: AreaSelection) => {
    setSelected(selection);
    try {
      localStorage.setItem(STORAGE_KEY, String(selection));
    } catch {
      // A preference, not data: losing it on a full disk costs nothing.
    }
  }, []);

  // A stale selection (area deleted elsewhere) shows everything instead.
  const effective: AreaSelection = selected !== "all" && loaded && !areas.some((a) => a.id === selected) ? "all" : selected;

  const value = useMemo<AreasContextValue>(() => {
    const areaById = (id: number | null | undefined) => (id == null ? undefined : areas.find((a) => a.id === id));
    return {
      areas,
      loaded,
      selected: effective,
      select,
      areaById,
      inSelection: (areaId) => effective === "all" || areaId === effective,
      defaultAreaId: effective === "all" ? areas[0]?.id : effective,
    };
  }, [areas, loaded, effective, select]);

  return <AreasContext.Provider value={value}>{children}</AreasContext.Provider>;
}

export function useAreas() {
  return useContext(AreasContext);
}
