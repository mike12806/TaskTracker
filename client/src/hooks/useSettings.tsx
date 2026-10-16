import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { loadUserSettings } from "../api/userSettings";
import { updateSettings } from "../api/tasks";
import type { UserSettings } from "../types/models";

interface SettingsContextValue {
  settings: UserSettings | null;
  update: (changes: Partial<Omit<UserSettings, "user_id">>) => Promise<void>;
}

const SettingsContext = createContext<SettingsContextValue>({
  settings: null,
  update: async () => {},
});

/** The device's own IANA zone, or null where the browser won't say. */
export function deviceTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/**
 * The settings row, plus one piece of upkeep: keeping the server's timezone in
 * step with the device's.
 *
 * Due dates are calendar dates, and the server does arithmetic on them —
 * "what is today" for the briefing, the next occurrence of a recurring task,
 * the digest hour. Those have to agree with the dates this device shows, and
 * the device's clock is the one the user is actually living by, so wherever
 * the app is opened becomes the timezone. Travel follows automatically.
 */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<UserSettings | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadUserSettings().then(async (row) => {
      if (cancelled || !row) return;
      setSettings(row);
      const tz = deviceTimezone();
      if (tz && tz !== row.timezone) {
        try {
          const synced = await updateSettings({ timezone: tz });
          if (!cancelled) setSettings(synced);
        } catch {
          // Next launch will try again; nothing on screen depends on it.
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback(async (changes: Partial<Omit<UserSettings, "user_id">>) => {
    const next = await updateSettings(changes);
    setSettings(next);
  }, []);

  return <SettingsContext.Provider value={{ settings, update }}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  return useContext(SettingsContext);
}
