import { api } from "./client";
import type { UserSettings } from "../types/models";

/**
 * The settings row, fetched once per page load and shared.
 *
 * Several providers mount at the same time and all want the same row, so the
 * promise is memoized rather than the request repeated. Resolves to null when
 * the call fails — settings are a preference, never a reason to block the app.
 */
let pending: Promise<UserSettings | null> | null = null;

export function loadUserSettings(): Promise<UserSettings | null> {
  pending ??= api.get<UserSettings>("/settings").catch(() => null);
  return pending;
}

/** Forget the cached row so the next load refetches. For tests. */
export function resetUserSettingsCache(): void {
  pending = null;
}
