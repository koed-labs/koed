export const UI_THEME_LIGHT_BACKGROUND = "#fbfbfa";
export const UI_THEME_DARK_BACKGROUND = "#181817";

export const UI_THEME_LIGHT = {
  chrome: UI_THEME_LIGHT_BACKGROUND,
  background: UI_THEME_LIGHT_BACKGROUND
} as const;

export const UI_THEME_DARK = {
  chrome: UI_THEME_DARK_BACKGROUND,
  background: UI_THEME_DARK_BACKGROUND
} as const;

export const UI_THEME = {
  light: UI_THEME_LIGHT,
  dark: UI_THEME_DARK
} as const;

export type UiResolvedTheme = keyof typeof UI_THEME;

export function themeChromeColor(dark: boolean): string {
  return dark ? UI_THEME_DARK_BACKGROUND : UI_THEME_LIGHT_BACKGROUND;
}
