import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { fetchLists } from "../api/tasks";
import { useDataRefresh } from "./useDataRefresh";
import type { TaskList } from "../types/models";

interface ListsContextValue {
  lists: TaskList[];
  inboxCount: number;
  /** Open Inbox tasks per area id — each area has its own Inbox. */
  inboxCounts: Record<string, number>;
  loaded: boolean;
  listById: (id: number | null) => TaskList | undefined;
}

const ListsContext = createContext<ListsContextValue>({
  lists: [],
  inboxCount: 0,
  inboxCounts: {},
  loaded: false,
  listById: () => undefined,
});

/**
 * The user's lists, for the drawer and every task row's list badge.
 *
 * Refetched on `refreshKey` like every other read — never cached, so a list
 * renamed on the laptop is renamed here on the next nudge. A failed fetch
 * keeps what was last shown; the stale banner says so.
 */
export function ListsProvider({ children }: { children: ReactNode }) {
  const { refreshKey } = useDataRefresh();
  const [lists, setLists] = useState<TaskList[]>([]);
  const [inboxCount, setInboxCount] = useState(0);
  const [inboxCounts, setInboxCounts] = useState<Record<string, number>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchLists()
      .then((res) => {
        if (cancelled) return;
        setLists(res.lists);
        setInboxCount(res.inbox_count);
        setInboxCounts(res.inbox_counts ?? {});
        setLoaded(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const listById = useCallback((id: number | null) => (id === null ? undefined : lists.find((l) => l.id === id)), [lists]);

  return <ListsContext.Provider value={{ lists, inboxCount, inboxCounts, loaded, listById }}>{children}</ListsContext.Provider>;
}

export function useLists() {
  return useContext(ListsContext);
}
