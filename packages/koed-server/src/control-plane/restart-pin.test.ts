import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync
} from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { resolveKoedServerPaths } from "../paths.js";
import { reclaimPriorGenerationPinForStart } from "../generation-lifecycle.js";
import {
  acquireControlPlaneAdmission,
  releaseControlPlaneAdmission
} from "./admission.js";
import { assertControlStateCleanForPruning } from "./state.js";

it("reclaims only a dead valid pin under control-plane admission", async () => {
  const scratch = resolve(import.meta.dirname, "../../../../scratch");
  mkdirSync(scratch, { recursive: true });
  const home = mkdtempSync(resolve(scratch, "restart-pin-"));
  const paths = resolveKoedServerPaths({ KOED_HOME: home });
  const admission = acquireControlPlaneAdmission(paths)!;
  const pinPath = paths.generationStatePath!;
  const pin = {
    schemaVersion: 1,
    generationId: "a".repeat(64),
    pid: 99999999,
    processIdentity: "dead",
    startedAt: "2026-01-01T00:00:00.000Z",
    owner: { kind: "desktop", installationId: "test" },
    pinToken: "b".repeat(64)
  };
  try {
    writeFileSync(pinPath, JSON.stringify(pin));
    await expect(
      reclaimPriorGenerationPinForStart(paths, admission)
    ).rejects.toThrow();
    expect(existsSync(pinPath)).toBe(true);
    mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      resolve(paths.configDir, "control-plane-state.json"),
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        stopIntent: false,
        backgroundEnabled: false,
        persistentCli: false,
        runtimeClean: false,
        protectedGenerationId: pin.generationId
      }),
      { mode: 0o600 }
    );
    writeFileSync(pinPath, JSON.stringify(pin));
    await reclaimPriorGenerationPinForStart(paths, admission);
    expect(existsSync(pinPath)).toBe(false);
    expect(() => assertControlStateCleanForPruning(paths)).toThrow();
    writeFileSync(pinPath, JSON.stringify({ ...pin, pid: process.pid }));
    await expect(
      reclaimPriorGenerationPinForStart(paths, admission)
    ).rejects.toThrow(/running|pinned/);
    expect(existsSync(pinPath)).toBe(true);
    writeFileSync(pinPath, "{}");
    await expect(
      reclaimPriorGenerationPinForStart(paths, admission)
    ).rejects.toThrow();
    expect(existsSync(pinPath)).toBe(true);
  } finally {
    releaseControlPlaneAdmission(admission);
    rmSync(home, { recursive: true, force: true });
  }
});
