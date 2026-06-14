import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureKoedHome,
  resolveKoedHome,
  resolveKoedServerPaths
} from "./paths.js";

const temps: string[] = [];
const tempDir = () => {
  const path = mkdtempSync(resolve(tmpdir(), "koed-server-paths-"));
  temps.push(path);
  return path;
};

afterEach(() => {
  for (const path of temps.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("KOED_HOME resolution", () => {
  it("uses KOED_HOME when set", () => {
    const home = tempDir();
    expect(resolveKoedHome({ KOED_HOME: home })).toBe(resolve(home));
  });

  it("creates owned config, logs, run, and data directories", () => {
    const home = tempDir();
    const paths = resolveKoedServerPaths({
      KOED_HOME: home,
      KOED_REPO_ROOT: home
    });

    ensureKoedHome(paths);

    expect(paths.configDir).toBe(resolve(home, "config"));
    expect(paths.logsDir).toBe(resolve(home, "logs"));
    expect(paths.runDir).toBe(resolve(home, "run"));
    expect(paths.dataDir).toBe(resolve(home, "data"));
  });
});
