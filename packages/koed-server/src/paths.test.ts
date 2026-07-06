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

  it("rejects documentation placeholder KOED_HOME values", () => {
    expect(() => resolveKoedHome({ KOED_HOME: "/path/to" })).toThrow(
      "KOED_HOME is set to the documentation placeholder /path/to."
    );
  });

  it("resolves packaged resources as repo root when KOED_REPO_ROOT is unset", () => {
    const home = tempDir();
    const resources = tempDir();
    const paths = resolveKoedServerPaths({
      KOED_HOME: home,
      KOED_PACKAGED_DESKTOP: "1",
      KOED_PACKAGED_RESOURCES_PATH: resources
    });

    expect(paths.repoRoot).toBe(resolve(resources));
  });

  it("creates owned config, logs, run, data, model, and cache directories", () => {
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
    expect(paths.modelsDir).toBe(resolve(home, "models"));
    expect(paths.cacheDir).toBe(resolve(home, "cache"));
    expect(paths.postgresDataDir).toBe(resolve(home, "data", "postgres"));
    expect(paths.postgresRunDir).toBe(resolve(home, "run", "postgres"));
    expect(paths.postgresLogPath).toBe(resolve(home, "logs", "postgres.log"));
  });
});
