import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveKoedServerPaths } from "./paths.js";
import {
  observeStoppedRuntime,
  removeStaleRuntimeRecords,
  type StoppedRuntimeDependencies
} from "./stopped-runtime.js";

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true }))
);
const fixture = () => {
  mkdirSync("scratch", { recursive: true });
  const root = mkdtempSync(resolve("scratch", "stopped-runtime-"));
  roots.push(root);
  const paths = resolveKoedServerPaths({ KOED_HOME: root });
  mkdirSync(paths.runDir, { recursive: true });
  mkdirSync(paths.postgresDataDir, { recursive: true });
  const dependencies: StoppedRuntimeDependencies = {
    processState: () => "stopped",
    processIdentity: () => null,
    processes: () => []
  };
  return {
    paths,
    dependencies,
    observe: () => observeStoppedRuntime(paths, dependencies)
  };
};

describe("strict stopped-runtime observation", () => {
  it("accepts absent state and dead cached PIDs only after native discovery", () => {
    const { paths, dependencies, observe } = fixture();
    expect(observe().state).toBe("stopped");
    writeFileSync(
      paths.runtimeStatePath,
      JSON.stringify({ pid: 41, processes: { api: 42, embeddingService: 0 } })
    );
    expect(observe().state).toBe("stopped");
    dependencies.processes = () => {
      throw new Error("ps timeout");
    };
    expect(observe().state).toBe("uncertain");
  });

  it.each(["running", "uncertain"] as const)(
    "refuses %s recorded children without a supervisor lock",
    (state) => {
      const { paths, dependencies, observe } = fixture();
      writeFileSync(
        paths.runtimeStatePath,
        JSON.stringify({ pid: 41, processes: { embeddingService: 42 } })
      );
      dependencies.processState = (pid) => (pid === 42 ? state : "stopped");
      expect(observe()).toMatchObject({ state: "uncertain", pid: 42 });
    }
  );

  it("preserves live, reused, uncertain, and unreadable supervisor locks", () => {
    const { paths, dependencies, observe } = fixture();
    const path = resolve(paths.runDir, "koed-server.lock");
    const contents = JSON.stringify({ pid: 41, processIdentity: "original" });
    writeFileSync(path, contents);
    dependencies.processIdentity = () => "original";
    expect(observe()).toMatchObject({ state: "running", pid: 41 });
    dependencies.processState = () => "running";
    dependencies.processIdentity = () => "reused";
    expect(observe().state).toBe("uncertain");
    dependencies.processState = () => "uncertain";
    dependencies.processIdentity = () => null;
    expect(observe().state).toBe("uncertain");
    expect(readFileSync(path, "utf8")).toBe(contents);
    writeFileSync(path, "{");
    expect(observe().state).toBe("uncertain");
  });

  it("refuses an orphaned live generation and retains stale pins", () => {
    const { paths, dependencies, observe } = fixture();
    const path = resolve(paths.runDir, "runtime-generation.json");
    const contents = JSON.stringify({
      schemaVersion: 1,
      generationId: "a".repeat(64),
      pid: 41,
      processIdentity: "original",
      startedAt: new Date().toISOString(),
      owner: { kind: "cli", installationId: "fixture" },
      pinToken: "b".repeat(64)
    });
    writeFileSync(path, contents);
    dependencies.processIdentity = () => "original";
    expect(observe().state).toBe("running");
    dependencies.processState = () => "uncertain";
    dependencies.processIdentity = () => null;
    expect(observe().state).toBe("uncertain");
    expect(readFileSync(path, "utf8")).toBe(contents);
  });

  it("reports records of a dead supervisor as stale and removes only unchanged ones", () => {
    const { paths, dependencies, observe } = fixture();
    const lock = resolve(paths.runDir, "koed-server.lock");
    const contents = JSON.stringify({ pid: 41, processIdentity: "original" });
    writeFileSync(lock, contents);
    const observation = observe();
    expect(observation).toMatchObject({
      state: "stopped",
      staleRecords: [{ path: lock, contents }]
    });
    // Observation itself never removes evidence.
    expect(readFileSync(lock, "utf8")).toBe(contents);

    // A supervisor that started after observation keeps its new record.
    const replaced = JSON.stringify({ pid: 43, processIdentity: "new" });
    writeFileSync(lock, replaced);
    removeStaleRuntimeRecords(observation);
    expect(readFileSync(lock, "utf8")).toBe(replaced);

    writeFileSync(lock, contents);
    removeStaleRuntimeRecords(observe());
    expect(existsSync(lock)).toBe(false);

    // A dead lock is not stale while native discovery still finds a process.
    writeFileSync(lock, contents);
    dependencies.processes = () => [
      { pid: 44, command: `postgres -D ${paths.postgresDataDir}` }
    ];
    expect(observe()).toMatchObject({ state: "uncertain", pid: 44 });
    expect(observe().staleRecords).toBeUndefined();
  });

  it.each(["41\n", "-41\n", "invalid\n"])(
    "refuses retained Postgres lock %j without removing it",
    (contents) => {
      const { paths, observe } = fixture();
      const path = resolve(paths.postgresDataDir, "postmaster.pid");
      writeFileSync(path, contents);
      expect(observe().state).toBe("uncertain");
      expect(readFileSync(path, "utf8")).toBe(contents);
    }
  );

  it("detects native processes missing from state and ignores other installations", () => {
    const { paths, dependencies, observe } = fixture();
    dependencies.processes = () => [
      {
        pid: 41,
        command: `${paths.koedHome}/runtime/native/payloads/core/llama.cpp/cpu/llama-server --embedding`
      }
    ];
    expect(observe()).toMatchObject({ state: "uncertain", pid: 41 });
    dependencies.processes = () => [
      { pid: 41, command: `postgres -D ${paths.postgresDataDir}` }
    ];
    expect(observe().state).toBe("uncertain");
    dependencies.processes = () => [
      {
        pid: 41,
        command: `${paths.koedHome}-other/runtime/llama.cpp/cpu/llama-server`
      }
    ];
    expect(observe().state).toBe("stopped");
  });

  it("refuses dangling state links, oversized files, and malformed process maps", () => {
    const { paths, observe } = fixture();
    symlinkSync("missing", paths.runtimeStatePath);
    expect(observe().state).toBe("uncertain");
    rmSync(paths.runtimeStatePath);
    writeFileSync(paths.runtimeStatePath, "x".repeat(1024 * 1024 + 1));
    expect(observe().state).toBe("uncertain");
    writeFileSync(
      paths.runtimeStatePath,
      JSON.stringify({ pid: 41, processes: { api: -1 } })
    );
    expect(observe().state).toBe("uncertain");
  });
});
