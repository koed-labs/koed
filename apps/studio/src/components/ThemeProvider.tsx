"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState
} from "react";
import {
  THEME_STORAGE_KEY,
  type ResolvedTheme,
  type ThemeName
} from "@/lib/theme";

export type { ThemeName } from "@/lib/theme";
export { THEME_STORAGE_KEY } from "@/lib/theme";

type ThemeContextValue = {
  // The user's preference, including "system" when selected in Settings.
  theme: ThemeName;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: ThemeName) => void;
};

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia(DARK_MEDIA_QUERY).matches;
  } catch {
    return true;
  }
}

export function readStoredTheme(): ThemeName {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "system" ? stored : "dark";
  } catch {
    return "dark";
  }
}

export function resolveTheme(preference: ThemeName): ResolvedTheme {
  if (preference === "system") return systemPrefersDark() ? "dark" : "light";
  return preference;
}

export function applyThemeClass(theme: ResolvedTheme) {
  const root = document.documentElement;
  root.classList.remove("dark", "light");
  root.classList.add(theme);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeName>("dark");
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>("dark");

  useEffect(() => {
    const next = readStoredTheme();
    // Restore the saved preference after hydration to keep server markup stable.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setThemeState(next);
    const resolved = resolveTheme(next);
    setResolvedTheme(resolved);
    applyThemeClass(resolved);
  }, []);

  useEffect(() => {
    if (theme !== "system") return undefined;
    const media = window.matchMedia(DARK_MEDIA_QUERY);
    const onChange = () => {
      const resolved = resolveTheme("system");
      setResolvedTheme(resolved);
      applyThemeClass(resolved);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  const setTheme = useCallback((next: ThemeName) => {
    setThemeState(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // The theme still applies when storage is unavailable; it just won't persist.
    }
    const resolved = resolveTheme(next);
    setResolvedTheme(resolved);
    applyThemeClass(resolved);
  }, []);

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme]
  );
  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
