import { createContext, useContext, useState, useMemo, useCallback, useEffect } from "react";
import { ThemeProvider as MuiThemeProvider } from "@mui/material/styles";
import { buildTheme } from "../theme/theme";
import { api } from "../api/client";
import { loadUserSettings } from "../api/userSettings";

type Mode = "light" | "dark";
type ThemePreference = "system" | "light" | "dark";

interface ThemeContextValue {
  mode: Mode;
  preference: ThemePreference;
  setPreference: (pref: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  mode: "light",
  preference: "system",
  setPreference: () => {},
});

export function useThemeMode() {
  return useContext(ThemeContext);
}

function resolveMode(pref: ThemePreference): Mode {
  if (pref === "system") {
    try {
      if (typeof window.matchMedia === "function") {
        return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      }
    } catch {
      /* noop */
    }
    return "light";
  }
  return pref;
}

function getInitialPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem("theme-preference");
    if (stored === "system" || stored === "dark" || stored === "light") return stored;
    // Migrate old "theme-mode" key
    const legacy = localStorage.getItem("theme-mode");
    if (legacy === "dark" || legacy === "light") return legacy;
    return "system";
  } catch {
    return "system";
  }
}

export function AppThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(getInitialPreference);
  const [mode, setMode] = useState<Mode>(() => resolveMode(getInitialPreference()));

  // Listen for system theme changes when preference is "system"
  useEffect(() => {
    if (preference !== "system") return;
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => setMode(e.matches ? "dark" : "light");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [preference]);

  // Load preference from server settings on mount. The row is shared with the
  // other preference providers, so this costs no extra request.
  useEffect(() => {
    loadUserSettings().then((s) => {
      if (s?.theme_mode) {
        setPreferenceState(s.theme_mode);
        setMode(resolveMode(s.theme_mode));
        try {
          localStorage.setItem("theme-preference", s.theme_mode);
        } catch { /* noop */ }
      }
    });
  }, []);

  const setPreference = useCallback((pref: ThemePreference) => {
    setPreferenceState(pref);
    setMode(resolveMode(pref));
    try {
      localStorage.setItem("theme-preference", pref);
    } catch { /* noop */ }
    // Persist to server (fire-and-forget)
    api.put("/settings", { theme_mode: pref }).catch(() => {});
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", mode);
  }, [mode]);

  const theme = useMemo(() => buildTheme(mode), [mode]);

  const value = useMemo(() => ({ mode, preference, setPreference }), [mode, preference, setPreference]);

  return (
    <ThemeContext.Provider value={value}>
      <MuiThemeProvider theme={theme}>{children}</MuiThemeProvider>
    </ThemeContext.Provider>
  );
}
