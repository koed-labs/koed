import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveKoedServerPaths } from "./paths.js";
import {
  acquireKoedServerSupervisorLock,
  releaseKoedServerSupervisorLock
} from "./supervisor-lock.js";

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
      resolveProcessIdentity: (pid) => `process-${pid}`,
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });
    const second = acquireKoedServerSupervisorLock(paths, {
      pid: 202,
      isProcessRunning: (pid) => pid === 101,
      resolveProcessIdentity: (pid) => `process-${pid}`
    });

    expect(first.acquired).toBe(true);
    expect(second).toMatchObject({ acquired: false, ownerPid: 101 });
    expect(JSON.parse(readFileSync(first.lockPath, "utf8"))).toMatchObject({
      pid: 101,
      acquiredAt: "2026-01-01T00:00:00.000Z",
      processIdentity: "process-101"
    });
  });

  it("reclaims a lock when a PID has been reused by another process", () => {
    const paths = pathsForTest();
    const first = acquireKoedServerSupervisorLock(paths, {
      pid: 1,
      isProcessRunning: () => true,
      resolveProcessIdentity: () => "first-container:process-1"
    });

    const second = acquireKoedServerSupervisorLock(paths, {
      pid: 1,
      isProcessRunning: () => true,
      resolveProcessIdentity: () => "replacement-container:process-1"
    });

    expect(first.acquired).toBe(true);
    expect(second).toMatchObject({ acquired: true, ownerPid: 1 });
    expect(JSON.parse(readFileSync(second.lockPath, "utf8"))).toMatchObject({
      pid: 1,
      processIdentity: "replacement-container:process-1"
    });
  });

  it("reclaims a stale or malformed lock", () => {
    const paths = pathsForTest();
    const lockPath = resolve(paths.runDir, "koed-server.lock");
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(lockPath, "not-json");

    const result = acquireKoedServerSupervisorLock(paths, {
      pid: 303,
      isProcessRunning: () => false,
      resolveProcessIdentity: () => "process-303"
    });

    expect(result).toMatchObject({ acquired: true, ownerPid: 303 });
    expect(existsSync(lockPath)).toBe(true);
  });

  it("preserves a released-shape lock while its supervisor is live", () => {
    const paths = pathsForTest();
    const lockPath = resolve(paths.runDir, "koed-server.lock");
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 101,
        acquiredAt: "2026-01-01T00:00:00.000Z"
      })
    );

    const result = acquireKoedServerSupervisorLock(paths, {
      pid: 202,
      isProcessRunning: (pid) => pid === 101,
      resolveProcessIdentity: (pid) =>
        pid === 101 ? "legacy-owner" : "candidate"
    });

    expect(result).toMatchObject({ acquired: false, ownerPid: 101 });
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toEqual({
      pid: 101,
      acquiredAt: "2026-01-01T00:00:00.000Z"
    });
  });

  it("reclaims a released-shape lock when the candidate owns the same PID", () => {
    const paths = pathsForTest();
    const lockPath = resolve(paths.runDir, "koed-server.lock");
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 1,
        acquiredAt: "2026-01-01T00:00:00.000Z"
      })
    );

    const result = acquireKoedServerSupervisorLock(paths, {
      pid: 1,
      isProcessRunning: () => true,
      resolveProcessIdentity: () => "candidate"
    });

    expect(result).toMatchObject({ acquired: true, ownerPid: 1 });
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({
      pid: 1,
      processIdentity: "candidate"
    });
  });

  it("preserves a live lock when process identity lookup is inconclusive", () => {
    const paths = pathsForTest();
    const first = acquireKoedServerSupervisorLock(paths, {
      pid: 101,
      isProcessRunning: () => true,
      resolveProcessIdentity: () => "live-owner"
    });

    const second = acquireKoedServerSupervisorLock(paths, {
      pid: 202,
      isProcessRunning: () => true,
      resolveProcessIdentity: (pid) => (pid === 101 ? null : "candidate")
    });

    expect(second).toMatchObject({ acquired: false, ownerPid: 101 });
    expect(JSON.parse(readFileSync(first.lockPath, "utf8"))).toMatchObject({
      pid: 101,
      processIdentity: "live-owner"
    });
  });

  it("does not release a lock that a newer supervisor owns", () => {
    const paths = pathsForTest();
    const first = acquireKoedServerSupervisorLock(paths, {
      pid: 101,
      isProcessRunning: () => true,
      resolveProcessIdentity: () => "first-owner"
    });
    writeFileSync(
      first.lockPath,
      `${JSON.stringify({
        pid: 202,
        acquiredAt: "2026-01-02T00:00:00.000Z",
        processIdentity: "replacement-owner"
      })}\n`
    );

    expect(releaseKoedServerSupervisorLock(first, 101)).toBe(false);
    expect(JSON.parse(readFileSync(first.lockPath, "utf8"))).toMatchObject({
      pid: 202,
      processIdentity: "replacement-owner"
    });
  });
});
