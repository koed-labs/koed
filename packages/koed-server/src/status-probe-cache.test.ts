import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnSyncReturns } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  cachedStatusProbeSpawnSync,
  clearStatusProbeCache,
  statusProbeReuseMs
} from "./status-probe-cache.js";

const answer = (
  stdout: string,
  extra: Partial<SpawnSyncReturns<string>> = {}
) =>
  ({
    pid: 1,
    output: [null, stdout, ""],
    stdout,
    stderr: "",
    status: 0,
    signal: null,
    ...extra
  }) as SpawnSyncReturns<string>;

describe("status probe cache", () => {
  it("reuses a recent answer across status runs, then asks again", () => {
    const dir = mkdtempSync(join(tmpdir(), "koed-probe-cache-"));
    let clock = 1_000;
    const spawn = vi.fn(() => answer("2.1.0"));
    const first = cachedStatusProbeSpawnSync(dir, spawn, () => clock);
    expect(first("claude", ["--version"], { encoding: "utf8" }).stdout).toBe(
      "2.1.0"
    );
    // A later `koed status` process reads the same cache file.
    const second = cachedStatusProbeSpawnSync(dir, spawn, () => clock);
    expect(second("claude", ["--version"], { encoding: "utf8" })).toMatchObject(
      { stdout: "2.1.0", status: 0 }
    );
    expect(spawn).toHaveBeenCalledTimes(1);
    clock += statusProbeReuseMs + 1;
    second("claude", ["--version"], { encoding: "utf8" });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("keeps different commands and environments apart and clears on demand", () => {
    const dir = mkdtempSync(join(tmpdir(), "koed-probe-cache-"));
    const spawn = vi.fn((_command: string, args: string[]) =>
      answer(args.join(" "))
    );
    const probe = cachedStatusProbeSpawnSync(dir, spawn);
    probe("claude", ["mcp", "get", "koed"], { env: { HOME: "/a" } });
    probe("claude", ["mcp", "get", "koed"], { env: { HOME: "/b" } });
    probe("claude", ["auth", "status"], { env: { HOME: "/a" } });
    expect(spawn).toHaveBeenCalledTimes(3);
    clearStatusProbeCache(dir);
    probe("claude", ["auth", "status"], { env: { HOME: "/a" } });
    expect(spawn).toHaveBeenCalledTimes(4);
  });

  it("replays a failed probe's error", () => {
    const dir = mkdtempSync(join(tmpdir(), "koed-probe-cache-"));
    const spawn = vi.fn(() =>
      answer("", {
        status: null,
        error: Object.assign(new Error("spawn claude ENOENT"), {
          code: "ENOENT"
        })
      })
    );
    const probe = cachedStatusProbeSpawnSync(dir, spawn);
    probe("claude", ["--version"]);
    const replayed = probe("claude", ["--version"]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(replayed.error).toMatchObject({
      message: "spawn claude ENOENT",
      code: "ENOENT"
    });
  });
});
