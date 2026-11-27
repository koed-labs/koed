import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { resolveKoedServerPaths } from "../paths.js";
import {
  acquireControlPlaneAdmission,
  releaseControlPlaneAdmission
} from "./admission.js";
import { ensureControlState } from "./ensure-state.js";

it("does not assume a stopped baseline when prior runtime evidence exists", () => {
  const scratch = resolve(import.meta.dirname, "../../../../scratch");
  mkdirSync(scratch, { recursive: true });
  const home = realpathSync(mkdtempSync(resolve(scratch, "evidence-")));
  const paths = resolveKoedServerPaths({ KOED_HOME: home });
  mkdirSync(paths.configDir, { mode: 0o700 });
  const admission = acquireControlPlaneAdmission(paths)!;
  try {
    writeFileSync(paths.runtimeStatePath, "{}", { mode: 0o600 });
    expect(
      ensureControlState(paths, admission, {
        assumeStoppedIfNoEvidence: true
      }).read().runtimeClean
    ).toBe(false);
  } finally {
    releaseControlPlaneAdmission(admission);
    rmSync(home, { recursive: true, force: true });
  }
});

it("requires Operator confirmation before importing legacy Stop", () => {
  const scratch = resolve(import.meta.dirname, "../../../../scratch");
  mkdirSync(scratch, { recursive: true });
  const home = realpathSync(mkdtempSync(resolve(scratch, "migration-")));
  const paths = resolveKoedServerPaths({ KOED_HOME: home });
  mkdirSync(paths.configDir, { mode: 0o700 });
  const admission = acquireControlPlaneAdmission(paths)!;
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
    expect(() => ensureControlState(paths, admission)).toThrow(
      "explicit Operator confirmation"
    );
    expect(
      ensureControlState(paths, admission, {
        legacyStoppedConfirmed: true
      }).read()
    ).toMatchObject({ stopIntent: true, runtimeClean: false });
  } finally {
    releaseControlPlaneAdmission(admission);
    rmSync(home, { recursive: true, force: true });
  }
});
