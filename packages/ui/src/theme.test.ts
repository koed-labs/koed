import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  themeChromeColor,
  UI_THEME_DARK_BACKGROUND,
  UI_THEME_LIGHT_BACKGROUND
} from "./theme.js";

const tokens = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
const tailwind = readFileSync(
  new URL("./tailwind.css", import.meta.url),
  "utf8"
);
const base = readFileSync(new URL("./base.css", import.meta.url), "utf8");

const hqLight = {
  "--hq-bg": "#fbfbfc",
  "--hq-rail": "#f2f2f5",
  "--hq-card": "#f1f1f4",
  "--hq-card-hi": "#ececf0",
  "--hq-surface": "#e7e7ec",
  "--hq-surface-hover": "#dddde3",
  "--hq-field": "#ffffff",
  "--hq-fg": "#18181b",
  "--hq-fg2": "#3f3f46",
  "--hq-muted": "#63636b",
  "--hq-faint": "#a6a6ae",
  "--hq-border": "#dcdce2",
  "--hq-hairline": "#ececf0",
  "--hq-accent": "#5e6ad2",
  "--hq-accent-soft": "color-mix(in srgb, #5e6ad2 12%, transparent)",
  "--hq-accent-text": "#4551b5",
  "--hq-heat-1": "#2f7de0",
  "--hq-heat-2": "#14946f",
  "--hq-heat-3": "#c98a0c",
  "--hq-heat-4": "#dc5530",
  "--hq-btn": "#18181b",
  "--hq-btn-fg": "#fafafa",
  "--hq-danger": "#b91c1c",
  "--hq-ok": "#15803d"
};

const hqDark = {
  "--hq-bg": "#050507",
  "--hq-rail": "#0c0c0f",
  "--hq-card": "#131317",
  "--hq-card-hi": "#17171c",
  "--hq-surface": "#1d1d23",
  "--hq-surface-hover": "#27272e",
  "--hq-field": "#1c1c22",
  "--hq-fg": "#f4f4f5",
  "--hq-fg2": "#d4d4d8",
  "--hq-muted": "#a1a1aa",
  "--hq-faint": "#5b5b63",
  "--hq-border": "#2a2a31",
  "--hq-hairline": "#1b1b20",
  "--hq-accent": "#5e6ad2",
  "--hq-accent-soft": "color-mix(in srgb, #5e6ad2 16%, transparent)",
  "--hq-accent-text": "#a5acf2",
  "--hq-heat-1": "#6aa8ff",
  "--hq-heat-2": "#4fd1a5",
  "--hq-heat-3": "#f2b544",
  "--hq-heat-4": "#ff7a59",
  "--hq-btn": "#f4f4f5",
  "--hq-btn-fg": "#0b0b0e",
  "--hq-danger": "#fca5a5",
  "--hq-ok": "#4ade80"
};

const legacyKeys = [
  "--background",
  "--app-chrome-background",
  "--foreground",
  "--card",
  "--accent",
  "--muted",
  "--destructive",
  "--border",
  "--input"
];

const legacyLight = {
  "--background": "#fbfbfa",
  "--app-chrome-background": "#fbfbfa",
  "--foreground": "#242522",
  "--card": "#ffffff",
  "--accent": "#e9ece6",
  "--muted": "#f1f2ef",
  "--destructive": "#c43b3b",
  "--border": "#dedfda",
  "--input": "#d4d6d0"
};

const legacyDark = {
  "--background": "#181817",
  "--app-chrome-background": "#181817",
  "--foreground": "#efefec",
  "--card": "#1e1f1d",
  "--accent": "#30322e",
  "--muted": "#272825",
  "--destructive": "#df6868",
  "--border": "#393b36",
  "--input": "#444640"
};

const legacyForcedColors = {
  "--background": "Canvas",
  "--app-chrome-background": "Canvas",
  "--foreground": "CanvasText",
  "--card": "Canvas",
  "--accent": "Highlight",
  "--muted": "Canvas",
  "--destructive": "Mark",
  "--border": "CanvasText",
  "--input": "CanvasText"
};

