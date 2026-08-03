import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  themeChromeColor,
  UI_THEME_DARK_BACKGROUND,
  UI_THEME_LIGHT_BACKGROUND
} from "./theme.js";

const tokens = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
const base = readFileSync(new URL("./base.css", import.meta.url), "utf8");

describe("shared UI theme foundations", () => {
  it("keeps renderer tokens synchronized with main-process chrome colors", () => {
    expect(tokens).toContain(`--background: ${UI_THEME_LIGHT_BACKGROUND}`);
    expect(tokens).toContain(`--background: ${UI_THEME_DARK_BACKGROUND}`);
    expect(themeChromeColor(false)).toBe(UI_THEME_LIGHT_BACKGROUND);
    expect(themeChromeColor(true)).toBe(UI_THEME_DARK_BACKGROUND);
  });

  it("keeps cards compact and supports accessibility preferences", () => {
    expect(tokens).toContain("--radius: 0.5rem");
    expect(tokens).toContain("@media (forced-colors: active)");
    expect(base).toContain("@media (prefers-reduced-motion: reduce)");
  });
});
