import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
  symlinkSync
} from "node:fs";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveKoedServerPaths, ensureKoedHome } from "../paths.js";
import { readLegacyStopEvidence } from "./legacy-stop.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(
    mkdtempSync(resolve(import.meta.dirname, "../../../../scratch/legacy-"))
  );
  roots.push(root);
  const paths = resolveKoedServerPaths({ KOED_HOME: root });
  ensureKoedHome(paths);
  const path = resolve(paths.runDir, "background-agent-state.json");
  const record = {
    schemaVersion: 1,
    installationId: "12345678-1234-4234-8234-123456789abc",
    bundlePath: "/Applications/Koed.app",
    koedHome: root,
    generation: 1,
    state: "stopped",
    stopIntent: true,
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  return { root, paths, path, record };
}
describe("legacy Agent Stop evidence", () => {
  it("accepts a missing record and imports a valid explicit Stop", () => {
    const f = fixture();
    expect(readLegacyStopEvidence(f.paths)).toEqual({ kind: "absent" });
    writeFileSync(f.path, JSON.stringify(f.record), { mode: 0o600 });
    expect(readLegacyStopEvidence(f.paths)).toEqual({
      kind: "valid",
      stopIntent: true
    });
  });
  it("rejects a substituted run directory", () => {
    const f = fixture();
    rmSync(f.paths.runDir, { recursive: true });
    symlinkSync(f.paths.configDir, f.paths.runDir);
    expect(readLegacyStopEvidence(f.paths)).toEqual({ kind: "invalid" });
  });
  it("rejects contradictory, malformed, mismatched or unsafe records", () => {
    const f = fixture();
    for (const record of [
      { ...f.record, state: "ready" },
      { ...f.record, koedHome: "/other" },
      { nonsense: true }
    ]) {
      writeFileSync(f.path, JSON.stringify(record), { mode: 0o600 });
      expect(readLegacyStopEvidence(f.paths)).toEqual({ kind: "invalid" });
    }
    writeFileSync(f.path, JSON.stringify(f.record));
    chmodSync(f.path, 0o644);
    expect(readLegacyStopEvidence(f.paths)).toEqual({ kind: "invalid" });
    rmSync(f.path);
    symlinkSync("/dev/null", f.path);
    expect(readLegacyStopEvidence(f.paths)).toEqual({ kind: "invalid" });
  });
});
