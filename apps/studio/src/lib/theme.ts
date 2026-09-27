export const THEME_STORAGE_KEY = "memory-layer.theme";

export type ThemeName = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

export const THEME_BOOTSTRAP_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});var resolved=t==="light"?"light":t==="system"?(window.matchMedia&&window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"):"dark";var r=document.documentElement;r.classList.remove("dark","light");r.classList.add(resolved);}catch(e){document.documentElement.classList.add("dark");}})();`;
