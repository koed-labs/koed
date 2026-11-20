import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { resolveKoedServerPaths } from "../paths.js";
import { migrateStoppedLegacyAgent } from "./migrate.js";

it("imports legacy Stop only after explicit Operator confirmation without launching a runtime", () => {
  const scratch = resolve(import.meta.dirname, "../../../../scratch");
  mkdirSync(scratch, { recursive: true });
  const home = realpathSync(mkdtempSync(resolve(scratch, "migration-")));
  const paths = resolveKoedServerPaths({ KOED_HOME: home });
  mkdirSync(paths.configDir, { mode: 0o700 });
  mkdirSync(paths.runDir, { mode: 0o700 });
  try {
    writeFileSync(
      resolve(paths.runDir, "background-agent-state.json"),
      JSON.stringify({
        schemaVersion: 1,
        installationId: "12345678-1234-4234-8234-123456789abc",
        bundlePath: "/Applications/Koed.app",
        koedHome: home,
        generation: 1,
        state: "stopped",
        stopIntent: true,
        updatedAt: "2026-01-01T00:00:00.000Z"
      }),
      { mode: 0o600 }
    );
    expect(() => migrateStoppedLegacyAgent(paths, false)).toThrow(
      "confirmation"
    );
    migrateStoppedLegacyAgent(paths, true);
    const state: unknown = JSON.parse(
      readFileSync(resolve(paths.configDir, "control-plane-state.json"), "utf8")
    );
    expect(state).toMatchObject({ stopIntent: true, runtimeClean: true });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
