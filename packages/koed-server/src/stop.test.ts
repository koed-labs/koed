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

const writeSupervisorLock = (
  koedHome: string,
  pid: number,
  includeProcessIdentity = true
) => {
  writeFileSync(
    resolve(koedHome, "run", "koed-server.lock"),
    JSON.stringify({
      pid,
      acquiredAt: "2026-01-01T00:00:00.000Z",
      ...(includeProcessIdentity ? { processIdentity: "test-supervisor" } : {})
    })
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
  services: ["api", "worker"],
  processes: { api: 10, worker: 11 },
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

  it("stops Transcript Watcher before API-dependent app processes", () => {
    const koedHome = makeHome();
    writeRuntime(
      koedHome,
      runtime({
        services: ["api", "worker", "codex-transcript-watcher"],
        processes: {
          api: 10,
          worker: 11,
          codexTranscriptWatcher: 13
        }
      })
    );
    const signals: Array<[number, NodeJS.Signals]> = [];

    const result = stopKoedServer({
      environment: { KOED_HOME: koedHome },
      kill: (pid, signal) => signals.push([pid, signal]),
      checkPid: () => false
    });

    expect(result.ok).toBe(true);
    expect(signals).toEqual([
      [13, "SIGTERM"],
      [11, "SIGTERM"],
      [10, "SIGTERM"]
    ]);
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
      [11, "SIGTERM"],
      [10, "SIGTERM"]
    ]);
    expect(result.stoppedPids).toEqual([11, 10]);
  });

  it("waits for the supervisor to exit before completing stop", () => {
    const koedHome = makeHome();
    writeRuntime(koedHome, runtime());
    writeSupervisorLock(koedHome, 100);
    const running = new Set([100, 10, 11]);
    const signals: Array<[number, NodeJS.Signals]> = [];

    const result = stopKoedServer({
      environment: { KOED_HOME: koedHome },
      kill: (pid, signal) => {
        signals.push([pid, signal]);
        running.delete(pid);
      },
      checkPid: (pid) => running.has(pid),
      sleepSync: () => {
        running.clear();
      }
    });

    expect(result.ok).toBe(true);
    expect(signals).toEqual([]);
    expect(result.stoppedPids).toEqual([10, 11, 100]);
    expect(result.stoppedServices).toContain("supervisor");
  });

  it("stops a supervisor referenced by a released-shape lock", () => {
    const koedHome = makeHome();
    writeRuntime(koedHome, runtime({ processes: {} }));
    writeSupervisorLock(koedHome, 100, false);
    let supervisorRunning = true;

    const result = stopKoedServer({
      environment: { KOED_HOME: koedHome },
      checkPid: (pid) => pid === 100 && supervisorRunning,
      sleepSync: () => {
        supervisorRunning = false;
      }
    });

    expect(result.ok).toBe(true);
    expect(result.stoppedPids).toContain(100);
    expect(result.stoppedServices).toContain("supervisor");
  });

  it("does not signal a supervisor when runtime state and lock disagree", () => {
    const koedHome = makeHome();
    writeRuntime(koedHome, runtime({ processes: {} }));
    writeSupervisorLock(koedHome, 999);
    const signals: Array<[number, NodeJS.Signals]> = [];

    const result = stopKoedServer({
      environment: { KOED_HOME: koedHome },
      kill: (pid, signal) => signals.push([pid, signal]),
      checkPid: (pid) => pid === 100
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual({
      target: "supervisor (100)",
      error: "Runtime state does not match the active supervisor lock"
    });
    expect(signals).toEqual([]);
    expect(
      readFileSync(resolve(koedHome, "run", "koed-server.json"), "utf8")
    ).toBeTruthy();
  });

  it("escalates a supervisor that fails to exit naturally", () => {
    const koedHome = makeHome();
    writeRuntime(koedHome, runtime({ processes: {} }));
    writeSupervisorLock(koedHome, 100);
    const signals: Array<[number, NodeJS.Signals]> = [];
    let running = true;

    const result = stopKoedServer({
      environment: { KOED_HOME: koedHome },
      kill: (pid, signal) => {
        signals.push([pid, signal]);
        if (signal === "SIGKILL") running = false;
      },
      checkPid: (pid) => pid === 100 && running,
      waitForExitMs: 1,
      pollIntervalMs: 1,
      sleepSync: () => undefined
    });

    expect(result.ok).toBe(true);
    expect(signals).toEqual([
      [100, "SIGTERM"],
      [100, "SIGKILL"]
    ]);
    expect(result.stoppedServices).toContain("supervisor");
    expect(() =>
      readFileSync(resolve(koedHome, "run", "koed-server.json"))
    ).toThrow();
  });

  it("does not remove runtime state replaced while stop is in progress", () => {
    const koedHome = makeHome();
    writeRuntime(koedHome, runtime({ processes: {} }));
    writeSupervisorLock(koedHome, 100);
    let supervisorRunning = true;

    const result = stopKoedServer({
      environment: { KOED_HOME: koedHome },
      checkPid: (pid) => pid === 100 && supervisorRunning,
      sleepSync: () => {
        supervisorRunning = false;
        writeRuntime(
          koedHome,
          runtime({ pid: 200, startedAt: "2026-01-02T00:00:00.000Z" })
        );
      }
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual({
      target: "runtime-state",
      error: "Runtime state changed while stop was in progress"
    });
    expect(
      JSON.parse(
        readFileSync(resolve(koedHome, "run", "koed-server.json"), "utf8")
      )
    ).toMatchObject({ pid: 200 });
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
      checkPid: (pid) => pid === 10 && running,
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
      checkPid: (pid) => pid === 10,
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
    expect(result.missingPids).toEqual([11, 10]);
    expect(result.missingServices).toEqual(["worker", "api"]);
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
      runtime({ services: ["postgres-native", "api", "worker"] })
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

  it("loads native Postgres shutdown overrides from KOED_ENV_PATH", () => {
    const koedHome = makeHome();
    const dataDir = resolve(koedHome, "data", "postgres");
    const envPath = resolve(koedHome, "local.env");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(resolve(dataDir, "PG_VERSION"), "17");
    writeFileSync(envPath, "KOED_POSTGRES_PG_CTL_BIN=/env/bin/pg_ctl\n");
    writeRuntime(
      koedHome,
      runtime({ services: ["postgres-native", "api", "worker"] })
    );
    const calls: Array<{ command: string; args: string[] }> = [];

    const result = stopKoedServer({
      environment: {
        KOED_HOME: koedHome,
        KOED_ENV_PATH: envPath,
        KOED_REPO_ROOT: koedHome
      },
      existsSync: (path) =>
        String(path) === "/env/bin/pg_ctl" ||
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
      command: "/env/bin/pg_ctl",
      args: ["stop", "-D", dataDir, "-m", "fast"]
    });
  });

  it("stops native Embedding Service by recorded PID", () => {
    const koedHome = makeHome();
    writeRuntime(
      koedHome,
      runtime({
        services: ["embedding-service-native", "api", "worker"],
        processes: { api: 10, worker: 11, embeddingService: 13 }
      })
    );
    const pids: number[] = [];

    const result = stopKoedServer({
      environment: { KOED_HOME: koedHome },
      kill: (pid) => pids.push(pid),
      checkPid: () => false
    });

    expect(result.ok).toBe(true);
    expect(pids).toEqual([11, 10, 13]);
    expect(result.stoppedServices).toContain("embedding-service-native");
  });

  it("does not stop external dependency services", () => {
    const koedHome = makeHome();
    writeRuntime(
      koedHome,
      runtime({
        dependencyMode: "external",
        services: ["postgres", "redis", "embedding-service", "api", "worker"]
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
        services: ["postgres", "redis", "api", "worker"]
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
