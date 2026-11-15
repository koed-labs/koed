import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveKoedServerPaths } from "../paths.js";
import { withLifecycleLock } from "../generation-lifecycle.js";
import {
  acquireControlPlaneAdmission,
  assertControlPlaneAdmission,
  beginControlPlaneSession,
  endControlPlaneSession,
  releaseControlPlaneAdmission
} from "./admission.js";

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { force: true, recursive: true }))
);
function paths() {
  const base = resolve(import.meta.dirname, "../../../../scratch");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(resolve(base, "control-admission-"));
  roots.push(root);
  return resolveKoedServerPaths({ KOED_HOME: root });
}

describe("control-plane admission", () => {
  it("keeps the owner admitted until explicit release", () => {
    const home = paths();
    const first = acquireControlPlaneAdmission(home);
    expect(first).not.toBeNull();
    expect(acquireControlPlaneAdmission(home)).toBeNull();
    expect(() => assertControlPlaneAdmission(first!, home)).not.toThrow();
    releaseControlPlaneAdmission(first!);
    expect(() => assertControlPlaneAdmission(first!, home)).toThrow();
    const next = acquireControlPlaneAdmission(home);
    expect(next).not.toBeNull();
    releaseControlPlaneAdmission(next!);
  });

  it("rejects stale session completion without releasing the current session", () => {
    const owner = acquireControlPlaneAdmission(paths())!;
    const first = beginControlPlaneSession(owner);
    endControlPlaneSession(owner, first, true);
    const second = beginControlPlaneSession(owner);
    expect(() => endControlPlaneSession(owner, first, true)).toThrow();
    expect(() => beginControlPlaneSession(owner)).toThrow(/already active/);
    expect(() => releaseControlPlaneAdmission(owner)).toThrow(/already active/);
    endControlPlaneSession(owner, second, true);
    releaseControlPlaneAdmission(owner);
  });

  it("cannot admit during another stopped-runtime lifecycle operation", () => {
    const home = paths();
    withLifecycleLock(home, () => {
      expect(() => acquireControlPlaneAdmission(home)).toThrow();
    });
    const owner = acquireControlPlaneAdmission(home)!;
    releaseControlPlaneAdmission(owner);
  });

  it("rejects an alternate run directory for the same home", () => {
    const home = paths();
    expect(() =>
      acquireControlPlaneAdmission({
        ...home,
        runDir: resolve(home.koedHome, "other")
      })
    ).toThrow();
  });

  it("rejects a symlinked run directory", () => {
    const home = paths();
    const other = resolve(home.koedHome, "other");
    mkdirSync(other);
    symlinkSync(other, home.runDir);
    expect(() => acquireControlPlaneAdmission(home)).toThrow();
  });

  it("rejects forged and other-home admissions", () => {
    const firstHome = paths();
    const secondHome = paths();
    const owner = acquireControlPlaneAdmission(firstHome)!;
    expect(() =>
      assertControlPlaneAdmission({ ...owner }, firstHome)
    ).toThrow();
    expect(() => assertControlPlaneAdmission(owner, secondHome)).toThrow();
    releaseControlPlaneAdmission(owner);
  });
});
