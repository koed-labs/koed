// Packaging-local values mirrored from @koed/ui/theme and enforced by a sync test.
export const DESKTOP_THEME_LIGHT_BACKGROUND = "#fbfbfa";
export const DESKTOP_THEME_DARK_BACKGROUND = "#181817";

export const desktopThemeChromeColor = (dark: boolean): string =>
  dark ? DESKTOP_THEME_DARK_BACKGROUND : DESKTOP_THEME_LIGHT_BACKGROUND;
