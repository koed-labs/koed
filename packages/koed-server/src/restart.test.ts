import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { restartKoedServer } from "./restart.js";
import type { KoedServerRuntimeState } from "./types.js";

const makeHome = () => {
  const koedHome = mkdtempSync(resolve(tmpdir(), "koed-restart-"));
  mkdirSync(resolve(koedHome, "run"), { recursive: true });
  return koedHome;
};

const writeRuntime = (koedHome: string) => {
  const runtime: KoedServerRuntimeState = {
    pid: 100,
    startedAt: "2026-01-01T00:00:00.000Z",
    runtimeMode: "local-personal",
    dependencyMode: "bundled-local",
    repoRoot: "/repo",
    apiUrl: "http://localhost:3300",
    services: ["api", "worker"],
    processes: { api: 10, worker: 11 }
  };
  writeFileSync(
    resolve(koedHome, "run", "koed-server.json"),
    JSON.stringify(runtime)
  );
};

describe("restartKoedServer", () => {
  it("stops existing processes before starting again", async () => {
    const koedHome = makeHome();
    writeRuntime(koedHome);
    const order: string[] = [];

    const result = await restartKoedServer({
      environment: { KOED_HOME: koedHome },
      kill: (pid) => order.push(`stop:${pid}`),
      checkPid: () => false,
      start: async () => {
        order.push("start");
      }
    });

    expect(result.ok).toBe(true);
    expect(order).toEqual(["stop:11", "stop:10", "start"]);
    expect(result.stoppedPids).toEqual([11, 10]);
  });

  it("starts koed-server detached when no start override is provided", async () => {
    const koedHome = makeHome();
    writeRuntime(koedHome);
    const spawns: Array<{ command: string; args: string[]; options: unknown }> =
      [];

    const result = await restartKoedServer({
      environment: { KOED_HOME: koedHome, KOED_REPO_ROOT: "/repo" },
      kill: () => undefined,
      checkPid: () => false,
      startCommand: "/repo/packages/koed-server/dist/cli.js",
      spawn: (command, args, options) => {
        spawns.push({ command, args, options });
        return { pid: 222, unref: () => undefined } as never;
      }
    });

    expect(result.ok).toBe(true);
    expect(result.startedPid).toBe(222);
    expect(spawns).toMatchObject([
      {
        command: process.execPath,
        args: ["/repo/packages/koed-server/dist/cli.js", "start"],
        options: { cwd: "/repo", detached: true, stdio: "ignore" }
      }
    ]);
  });

  it("sends SIGKILL when stopped processes stay alive before starting", async () => {
    const koedHome = makeHome();
    writeRuntime(koedHome);
    const signals: Array<[number, NodeJS.Signals]> = [];
    const running = new Set([10, 11]);
    let started = false;

    const result = await restartKoedServer({
      environment: { KOED_HOME: koedHome },
      kill: (pid, signal) => {
        signals.push([pid, signal]);
        if (signal === "SIGKILL") {
          running.delete(pid);
        }
      },
      checkPid: (pid) => running.has(pid),
      waitForExitMs: 0,
      pollIntervalMs: 0,
      sleep: async () => undefined,
      start: async () => {
        started = true;
      }
    });

    expect(result.ok).toBe(true);
    expect(started).toBe(true);
    expect(signals).toEqual([
      [11, "SIGTERM"],
      [11, "SIGKILL"],
      [10, "SIGTERM"],
      [10, "SIGKILL"]
    ]);
  });

  it("returns needs_attention when stopped processes stay alive", async () => {
    const koedHome = makeHome();
    writeRuntime(koedHome);
    let started = false;

    const result = await restartKoedServer({
      environment: { KOED_HOME: koedHome },
      kill: () => undefined,
      checkPid: () => true,
      waitForExitMs: 0,
      pollIntervalMs: 0,
      sleep: async () => undefined,
      start: async () => {
        started = true;
      }
    });

    expect(result.ok).toBe(false);
    expect(result.state).toBe("needs_attention");
    expect(started).toBe(false);
  });
});
