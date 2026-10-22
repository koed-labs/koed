import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveKoedServerPaths } from "./paths.js";
import {
  observeRuntimeLifecycle,
  runtimeOwnedBy
} from "./runtime-lifecycle.js";

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true }))
);

const owner = { kind: "desktop" as const, installationId: "a".repeat(32) };
const fixture = () => {
  mkdirSync("scratch", { recursive: true });
  const root = mkdtempSync(resolve("scratch", "runtime-lifecycle-"));
  roots.push(root);
  const paths = resolveKoedServerPaths({ KOED_HOME: resolve(root, "home") });
  mkdirSync(paths.runDir, { recursive: true });
  const write = (name: string, value: unknown) =>
    writeFileSync(resolve(paths.runDir, name), `${JSON.stringify(value)}\n`);
  return { paths, write };
};
const identities =
  (live: Record<number, string>) =>
  (pid: number): string | null =>
    live[pid] ?? null;
const pin = (pid: number, processIdentity: string) => ({
  schemaVersion: 1,
  generationId: "b".repeat(64),
  pid,
  processIdentity,
  startedAt: "2026-10-20T10:00:00.000Z",
  owner,
  pinToken: "c".repeat(64),
  source: "desktop-bundle"
});

describe("observeRuntimeLifecycle", () => {
  it("reports stopped without a supervisor lock and ignores stale files", () => {
    const { paths, write } = fixture();
    expect(
      observeRuntimeLifecycle(paths, { resolveProcessIdentity: identities({}) })
    ).toMatchObject({ state: "stopped", epoch: "stopped" });
    write("koed-server.lock", {
      pid: 41,
      acquiredAt: "x",
      processIdentity: "old"
    });
    write("runtime-generation.json", pin(41, "old"));
    expect(
      observeRuntimeLifecycle(paths, {
        resolveProcessIdentity: identities({ 41: "reused" })
      }).state
    ).toBe("stopped");
  });

  it("reports a live supervisor as starting until its pin and runtime state exist", () => {
    const { paths, write } = fixture();
    const resolveProcessIdentity = identities({ 42: "live" });
    write("koed-server.lock", {
      pid: 42,
      acquiredAt: "x",
      processIdentity: "live"
    });
    expect(
      observeRuntimeLifecycle(paths, { resolveProcessIdentity })
    ).toMatchObject({ state: "starting", pid: 42, owner: null });
    write("runtime-generation.json", pin(42, "live"));
    const pinned = observeRuntimeLifecycle(paths, { resolveProcessIdentity });
    expect(pinned).toMatchObject({ state: "starting", owner });
    expect(runtimeOwnedBy(pinned, owner)).toBe(true);
    expect(
      runtimeOwnedBy(pinned, {
        kind: "standalone",
        installationId: owner.installationId
      })
    ).toBe(false);
    write("koed-server.json", {
      pid: 42,
      startedAt: "2026-10-20T10:00:01.000Z"
    });
    const running = observeRuntimeLifecycle(paths, { resolveProcessIdentity });
    expect(running).toMatchObject({ state: "running", pid: 42 });
    expect(running.epoch).toBe(pinned.epoch);
  });

  it("does not attribute a pin from another process to the live supervisor", () => {
    const { paths, write } = fixture();
    write("koed-server.lock", {
      pid: 43,
      acquiredAt: "x",
      processIdentity: "live"
    });
    write("runtime-generation.json", pin(99, "other"));
    expect(
      observeRuntimeLifecycle(paths, {
        resolveProcessIdentity: identities({ 43: "live", 99: "other" })
      })
    ).toMatchObject({ state: "starting", owner: null });
  });

  it("reports unavailable when a live lock identity cannot be verified", () => {
    const { paths, write } = fixture();
    write("koed-server.lock", {
      pid: 44,
      acquiredAt: "x",
      processIdentity: "live"
    });
    expect(
      observeRuntimeLifecycle(paths, {
        resolveProcessIdentity: () => null,
        isProcessRunning: (pid) => pid === 44
      }).state
    ).toBe("unavailable");
    writeFileSync(resolve(paths.runDir, "koed-server.lock"), "{");
    expect(
      observeRuntimeLifecycle(paths, { resolveProcessIdentity: identities({}) })
        .state
    ).toBe("unavailable");
  });
});
