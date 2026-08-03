import {
  UI_THEME_DARK_BACKGROUND,
  UI_THEME_LIGHT_BACKGROUND
} from "@koed/ui/theme";
import { describe, expect, it } from "vitest";
import {
  DESKTOP_THEME_DARK_BACKGROUND,
  DESKTOP_THEME_LIGHT_BACKGROUND,
  desktopThemeChromeColor
} from "./theme-colors.js";

describe("Desktop packaged theme colors", () => {
  it("stays synchronized with renderer-owned shared theme colors", () => {
    expect(DESKTOP_THEME_LIGHT_BACKGROUND).toBe(UI_THEME_LIGHT_BACKGROUND);
    expect(DESKTOP_THEME_DARK_BACKGROUND).toBe(UI_THEME_DARK_BACKGROUND);
  });

  it("resolves the pre-render chrome color", () => {
    expect(desktopThemeChromeColor(false)).toBe("#fbfbfa");
    expect(desktopThemeChromeColor(true)).toBe("#181817");
  });
});
