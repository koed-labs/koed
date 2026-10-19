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
  defaultHqLayoutPreferences,
  type HqLayoutPreferences
} from "../ipc/hq-layout-preferences-protocol.js";
import {
  hqLayoutPreferencesPath,
  readHqLayoutPreferences,
  writeHqLayoutPreferences
} from "./hq-layout-preferences.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

const file = () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-hq-layout-"));
  roots.push(root);
  return resolve(root, "hq-layout-preferences.json");
};

describe("HQ layout preferences", () => {
  it("uses the responsive default when the file is missing or invalid", () => {
    const path = file();
    expect(readHqLayoutPreferences(path)).toEqual(defaultHqLayoutPreferences);

    for (const value of [
      "invalid json",
      JSON.stringify({ sidebarWidth: 268 }),
      JSON.stringify({
        ...defaultHqLayoutPreferences,
        rightColumnHidden: "false"
      }),
      JSON.stringify({ ...defaultHqLayoutPreferences, sidebarWidth: 199 }),
      JSON.stringify({ ...defaultHqLayoutPreferences, extra: true })
    ]) {
      writeFileSync(path, value);
      expect(readHqLayoutPreferences(path)).toEqual(defaultHqLayoutPreferences);
    }
  });

  it("writes bounded pixel preferences atomically with private file mode", () => {
    const path = file();
    const staleTemporary = `${path}.tmp`;
    writeFileSync(staleTemporary, "stale", { mode: 0o644 });
    const value: HqLayoutPreferences = {
      sidebarWidth: 440,
      rightColumnWidth: 620,
      rightColumnHidden: true
    };

    expect(writeHqLayoutPreferences(path, value)).toEqual(value);
    expect(readHqLayoutPreferences(path)).toEqual(value);
    expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify(value)}\n`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(staleTemporary, "utf8")).toBe("stale");
    expect(statSync(staleTemporary).mode & 0o777).toBe(0o644);
  });

  it("rejects invalid data before replacing the stored preference", () => {
    const path = file();
    writeHqLayoutPreferences(path, defaultHqLayoutPreferences);

    expect(() =>
      writeHqLayoutPreferences(path, {
        ...defaultHqLayoutPreferences,
        rightColumnWidth: 16_385
      })
    ).toThrow();
    expect(readHqLayoutPreferences(path)).toEqual(defaultHqLayoutPreferences);
  });

  it("stores its JSON in the Electron userData directory", () => {
    expect(hqLayoutPreferencesPath("/koed/profile")).toBe(
      "/koed/profile/hq-layout-preferences.json"
    );
  });
});
