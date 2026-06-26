import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startKoedServer } from "./start.js";
import type { KoedServerStatus } from "./types.js";

const temps: string[] = [];
const tempDir = () => {
  const path = mkdtempSync(resolve(tmpdir(), "koed-server-start-"));
  temps.push(path);
  return path;
};

const spawnResult = () =>
  ({
    stdout: "",
    stderr: "",
    status: 0,
    signal: null,
    pid: 1,
    output: []
  }) as never;

const healthyStatus = (root: string): KoedServerStatus => ({
  ok: true,
  state: "healthy",
  koedHome: root,
  generatedAt: "2026-01-01T00:00:00.000Z",
  runtimeMode: "developer",
  dependencyMode: "external",
  api: { state: "healthy", url: "http://localhost:3300" },
  database: { state: "healthy" },
  redis: { state: "healthy" },
  workerQueues: { state: "healthy" },
  embeddingService: { state: "healthy" },
  apiToken: { state: "healthy", configured: true },
  mcpServer: { state: "healthy" },
  captureHook: { state: "healthy" },
  codex: { state: "healthy", configured: true },
  lcmSummaryService: { state: "healthy" },
  explorer: { state: "healthy", url: "http://localhost:5174" },
  lastVerification: { state: "healthy", checkedAt: "2026-01-01T00:00:00.000Z" }
});

