import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readCliInstallSettings,
  validateCliInstallSettings,
  writeCliInstallSettings
} from "./settings.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("Desktop CLI settings", () => {
  it("accepts only absolute paths without control characters", () => {
    expect(
      validateCliInstallSettings({
        destination: "relative/koed",
        pathDirectory: "/tmp/bin\n"
      })
    ).toEqual({});
    expect(
      validateCliInstallSettings({
        destination: "/tmp/koed",
        pathDirectory: "/tmp/bin"
      })
    ).toEqual({ destination: "/tmp/koed", pathDirectory: "/tmp/bin" });
  });

  it("round trips separate launcher and PATH locations and refuses symlink settings", () => {
    const root = mkdtempSync(join(tmpdir(), "koed cli settings "));
    roots.push(root);
    const path = join(root, "settings.json");
    expect(readCliInstallSettings(path)).toEqual({});
    const settings = {
      destination: join(root, "new", "koed"),
      pathDirectory: join(root, "old")
    };
    writeCliInstallSettings(path, settings);
    expect(readCliInstallSettings(path)).toEqual(settings);
    rmSync(path);
    const target = join(root, "target.json");
    writeFileSync(target, JSON.stringify(settings));
    symlinkSync(target, path);
    expect(() => readCliInstallSettings(path)).toThrow();
  });
});
