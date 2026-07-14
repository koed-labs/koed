import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveKoedServerPaths } from "./paths.js";
import { acquireKoedServerSupervisorLock } from "./supervisor-lock.js";

const pathsForTest = () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-supervisor-lock-"));
  mkdirSync(root, { recursive: true });
  return resolveKoedServerPaths({ KOED_HOME: root, KOED_REPO_ROOT: root });
};

describe("koed-server supervisor lock", () => {
  it("allows only one live supervisor to own KOED_HOME", () => {
    const paths = pathsForTest();
    const first = acquireKoedServerSupervisorLock(paths, {
      pid: 101,
      isProcessRunning: (pid) => pid === 101,
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });
    const second = acquireKoedServerSupervisorLock(paths, {
      pid: 202,
      isProcessRunning: (pid) => pid === 101
    });

    expect(first.acquired).toBe(true);
    expect(second).toMatchObject({ acquired: false, ownerPid: 101 });
    expect(JSON.parse(readFileSync(first.lockPath, "utf8"))).toMatchObject({
      pid: 101,
      acquiredAt: "2026-01-01T00:00:00.000Z"
    });
  });

  it("reclaims a stale or malformed lock", () => {
    const paths = pathsForTest();
    const lockPath = resolve(paths.runDir, "koed-server.lock");
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(lockPath, "not-json");

    const result = acquireKoedServerSupervisorLock(paths, {
      pid: 303,
      isProcessRunning: () => false
    });

    expect(result).toMatchObject({ acquired: true, ownerPid: 303 });
    expect(existsSync(lockPath)).toBe(true);
  });
});
