import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { stopKoedServer } from "./stop.js";
import type { KoedServerRuntimeState } from "./types.js";

const makeHome = () => {
  const koedHome = mkdtempSync(resolve(tmpdir(), "koed-stop-"));
  mkdirSync(resolve(koedHome, "run"), { recursive: true });
  return koedHome;
};

const writeRuntime = (koedHome: string, runtime: KoedServerRuntimeState) => {
  writeFileSync(
    resolve(koedHome, "run", "koed-server.json"),
    JSON.stringify(runtime)
  );
};

const runtime = (
  overrides: Partial<KoedServerRuntimeState> = {}
): KoedServerRuntimeState => ({
  pid: 100,
  startedAt: "2026-01-01T00:00:00.000Z",
  runtimeMode: "local-personal",
  dependencyMode: "bundled-local",
  repoRoot: "/repo",
  apiUrl: "http://localhost:3300",
  explorerUrl: "http://localhost:5174",
  services: ["api", "worker", "explorer"],
  processes: { api: 10, worker: 11, explorer: 12 },
  ...overrides
});

describe("stopKoedServer", () => {
  it("returns ok when runtime state is missing", () => {
    const koedHome = makeHome();

    const result = stopKoedServer({ environment: { KOED_HOME: koedHome } });

    expect(result).toMatchObject({
      ok: true,
      state: "not_configured",
      stoppedPids: [],
      missingPids: []
    });
  });

  it("stops app processes in reverse app order", () => {
    const koedHome = makeHome();
    writeRuntime(koedHome, runtime());
    const signals: Array<[number, NodeJS.Signals]> = [];

    const result = stopKoedServer({
      environment: { KOED_HOME: koedHome },
      kill: (pid, signal) => signals.push([pid, signal]),
      checkPid: () => false
    });

    expect(result.ok).toBe(true);
    expect(signals).toEqual([
      [12, "SIGTERM"],
      [11, "SIGTERM"],
      [10, "SIGTERM"]
    ]);
    expect(result.stoppedPids).toEqual([12, 11, 10]);
  });

  it("escalates lingering app PIDs before removing runtime state", () => {
    const koedHome = makeHome();
    writeRuntime(koedHome, runtime({ processes: { api: 10 } }));
    const signals: Array<[number, NodeJS.Signals]> = [];
    let running = true;

    const result = stopKoedServer({
      environment: { KOED_HOME: koedHome },
      kill: (pid, signal) => {
        signals.push([pid, signal]);
        if (signal === "SIGKILL") running = false;
      },
      checkPid: () => running,
      waitForExitMs: 1,
      pollIntervalMs: 1,
      sleepSync: () => undefined
    });

    expect(result.ok).toBe(true);
    expect(signals).toEqual([
      [10, "SIGTERM"],
      [10, "SIGKILL"]
    ]);
    expect(() =>
      readFileSync(resolve(koedHome, "run", "koed-server.json"))
    ).toThrow();
  });

  it("retains runtime state when a PID will not stop", () => {
    const koedHome = makeHome();
    writeRuntime(koedHome, runtime({ processes: { api: 10 } }));

    const result = stopKoedServer({
      environment: { KOED_HOME: koedHome },
      kill: () => undefined,
      checkPid: () => true,
      waitForExitMs: 1,
      pollIntervalMs: 1,
      sleepSync: () => undefined
    });

    expect(result.ok).toBe(false);
    expect(result.errors?.[0]?.error).toContain("Timed out");
    expect(
      readFileSync(resolve(koedHome, "run", "koed-server.json"), "utf8")
    ).toBeTruthy();
  });

  it("treats stale app PIDs as missing and removes runtime state", () => {
    const koedHome = makeHome();
    writeRuntime(koedHome, runtime());

    const result = stopKoedServer({
      environment: { KOED_HOME: koedHome },
      kill: (pid) => {
        const error = new Error(`missing ${pid}`) as Error & { code: string };
        error.code = "ESRCH";
        throw error;
      },
      checkPid: () => false
    });

    expect(result.ok).toBe(true);
    expect(result.missingPids).toEqual([12, 11, 10]);
    expect(result.missingServices).toEqual(["explorer", "worker", "api"]);
    expect(() =>
      readFileSync(resolve(koedHome, "run", "koed-server.json"))
    ).toThrow();
  });

  it("stops native Postgres with pg_ctl stop", () => {
    const koedHome = makeHome();
    const dataDir = resolve(koedHome, "data", "postgres");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(resolve(dataDir, "PG_VERSION"), "16");
    writeRuntime(
      koedHome,
      runtime({ services: ["postgres-native", "api", "worker", "explorer"] })
    );
    const calls: Array<{ command: string; args: string[] }> = [];

    const result = stopKoedServer({
      environment: {
        KOED_HOME: koedHome,
        KOED_POSTGRES_PG_CTL_BIN: "/bin/pg_ctl"
      },
      existsSync: (path) =>
        String(path) === "/bin/pg_ctl" ||
        String(path).endsWith("koed-server.json") ||
        String(path).endsWith("PG_VERSION"),
      kill: () => undefined,
      checkPid: () => false,
      spawnSync: (command, args) => {
        calls.push({ command, args });
        return {
          status: 0,
          stdout: "",
          stderr: "",
          pid: 1,
          output: []
        } as never;
      }
    });

    expect(result.ok).toBe(true);
    expect(calls).toContainEqual({
      command: "/bin/pg_ctl",
      args: ["stop", "-D", dataDir, "-m", "fast"]
    });
  });

  it("stops native Embedding Service by recorded PID", () => {
    const koedHome = makeHome();
    writeRuntime(
      koedHome,
      runtime({
        services: ["embedding-service-native", "api", "worker", "explorer"],
        processes: { api: 10, worker: 11, explorer: 12, embeddingService: 13 }
      })
    );
    const pids: number[] = [];

    const result = stopKoedServer({
      environment: { KOED_HOME: koedHome },
      kill: (pid) => pids.push(pid),
      checkPid: () => false
    });

    expect(result.ok).toBe(true);
    expect(pids).toEqual([12, 11, 10, 13]);
    expect(result.stoppedServices).toContain("embedding-service-native");
  });

  it("does not stop external dependency services", () => {
    const koedHome = makeHome();
    writeRuntime(
      koedHome,
      runtime({
        dependencyMode: "external",
        services: [
          "postgres",
          "redis",
          "embedding-service",
          "api",
          "worker",
          "explorer"
        ]
      })
    );
    const commands: string[] = [];

    const result = stopKoedServer({
      environment: { KOED_HOME: koedHome },
      kill: () => undefined,
      checkPid: () => false,
      spawnSync: (command) => {
        commands.push(command);
        return {
          status: 0,
          stdout: "",
          stderr: "",
          pid: 1,
          output: []
        } as never;
      }
    });

    expect(result.ok).toBe(true);
    expect(commands).toEqual([]);
  });

  it("does not stop legacy Compose services from bundled-local runtime state", () => {
    const koedHome = makeHome();
    writeRuntime(
      koedHome,
      runtime({
        services: ["postgres", "redis", "api", "worker", "explorer"]
      })
    );
    const calls: string[][] = [];

    const result = stopKoedServer({
      environment: { KOED_HOME: koedHome },
      kill: () => undefined,
      checkPid: () => false,
      spawnSync: (_command, args) => {
        calls.push(args);
        return {
          status: 0,
          stdout: "",
          stderr: "",
          pid: 1,
          output: []
        } as never;
      }
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([]);
  });
});
