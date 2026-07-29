import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readDesktopThemePreference,
  writeDesktopThemePreference
} from "./theme-preference.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

const file = () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-theme-"));
  roots.push(root);
  return resolve(root, "theme.json");
};

describe("Desktop theme preference", () => {
  it("defaults malformed or absent state to system", () => {
    const path = file();
    expect(readDesktopThemePreference(path)).toBe("system");
    writeFileSync(path, JSON.stringify("unsupported"));
    expect(readDesktopThemePreference(path)).toBe("system");
  });

  it.each(["light", "dark", "system"] as const)(
    "writes %s atomically as a bounded preference",
    (preference) => {
      const path = file();
      writeDesktopThemePreference(path, preference);
      expect(readDesktopThemePreference(path)).toBe(preference);
      expect(readFileSync(path, "utf8")).toBe(
        `${JSON.stringify(preference)}\n`
      );
    }
  );
});
