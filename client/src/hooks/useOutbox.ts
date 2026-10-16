import { useMemo, useSyncExternalStore } from "react";
import {
  getOutboxSnapshot,
  pendingRowsFor,
  subscribeOutbox,
  type OutboxEntry,
  type OutboxResource,
  type PendingRow,
} from "../api/outbox";

/**
 * The whole queue of entries logged on this device that the server hasn't
 * taken yet, re-rendering whenever it changes — including when the change was
 * made by another tab.
 */
export function useOutbox(): OutboxEntry[] {
  return useSyncExternalStore(subscribeOutbox, getOutboxSnapshot, getOutboxSnapshot);
}

/**
 * This device's unsent creates, shaped like the rows the server returns so a
 * page can render them alongside the real ones.
 *
 * The rows these produce always have a negative `id` — see `isPending` — and
 * every caller is responsible for making that visible and for not offering
 * them an edit the server could not possibly satisfy.
 */
export function usePendingRows<T>(resource: OutboxResource): (T & PendingRow)[] {
  const entries = useOutbox();
  return useMemo(
    () => pendingRowsFor<T>(resource),
    // `entries` is the change signal — `pendingRowsFor` reads the same cached
    // snapshot, so a new identity there is exactly when this must recompute.
    [entries, resource],
  );
}
