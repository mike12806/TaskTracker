import { useSyncExternalStore } from "react";
import { getStaleSince, subscribeFreshness } from "../api/freshness";

/**
 * When the data currently on screen was generated (local ms timestamp), or
 * `null` while refreshes are succeeding.
 *
 * Non-null means the last attempt to reach the server failed, so the screen
 * is only as current as the last refresh that worked — entries logged on
 * another caregiver's phone since then aren't here. Surfaced by `Layout` as
 * a banner.
 */
export function useDataFreshness(): { staleSince: number | null } {
  const staleSince = useSyncExternalStore(subscribeFreshness, getStaleSince, getStaleSince);
  return { staleSince };
}
