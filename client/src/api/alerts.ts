import { api } from "./client";
import type { Alert } from "../types/models";

export interface AlertFeed {
  alerts: Alert[];
  /** How many have arrived since this user last opened the drawer. */
  unread: number;
  last_read_at: string | null;
}

const EMPTY: AlertFeed = { alerts: [], unread: 0, last_read_at: null };

/**
 * The alerts feed.
 *
 * `getOptional` on purpose: the bell is not what anyone opened the app to
 * read, so a failure here must not raise the stale-data banner or arm the
 * refresh-retry loop — same reasoning as the daily note (see `FetchFlags` in
 * `client.ts`). The feed is still never cached: like every other read here it
 * comes from the server or not at all.
 */
export async function fetchAlerts(): Promise<AlertFeed> {
  const feed = await api.getOptional<AlertFeed>("/alerts");
  // Defensive about the shape rather than trusting it: this renders inside the
  // app's chrome on every screen, so a reply that isn't what we expect should
  // cost the bell its badge, not take the shell down with it.
  return Array.isArray(feed?.alerts)
    ? { alerts: feed.alerts, unread: feed.unread ?? 0, last_read_at: feed.last_read_at ?? null }
    : EMPTY;
}

/**
 * Mark the feed read as far as `upTo` — the timestamp of the newest alert that
 * was actually on screen, not "now", so an alert raised between the fetch and
 * the tap stays unread rather than being silently cleared.
 */
export function markAlertsRead(upTo: string | null): Promise<{ last_read_at: string }> {
  return api.postOptional<{ last_read_at: string }>("/alerts/read", upTo ? { up_to: upTo } : {});
}

/**
 * Take one alert off this user's feed.
 *
 * `post`, not `postOptional`, unlike the read mark above: this one is a
 * deliberate action with a visible result, so if the server can't be reached
 * the app should say so in the usual way rather than quietly pretending the
 * row is gone. The caller puts the row back when this rejects.
 */
export function dismissAlert(id: number): Promise<{ ok: boolean }> {
  return api.post<{ ok: boolean }>(`/alerts/${id}/dismiss`, {});
}

/** Undo a dismissal. */
export function restoreAlert(id: number): Promise<{ ok: boolean }> {
  return api.post<{ ok: boolean }>(`/alerts/${id}/restore`, {});
}

/**
 * Put an alert back in front of the read mark, so it (and anything raised
 * since it) counts as unread again.
 */
export function unreadAlert(id: number): Promise<{ ok: boolean; last_read_at: string }> {
  return api.post<{ ok: boolean; last_read_at: string }>(`/alerts/${id}/unread`, {});
}
