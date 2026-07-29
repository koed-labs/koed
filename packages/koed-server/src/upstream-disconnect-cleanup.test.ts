import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveKoedServerPaths } from "./paths.js";
import {
  beginUpstreamDisconnectCleanup,
  completeUpstreamDisconnectCleanup,
  listUpstreamDisconnectCleanupRecords,
  updateUpstreamDisconnectCleanup,
  upstreamDisconnectCleanupPending
} from "./upstream-disconnect-cleanup.js";

const createPaths = () => {
  const koedHome = mkdtempSync(join(tmpdir(), "koed-disconnect-cleanup-"));
  return resolveKoedServerPaths({
    KOED_HOME: koedHome,
    KOED_REPO_ROOT: koedHome
  });
};

describe("upstream disconnect cleanup journal", () => {
  it("persists a non-secret lifecycle journal atomically with private permissions", () => {
    const paths = createPaths();
    beginUpstreamDisconnectCleanup(paths, "team-vps", {
      now: () => new Date("2026-07-20T00:00:00.000Z")
    });
    updateUpstreamDisconnectCleanup(
      paths,
      "team-vps",
      {
        phase: "local_cleanup_pending",
        lastFailureCategory: "local_cleanup_failed"
      },
      { now: () => new Date("2026-07-20T00:00:01.000Z") }
    );

    expect(listUpstreamDisconnectCleanupRecords(paths)).toEqual([
      {
        schemaVersion: 1,
        backendId: "team-vps",
        phase: "local_cleanup_pending",
        attemptCount: 1,
        createdAt: "2026-07-20T00:00:00.000Z",
        updatedAt: "2026-07-20T00:00:01.000Z",
        lastFailureCategory: "local_cleanup_failed"
      }
    ]);
    expect(statSync(paths.upstreamDisconnectCleanupPath).mode & 0o777).toBe(
      0o600
    );
    expect(
      readFileSync(paths.upstreamDisconnectCleanupPath, "utf8")
    ).not.toMatch(/token|secret|authorization|credentialReference/i);
  });

  it("blocks until each exact backend cleanup is completed", () => {
    const paths = createPaths();
    beginUpstreamDisconnectCleanup(paths, "first-vps");
    beginUpstreamDisconnectCleanup(paths, "second-vps");

    expect(upstreamDisconnectCleanupPending(paths)).toBe(true);
    expect(upstreamDisconnectCleanupPending(paths, "first-vps")).toBe(true);
    expect(completeUpstreamDisconnectCleanup(paths, "first-vps")).toBe(true);
    expect(upstreamDisconnectCleanupPending(paths, "first-vps")).toBe(false);
    expect(upstreamDisconnectCleanupPending(paths, "second-vps")).toBe(true);
    expect(completeUpstreamDisconnectCleanup(paths, "second-vps")).toBe(true);
    expect(upstreamDisconnectCleanupPending(paths)).toBe(false);
  });

  it("fails closed when the journal is malformed", () => {
    const paths = createPaths();
    beginUpstreamDisconnectCleanup(paths, "team-vps");
    const contents = readFileSync(paths.upstreamDisconnectCleanupPath, "utf8");
    writeFileSync(
      paths.upstreamDisconnectCleanupPath,
      contents.replace('"attemptCount": 1', '"attemptCount": 0')
    );
    expect(() => listUpstreamDisconnectCleanupRecords(paths)).toThrow(
      "Upstream disconnect cleanup journal is malformed."
    );
  });
});
