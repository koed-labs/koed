import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  defaultHqSidebarPreferences,
  type HqSidebarPreferences
} from "../ipc/hq-sidebar-preferences-protocol.js";
import {
  hqSidebarPreferencesPath,
  readHqSidebarPreferences,
  writeHqSidebarPreferences
} from "./hq-sidebar-preferences.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

const file = () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-hq-sidebar-"));
  roots.push(root);
  return resolve(root, "hq-sidebar-preferences.json");
};

describe("HQ sidebar preferences", () => {
  it("uses defaults when the file is missing or invalid", () => {
    const path = file();
    expect(readHqSidebarPreferences(path)).toEqual(defaultHqSidebarPreferences);

    for (const value of [
      "invalid json",
      JSON.stringify({ foldedGroups: [] }),
      JSON.stringify({ foldedGroups: { "just-me": "true" } }),
      JSON.stringify({ foldedGroups: {}, extra: true }),
      JSON.stringify({
        foldedGroups: Object.fromEntries(
          Array.from({ length: 1002 }, (_, index) => [`project:${index}`, true])
        )
      })
    ]) {
      writeFileSync(path, value);
      expect(readHqSidebarPreferences(path)).toEqual(
        defaultHqSidebarPreferences
      );
    }
  });

  it("writes bounded fold state atomically with private file mode", () => {
    const path = file();
    const staleTemporary = `${path}.tmp`;
    writeFileSync(staleTemporary, "stale", { mode: 0o644 });
    const value: HqSidebarPreferences = {
      foldedGroups: { "just-me": true, "project:local-project-1": false }
    };

    expect(writeHqSidebarPreferences(path, value)).toEqual(value);
    expect(readHqSidebarPreferences(path)).toEqual(value);
    expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify(value)}\n`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(staleTemporary, "utf8")).toBe("stale");
    expect(statSync(staleTemporary).mode & 0o777).toBe(0o644);
  });

  it("rejects malformed preference writes without replacing valid data", () => {
    const path = file();
    writeHqSidebarPreferences(path, defaultHqSidebarPreferences);

    expect(() =>
      writeHqSidebarPreferences(path, {
        foldedGroups: { "just-me": "yes" }
      } as unknown as HqSidebarPreferences)
    ).toThrow();
    expect(readHqSidebarPreferences(path)).toEqual(defaultHqSidebarPreferences);
  });

  it("stores its JSON in the Electron userData directory", () => {
    expect(hqSidebarPreferencesPath("/koed/profile")).toBe(
      "/koed/profile/hq-sidebar-preferences.json"
    );
  });
});
