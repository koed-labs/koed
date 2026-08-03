import type { DesktopThemePreference } from "../../window/theme-preference.js";

export type ThemeSnapshot = {
  error: string | null;
  loading: boolean;
  preference: DesktopThemePreference;
  resolved: "dark" | "light";
};

const systemDark = (): boolean =>
  window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;

const resolvedTheme = (preference: DesktopThemePreference): "dark" | "light" =>
  preference === "system" ? (systemDark() ? "dark" : "light") : preference;

const applyTheme = (snapshot: ThemeSnapshot): void => {
  document.documentElement.classList.toggle(
    "dark",
    snapshot.resolved === "dark"
  );
  document.documentElement.classList.toggle(
    "light",
    snapshot.resolved === "light"
  );
  document.documentElement.dataset.theme = snapshot.preference;
};

export class ThemeStore {
  readonly #listeners = new Set<() => void>();
  readonly #systemMedia = window.matchMedia?.("(prefers-color-scheme: dark)");
  #snapshot: ThemeSnapshot = {
    error: null,
    loading: true,
    preference: "system",
    resolved: resolvedTheme("system")
  };

  constructor() {
    this.#systemMedia?.addEventListener("change", this.#handleSystemChange);
    applyTheme(this.#snapshot);
  }

  current = (): ThemeSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  async load(): Promise<ThemeSnapshot> {
    try {
      const preference = (await window.koedDesktop?.theme?.get()) ?? "system";
      this.#replace({
        error: null,
        loading: false,
        preference,
        resolved: resolvedTheme(preference)
      });
    } catch (cause) {
      this.#replace({
        ...this.#snapshot,
        loading: false,
        error: cause instanceof Error ? cause.message : String(cause)
      });
    }
    return this.#snapshot;
  }

  async set(preference: DesktopThemePreference): Promise<ThemeSnapshot> {
    this.#replace({
      error: null,
      loading: true,
      preference,
      resolved: resolvedTheme(preference)
    });
    try {
      const result = await window.koedDesktop?.theme?.set(preference);
      this.#replace({
        error: null,
        loading: false,
        preference,
        resolved: result
          ? result.resolvedDark
            ? "dark"
            : "light"
          : resolvedTheme(preference)
      });
    } catch (cause) {
      this.#replace({
        ...this.#snapshot,
        loading: false,
        error: cause instanceof Error ? cause.message : String(cause)
      });
    }
    return this.#snapshot;
  }

  dispose(): void {
    this.#systemMedia?.removeEventListener("change", this.#handleSystemChange);
  }

  #handleSystemChange = (): void => {
    if (this.#snapshot.preference !== "system") return;
    this.#replace({
      ...this.#snapshot,
      resolved: resolvedTheme("system")
    });
  };

  #replace(snapshot: ThemeSnapshot): void {
    this.#snapshot = snapshot;
    applyTheme(snapshot);
    for (const listener of this.#listeners) listener();
  }
}