afterEach(() => {
  for (const path of temps.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("start supervisor", () => {
  it("requires explicit external service URLs without localhost fallbacks", async () => {
    const root = tempDir();
    const commands: Array<{ command: string; args: string[] }> = [];

    await expect(
      startKoedServer({
        environment: {
          KOED_HOME: root,
          KOED_REPO_ROOT: root,
          DATABASE_URL: "postgres://operator/db",
          REDIS_HOST_PORT: "16379",
          EMBEDDING_SERVICE_HOST_PORT: "3800"
        },
        timeoutMs: 1,
        pollIntervalMs: 1,
        spawnSync: (command, args) => {
          commands.push({ command, args });
          return spawnResult();
        },
        collectStatus: async () => healthyStatus(root)
      })
    ).rejects.toThrow(
      "External dependency mode requires Operator-managed service configuration: REDIS_URL, EMBEDDING_SERVICE_URL"
    );

    expect(commands.map((command) => command.args.join(" "))).toEqual([
      resolve(root, "scripts/setup-env.mjs")
    ]);
    expect(commands.some((command) => command.command === "docker")).toBe(
      false
    );
  });

  it("starts bundled-local Postgres and Embedding Service scaffolds without Redis", async () => {
    const root = tempDir();
    mkdirSync(resolve(root, "models"));
    writeFileSync(
      resolve(root, "models", "Qwen3-Embedding-0.6B-Q8_0.gguf"),
      "model"
    );
    const commands: Array<{
      command: string;
      args: string[];
      env?: NodeJS.ProcessEnv;
    }> = [];
    const spawned: Array<{ command: string; args: string[] }> = [];

    writeFileSync(
      resolve(root, ".env"),
      "DATABASE_URL=postgres://wrong:wrong@localhost:15432/wrong\n"
    );

    await startKoedServer({
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        KOED_DEPENDENCY_MODE: "bundled-local",
        POSTGRES_HOST_PORT: "25432"
      },
      timeoutMs: 1,
      pollIntervalMs: 1,
      spawnSync: (command, args, options) => {
        commands.push({ command, args, env: options?.env });
        return spawnResult();
      },
      spawn: (command, args) => {
        spawned.push({ command, args });
        const child = new EventEmitter() as EventEmitter & {
          pid: number;
          kill: () => boolean;
        };
        child.pid = spawned.length;
        child.kill = () => true;
        setTimeout(() => child.emit("exit", 0), 0);
        return child as never;
      },
      collectStatus: async () => healthyStatus(root)
    });

    expect(commands.map((command) => command.args.join(" "))).toEqual([
      resolve(root, "scripts/setup-env.mjs"),
      "compose up -d --build --remove-orphans postgres embedding-service",
      "--filter @koed/api --filter @koed/worker --filter @koed/explorer build"
    ]);
    expect(
      commands.find((command) => command.command === "docker")?.args
    ).not.toContain("redis");
    const buildEnv = commands.at(-1)?.env;
    expect(buildEnv?.WORK_QUEUE_BACKEND).toBe("local");
    expect(buildEnv?.KOED_MODELS_DIR).toBe(resolve(root, "models"));
    expect(buildEnv?.EMBEDDING_MODEL_PATH).toBe(
      "/models/Qwen3-Embedding-0.6B-Q8_0.gguf"
    );
    expect(buildEnv?.DATABASE_URL).toBe(
      "postgres://koed:koed-local-postgres@127.0.0.1:25432/koed"
    );
    expect(buildEnv?.EMBEDDING_SERVICE_URL).toBe("http://localhost:3800");
    expect(spawned.map((entry) => entry.args.join(" "))).toContain(
      "--filter @koed/worker start"
    );
    const runtime = JSON.parse(
      readFileSync(resolve(root, "run/koed-server.json"), "utf8")
    ) as { dependencyMode?: string; services?: string[] };
    expect(runtime.dependencyMode).toBe("bundled-local");
    expect(runtime.services).toEqual([
      "postgres",
      "embedding-service",
      "api",
      "worker",
      "explorer"
    ]);
  });

  it("stops started bundled-local compose services when startup fails", async () => {
    const root = tempDir();
    const commands: Array<{ command: string; args: string[] }> = [];

    await expect(
      startKoedServer({
        environment: {
          KOED_HOME: root,
          KOED_REPO_ROOT: root,
          KOED_DEPENDENCY_MODE: "bundled-local"
        },
        timeoutMs: 1,
        pollIntervalMs: 1,
        spawnSync: (command, args) => {
          commands.push({ command, args });
          if (args.includes("@koed/api")) {
            return {
              stdout: "",
              stderr: "build failed",
              status: 1,
              signal: null,
              pid: 1,
              output: []
            } as never;
          }
          return spawnResult();
        },
        collectStatus: async () => healthyStatus(root)
      })
    ).rejects.toThrow("Build Koed server apps failed");

    expect(commands.map((command) => command.args.join(" "))).toContain(
      "compose stop postgres embedding-service"
    );
  });

  it("mounts a custom reranker-only model directory", async () => {
    const root = tempDir();
    const rerankerDir = resolve(root, "custom-reranker");
    mkdirSync(rerankerDir);
    writeFileSync(resolve(rerankerDir, "reranker.gguf"), "model");
    const commands: Array<{
      command: string;
      args: string[];
      env?: NodeJS.ProcessEnv;
    }> = [];

    await startKoedServer({
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        KOED_DEPENDENCY_MODE: "bundled-local",
        KOED_RERANKER_MODEL_PATH: resolve(rerankerDir, "reranker.gguf")
      },
      timeoutMs: 1,
      pollIntervalMs: 1,
      spawnSync: (command, args, options) => {
        commands.push({ command, args, env: options?.env });
        return spawnResult();
      },
      spawn: () => {
        const child = new EventEmitter() as EventEmitter & {
          pid: number;
          kill: () => boolean;
        };
        child.pid = 1;
        child.kill = () => true;
        setTimeout(() => child.emit("exit", 0), 0);
        return child as never;
      },
      collectStatus: async () => healthyStatus(root)
    });

    const buildEnv = commands.at(-1)?.env;
    expect(buildEnv?.KOED_MODELS_DIR).toBe(rerankerDir);
    expect(buildEnv?.EMBEDDING_MODEL_PATH).toBeUndefined();
    expect(buildEnv?.EMBEDDING_RERANKER_MODEL_PATH).toBe(
      "/models/reranker.gguf"
    );
  });

  it("rejects installed bundled-local models split across directories", async () => {
    const root = tempDir();
    const embeddingDir = resolve(root, "embedding");
    const rerankerDir = resolve(root, "reranker");
    mkdirSync(embeddingDir);
    mkdirSync(rerankerDir);
    writeFileSync(resolve(embeddingDir, "embedding.gguf"), "model");
    writeFileSync(resolve(rerankerDir, "reranker.gguf"), "model");
    const commands: Array<{ command: string; args: string[] }> = [];

    await expect(
      startKoedServer({
        environment: {
          KOED_HOME: root,
          KOED_REPO_ROOT: root,
          KOED_DEPENDENCY_MODE: "bundled-local",
          KOED_EMBEDDING_MODEL_PATH: resolve(embeddingDir, "embedding.gguf"),
          KOED_RERANKER_MODEL_PATH: resolve(rerankerDir, "reranker.gguf")
        },
        timeoutMs: 1,
        pollIntervalMs: 1,
        spawnSync: (command, args) => {
          commands.push({ command, args });
          return spawnResult();
        },
        collectStatus: async () => healthyStatus(root)
      })
    ).rejects.toThrow("Bundled-local model paths must be in one directory");
    expect(commands).toEqual([]);
  });

  it("starts native bundled-local Postgres when native runtime is configured", async () => {
    const root = tempDir();
    const bin = resolve(root, "vendor", "postgres", "bin");
    mkdirSync(bin, { recursive: true });
    for (const name of ["initdb", "pg_ctl", "psql"]) {
      writeFileSync(resolve(bin, name), "");
    }
    const commands: Array<{
      command: string;
      args: string[];
      env?: NodeJS.ProcessEnv;
    }> = [];

    await startKoedServer({
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        KOED_DEPENDENCY_MODE: "bundled-local",
        KOED_BUNDLED_POSTGRES_MODE: "native",
        KOED_POSTGRES_BIN_DIR: bin
      },
      timeoutMs: 1,
      pollIntervalMs: 1,
      spawnSync: (command, args, options) => {
        commands.push({ command, args, env: options?.env });
        if (command.endsWith("pg_ctl") && args.includes("status")) {
          return {
            stdout: "",
            stderr: "not running",
            status: 1,
            signal: null,
            pid: 1,
            output: []
          } as never;
        }
        return spawnResult();
      },
      spawn: () => {
        const child = new EventEmitter() as EventEmitter & {
          pid: number;
          kill: () => boolean;
        };
        child.pid = 1;
        child.kill = () => true;
        setTimeout(() => child.emit("exit", 0), 0);
        return child as never;
      },
      collectStatus: async () => healthyStatus(root)
    });

    expect(commands.map((command) => command.command)).toContain(
      resolve(bin, "pg_ctl")
    );
    expect(commands.map((command) => command.args.join(" "))).toContain(
      "compose up -d --build --remove-orphans embedding-service"
    );
    expect(
      commands.find((command) => command.command === "docker")?.args
    ).not.toContain("postgres");
    const runtime = JSON.parse(
      readFileSync(resolve(root, "run/koed-server.json"), "utf8")
    ) as { services?: string[] };
    expect(runtime.services).toContain("postgres-native");
    expect(runtime.services).not.toContain("postgres");
  });

  it("starts native bundled-local Embedding Service when native runtime is configured", async () => {
    const root = tempDir();
    const appDir = resolve(root, "apps", "embedding-service");
    const venvBin = resolve(appDir, ".venv", "bin");
    const llamaBin = resolve(root, "vendor", "llama.cpp");
    mkdirSync(venvBin, { recursive: true });
    mkdirSync(llamaBin, { recursive: true });
    writeFileSync(resolve(appDir, "app.py"), "");
    writeFileSync(resolve(venvBin, "python"), "");
    writeFileSync(resolve(llamaBin, "llama-server"), "");
    writeFileSync(
      resolve(root, ".env"),
      "EMBEDDING_LLAMA_SERVER_BINARY=/opt/llama.cpp/llama-server\n"
    );
    mkdirSync(resolve(root, "models"));
    writeFileSync(
      resolve(root, "models", "Qwen3-Embedding-0.6B-Q8_0.gguf"),
      "model"
    );
    const commands: Array<{ command: string; args: string[] }> = [];
    const spawned: Array<{
      command: string;
      args: string[];
      env?: NodeJS.ProcessEnv;
    }> = [];

    await startKoedServer({
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        KOED_DEPENDENCY_MODE: "bundled-local",
        KOED_BUNDLED_EMBEDDING_MODE: "native",
        EMBEDDING_MODEL_KEY: "qwen3-0.6b",
        EMBEDDING_RERANKER_KEY: "qwen3-reranker-0.6b",
        EMBEDDING_LLAMA_N_CTX: "4096",
        EMBEDDING_RERANKER_BATCH_LIMIT: "12"
      },
      timeoutMs: 1,
      pollIntervalMs: 1,
      spawnSync: (command, args) => {
        commands.push({ command, args });
        return spawnResult();
      },
      spawn: (command, args, options) => {
        spawned.push({ command, args, env: options?.env });
        const child = new EventEmitter() as EventEmitter & {
          pid: number;
          kill: () => boolean;
        };
        child.pid = spawned.length;
        child.kill = () => true;
        setTimeout(() => child.emit("exit", 0), 0);
        return child as never;
      },
      collectStatus: async () => healthyStatus(root)
    });

    expect(commands.map((command) => command.args.join(" "))).toContain(
      "compose up -d --build --remove-orphans postgres"
    );
    expect(
      commands.find((command) => command.command === "docker")?.args
    ).not.toContain("embedding-service");
    expect(spawned[0]?.command).toBe(resolve(venvBin, "python"));
    expect(spawned[0]?.args.join(" ")).toBe(
      "-m uvicorn app:app --host 127.0.0.1 --port 3800"
    );
    expect(spawned[0]?.env?.MODEL_PATH).toBe(
      resolve(root, "models", "Qwen3-Embedding-0.6B-Q8_0.gguf")
    );
    expect(spawned[0]?.env?.LLAMA_SERVER_BINARY).toBe(
      resolve(llamaBin, "llama-server")
    );
    expect(spawned[0]?.env?.MODEL_KEY).toBe("qwen3-0.6b");
    expect(spawned[0]?.env?.RERANKER_KEY).toBe("qwen3-reranker-0.6b");
    expect(spawned[0]?.env?.LLAMA_N_CTX).toBe("4096");
    expect(spawned[0]?.env?.RERANKER_BATCH_LIMIT).toBe("12");
    const runtime = JSON.parse(
      readFileSync(resolve(root, "run/koed-server.json"), "utf8")
    ) as { services?: string[]; processes?: Record<string, number> };
    expect(runtime.services).toContain("embedding-service-native");
    expect(runtime.services).not.toContain("embedding-service");
    expect(runtime.processes?.embeddingService).toBe(1);
  });

  it("honors bundled-local BullMQ override from .env", async () => {
    const root = tempDir();
    writeFileSync(
      resolve(root, ".env"),
      "KOED_DEPENDENCY_MODE=bundled-local\nWORK_QUEUE_BACKEND=bullmq\n"
    );
    const commands: Array<{
      command: string;
      args: string[];
      env?: NodeJS.ProcessEnv;
    }> = [];

    await startKoedServer({
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root
      },
      timeoutMs: 1,
      pollIntervalMs: 1,
      spawnSync: (command, args, options) => {
        commands.push({ command, args, env: options?.env });
        return spawnResult();
      },
      spawn: () => {
        const child = new EventEmitter() as EventEmitter & {
          pid: number;
          kill: () => boolean;
        };
        child.pid = 1;
        child.kill = () => true;
        setTimeout(() => child.emit("exit", 0), 0);
        return child as never;
      },
      collectStatus: async () => healthyStatus(root)
    });

    expect(commands.map((command) => command.args.join(" "))).toContain(
      "compose up -d --build --remove-orphans postgres redis embedding-service"
    );
    expect(commands.at(-1)?.env?.WORK_QUEUE_BACKEND).toBe("bullmq");
  });

  it("does not require Redis URL for external mode with local work queue", async () => {
    const root = tempDir();
    const spawned: Array<{ command: string; args: string[] }> = [];

    await startKoedServer({
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        DATABASE_URL: "postgres://operator/db",
        EMBEDDING_SERVICE_URL: "http://operator:8000",
        WORK_QUEUE_BACKEND: "local"
      },
      timeoutMs: 1,
      pollIntervalMs: 1,
      spawnSync: () => spawnResult(),
      spawn: (command, args) => {
        spawned.push({ command, args });
        const child = new EventEmitter() as EventEmitter & {
          pid: number;
          kill: () => boolean;
        };
        child.pid = spawned.length;
        child.kill = () => true;
        setTimeout(() => child.emit("exit", 0), 0);
        return child as never;
      },
      collectStatus: async () => healthyStatus(root)
    });

    expect(spawned.map((entry) => entry.args.join(" "))).toContain(
      "--filter @koed/worker start"
    );
  });

  it("starts app services without managing external dependencies", async () => {
    const root = tempDir();
    const commands: Array<{ command: string; args: string[] }> = [];
    const spawned: Array<{ command: string; args: string[] }> = [];

    await startKoedServer({
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        DATABASE_URL: "postgres://operator/db",
        REDIS_URL: "redis://operator:6379",
        EMBEDDING_SERVICE_URL: "http://operator:8000"
      },
      timeoutMs: 1,
      pollIntervalMs: 1,
      spawnSync: (command, args) => {
        commands.push({ command, args });
        return spawnResult();
      },
      spawn: (command, args) => {
        spawned.push({ command, args });
        const child = new EventEmitter() as EventEmitter & {
          pid: number;
          kill: () => boolean;
        };
        child.pid = spawned.length;
        child.kill = () => true;
        setTimeout(() => child.emit("exit", 0), 0);
        return child as never;
      },
      collectStatus: async () => healthyStatus(root)
    });

    expect(commands.map((command) => command.args.join(" "))).toEqual([
      resolve(root, "scripts/setup-env.mjs"),
      "--filter @koed/api --filter @koed/worker --filter @koed/explorer build"
    ]);
    expect(commands.some((command) => command.command === "docker")).toBe(
      false
    );
    expect(spawned.map((entry) => entry.args.join(" "))).toEqual([
      "--filter @koed/api start",
      "--filter @koed/worker start",
      "--filter @koed/explorer exec vite preview --host 127.0.0.1 --port 5174"
    ]);
  });
});