function extractCssBlock(source: string, selector: string): string {
  const selectorStart = source.indexOf(selector);
  if (selectorStart < 0) {
    throw new Error(`Could not find CSS selector or at-rule: ${selector}`);
  }

  const openBrace = source.indexOf("{", selectorStart + selector.length);
  if (openBrace < 0) {
    throw new Error(`Could not find opening brace after: ${selector}`);
  }

  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(openBrace + 1, index);
  }

  throw new Error(`Could not find closing brace for: ${selector}`);
}

function readDeclarations(block: string): Record<string, string> {
  const declarations: Record<string, string> = {};
  for (const match of block.matchAll(/^\s*(--[\w-]+):\s*(.+?);\s*$/gm)) {
    const name = match[1];
    const value = match[2];
    if (name && value) declarations[name] = value;
  }
  return declarations;
}

function pickDeclarations(
  declarations: Record<string, string>,
  names: readonly string[]
): Record<string, string> {
  return Object.fromEntries(names.map((name) => [name, declarations[name]]));
}

describe("shared UI theme foundations", () => {
  it("keeps renderer tokens synchronized with main-process chrome colors", () => {
    expect(tokens).toContain(`--background: ${UI_THEME_LIGHT_BACKGROUND}`);
    expect(tokens).toContain(`--background: ${UI_THEME_DARK_BACKGROUND}`);
    expect(themeChromeColor(false)).toBe(UI_THEME_LIGHT_BACKGROUND);
    expect(themeChromeColor(true)).toBe(UI_THEME_DARK_BACKGROUND);
  });

  it("provides the exact scoped HQ light and dark prototype palettes", () => {
    expect(
      readDeclarations(extractCssBlock(tokens, "[data-hq-shell]"))
    ).toEqual(hqLight);
    expect(
      readDeclarations(extractCssBlock(tokens, ".dark [data-hq-shell]"))
    ).toEqual(hqDark);

    const hqDeclarations = [...tokens.matchAll(/^\s*(--hq-[\w-]+):/gm)].map(
      (match) => match[1]
    );
    expect(hqDeclarations).toEqual([
      ...Object.keys(hqLight),
      ...Object.keys(hqDark)
    ]);
  });

  it("exposes only matching namespaced HQ Tailwind colors", () => {
    const themeDeclarations = readDeclarations(
      extractCssBlock(tailwind, "@theme inline")
    );
    const actualMappings = Object.fromEntries(
      Object.entries(themeDeclarations).filter(([name]) =>
        name.startsWith("--color-hq-")
      )
    );
    const expectedMappings = Object.fromEntries(
      Object.keys(hqLight).map((name) => [
        name.replace(/^--hq/u, "--color-hq"),
        `var(${name})`
      ])
    );

    expect(actualMappings).toEqual(expectedMappings);
  });

  it("preserves legacy light, dark, system-dark, and forced-color values", () => {
    const systemDark = extractCssBlock(
      extractCssBlock(tokens, "@media (prefers-color-scheme: dark)"),
      ":root:not(.light)"
    );
    const forcedColors = extractCssBlock(
      extractCssBlock(tokens, "@media (forced-colors: active)"),
      ":root,"
    );

    expect(
      pickDeclarations(
        readDeclarations(extractCssBlock(tokens, ":root")),
        legacyKeys
      )
    ).toEqual(legacyLight);
    expect(
      pickDeclarations(
        readDeclarations(extractCssBlock(tokens, ".dark")),
        legacyKeys
      )
    ).toEqual(legacyDark);
    expect(pickDeclarations(readDeclarations(systemDark), legacyKeys)).toEqual(
      legacyDark
    );
    expect(
      pickDeclarations(readDeclarations(forcedColors), legacyKeys)
    ).toEqual(legacyForcedColors);
  });

  it("keeps cards compact and supports accessibility preferences", () => {
    expect(tokens).toContain("--radius: 0.5rem");
    expect(tokens).toContain("@media (forced-colors: active)");
    expect(base).toContain("@media (prefers-reduced-motion: reduce)");
  });
});
