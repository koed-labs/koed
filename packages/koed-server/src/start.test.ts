import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:net";
import {
  chmodSync,
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

const createPackagedAppRuntime = (root: string) => {
  for (const entry of [
    "koed-runtime/api/dist/index.js",
    "koed-runtime/worker/dist/index.js",
    "koed-runtime/embedding-service/dist/index.js",
    "koed-runtime/explorer-dist/index.html",
    "koed-runtime/mcp-server/dist/cli.js",
    "koed-runtime/mcp-server/dist/capture-hook.js",
    "koed-runtime/api/node_modules/@koed/db/dist/index.js",
    "koed-runtime/api/node_modules/@koed/db/drizzle/meta/_journal.json"
  ]) {
    const path = resolve(root, entry);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, "");
  }
};

const createNativeResources = (root: string) => {
  const pgBin = resolve(root, "vendor", "postgres", "bin");
  const appDir = resolve(root, "apps", "embedding-service");
  const serviceDist = resolve(appDir, "dist");
  const llamaBin = resolve(root, "vendor", "llama.cpp");
  mkdirSync(pgBin, { recursive: true });
  mkdirSync(serviceDist, { recursive: true });
  mkdirSync(llamaBin, { recursive: true });
  for (const name of ["initdb", "pg_ctl", "psql"]) {
    const path = resolve(pgBin, name);
    writeFileSync(path, "");
    chmodSync(path, 0o755);
  }
  const serviceEntry = resolve(serviceDist, "index.js");
  const llamaServer = resolve(llamaBin, "llama-server");
  writeFileSync(serviceEntry, "");
  writeFileSync(llamaServer, "");
  chmodSync(llamaServer, 0o755);
  return {
    pgBin,
    serviceEntry,
    llamaServer: resolve(llamaBin, "llama-server")
  };
};

const child = (pid: number) => {
  const value = new EventEmitter() as EventEmitter & {
    pid: number;
    kill: () => boolean;
  };
  value.pid = pid;
  value.kill = () => true;
  setTimeout(() => value.emit("exit", 0), 0);
  return value as never;
};

const listen = (port: number): Promise<Server> =>
  new Promise((resolveListen, rejectListen) => {
    const server = createServer();
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", () => resolveListen(server));
  });

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolveClose) => server.close(() => resolveClose()));

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

  it("lets one-shot port overrides win over repo .env URLs when starting external mode", async () => {
    const root = tempDir();
    writeFileSync(
      resolve(root, ".env"),
      [
        "API_HOST_PORT=3300",
        "MEMORY_API_URL=http://localhost:3300",
        "EXPLORER_WEB_HOST_PORT=5174",
        "DATABASE_URL=postgres://repo/db",
        "REDIS_URL=redis://repo:6379",
        "EMBEDDING_SERVICE_URL=http://repo:3800"
      ].join("\n")
    );
    const spawned: Array<{ command: string; args: string[] }> = [];

    await startKoedServer({
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        KOED_DEPENDENCY_MODE: "external",
        API_HOST_PORT: "4545",
        EXPLORER_WEB_HOST_PORT: "5574",
        DATABASE_URL: "postgres://operator/db",
        REDIS_URL: "redis://operator:6379",
        EMBEDDING_SERVICE_URL: "http://operator:3800"
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

    const runtime = JSON.parse(
      readFileSync(resolve(root, "run/koed-server.json"), "utf8")
    ) as { apiUrl?: string; explorerUrl?: string };
    expect(runtime.apiUrl).toBe("http://localhost:4545");
    expect(runtime.explorerUrl).toBe("http://localhost:5574");
    expect(
      spawned.find((entry) => entry.args.includes("preview"))?.args
    ).toContain("5574");
  });

  it("starts bundled-local native Postgres and Embedding Service without Docker", async () => {
    const root = tempDir();
    const resources = createNativeResources(root);
    mkdirSync(resolve(root, "models"));
    writeFileSync(
      resolve(root, "models", "Qwen3-Embedding-0.6B-Q8_0.gguf"),
      "model"
    );
    writeFileSync(
      resolve(root, ".env"),
      [
        "DATABASE_URL=postgres://wrong:wrong@localhost:15432/wrong",
        "WORK_QUEUE_BACKEND=bullmq",
        ""
      ].join("\n")
    );
    const commands: Array<{
      command: string;
      args: string[];
      env?: NodeJS.ProcessEnv;
    }> = [];
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
        POSTGRES_HOST_PORT: "25432"
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
      spawn: (command, args, options) => {
        spawned.push({ command, args, env: options?.env });
        return child(spawned.length);
      },
      collectStatus: async () => healthyStatus(root)
    });

    expect(commands.some((command) => command.command === "docker")).toBe(
      false
    );
    expect(commands.map((command) => command.command)).toContain(
      resolve(resources.pgBin, "pg_ctl")
    );
    expect(commands.map((command) => command.args.join(" "))).toContain(
      "--filter @koed/api --filter @koed/worker --filter @koed/embedding-service --filter @koed/explorer build"
    );
    const buildEnv = commands.find((command) =>
      command.args.includes("@koed/embedding-service")
    )?.env;
    expect(buildEnv?.WORK_QUEUE_BACKEND).toBe("local");
    expect(buildEnv?.KOED_MODELS_DIR).toBe(resolve(root, "models"));
    expect(buildEnv?.EMBEDDING_MODEL).toBe("qwen3-0.6b");
    expect(buildEnv?.MODEL_KEY).toBe("qwen3-0.6b");
    expect(buildEnv?.EMBEDDING_MODEL_PATH).toBe(
      resolve(root, "models", "Qwen3-Embedding-0.6B-Q8_0.gguf")
    );
    expect(buildEnv?.DATABASE_URL).toBe(
      "postgres://koed:koed-local-postgres@127.0.0.1:25432/koed"
    );
    expect(spawned[0]?.command).toBe(process.execPath);
    expect(spawned[0]?.args).toEqual([resources.serviceEntry]);
    expect(spawned[0]?.env?.LLAMA_SERVER_BINARY).toBe(resources.llamaServer);
    expect(spawned[0]?.env?.MODEL_PATH).toBe(
      resolve(root, "models", "Qwen3-Embedding-0.6B-Q8_0.gguf")
    );
    expect(spawned.map((entry) => entry.args.join(" "))).toContain(
      "--filter @koed/worker start"
    );
    const runtime = JSON.parse(
      readFileSync(resolve(root, "run/koed-server.json"), "utf8")
    ) as { dependencyMode?: string; services?: string[] };
    expect(runtime.dependencyMode).toBe("bundled-local");
    expect(runtime.services).toEqual([
      "postgres-native",
      "embedding-service-native",
      "api",
      "worker",
      "explorer"
    ]);
  });

  it("fails bundled-local clearly when native resources are missing", async () => {
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
          return spawnResult();
        },
        collectStatus: async () => healthyStatus(root)
      })
    ).rejects.toThrow("Bundled-local native Postgres could not start");

    expect(commands.some((command) => command.command === "docker")).toBe(
      false
    );
  });

  it("does not stop Docker Compose when native startup cleanup runs", async () => {
    const root = tempDir();
    createNativeResources(root);
    const commands: Array<{ command: string; args: string[] }> = [];
    let pgStatusCalls = 0;

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
          if (command.endsWith("pg_ctl") && args.includes("status")) {
            pgStatusCalls += 1;
            return {
              stdout: "",
              stderr: pgStatusCalls === 1 ? "not running" : "",
              status: pgStatusCalls === 1 ? 1 : 0,
              signal: null,
              pid: 1,
              output: []
            } as never;
          }
          return spawnResult();
        },
        spawn: () => child(1),
        collectStatus: async () => healthyStatus(root)
      })
    ).rejects.toThrow("Build Koed server apps failed");

    expect(commands.some((command) => command.command === "docker")).toBe(
      false
    );
    expect(commands.map((command) => command.command)).not.toContain("docker");
  });

  it("allows bundled-local models split across directories for native runtime", async () => {
    const root = tempDir();
    createNativeResources(root);
    const embeddingDir = resolve(root, "embedding");
    const rerankerDir = resolve(root, "reranker");
    mkdirSync(embeddingDir);
    mkdirSync(rerankerDir);
    writeFileSync(resolve(embeddingDir, "embedding.gguf"), "model");
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
        KOED_EMBEDDING_MODEL_PATH: resolve(embeddingDir, "embedding.gguf"),
        KOED_RERANKER_MODEL_PATH: resolve(rerankerDir, "reranker.gguf")
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
      spawn: () => child(1),
      collectStatus: async () => healthyStatus(root)
    });

    const buildEnv = commands.find((command) =>
      command.args.includes("@koed/embedding-service")
    )?.env;
    expect(buildEnv?.EMBEDDING_MODEL_PATH).toBe(
      resolve(embeddingDir, "embedding.gguf")
    );
    expect(buildEnv?.EMBEDDING_RERANKER_MODEL_PATH).toBe(
      resolve(rerankerDir, "reranker.gguf")
    );
  });

  it("requires Operator-managed Redis URL for explicit bundled-local BullMQ override", async () => {
    const root = tempDir();
    createNativeResources(root);
    writeFileSync(
      resolve(root, ".env"),
      "KOED_DEPENDENCY_MODE=bundled-local\n"
    );

    await expect(
      startKoedServer({
        environment: {
          KOED_HOME: root,
          KOED_REPO_ROOT: root,
          WORK_QUEUE_BACKEND: "bullmq"
        },
        timeoutMs: 1,
        pollIntervalMs: 1,
        spawnSync: () => spawnResult(),
        collectStatus: async () => healthyStatus(root)
      })
    ).rejects.toThrow(
      "Bundled-local mode with WORK_QUEUE_BACKEND=bullmq requires an Operator-managed Redis URL"
    );
  });

  it("defaults bundled-local mode to the local work queue even when repo env is BullMQ", async () => {
    const root = tempDir();
    createNativeResources(root);
    writeFileSync(
      resolve(root, ".env"),
      "KOED_DEPENDENCY_MODE=bundled-local\nWORK_QUEUE_BACKEND=bullmq\n"
    );
    const commands: Array<{ env?: NodeJS.ProcessEnv }> = [];

    await startKoedServer({
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root
      },
      timeoutMs: 1,
      pollIntervalMs: 1,
      spawnSync: (_command, _args, options) => {
        commands.push({ env: options?.env });
        return spawnResult();
      },
      spawn: () => child(1),
      collectStatus: async () => healthyStatus(root)
    });

    expect(commands.at(-1)?.env?.WORK_QUEUE_BACKEND).toBe("local");
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
        return child(spawned.length);
      },
      collectStatus: async () => healthyStatus(root)
    });

    expect(spawned.map((entry) => entry.args.join(" "))).toContain(
      "--filter @koed/worker start"
    );
  });

  it("allocates and persists free local ports for Desktop bundled-local startup", async () => {
    const root = tempDir();
    createNativeResources(root);
    const occupiedApi = await listen(43300);
    const spawned: Array<{ env?: NodeJS.ProcessEnv }> = [];

    try {
      await startKoedServer({
        environment: {
          KOED_HOME: root,
          KOED_REPO_ROOT: root,
          KOED_AUTO_PORTS: "1",
          KOED_DEPENDENCY_MODE: "bundled-local"
        },
        timeoutMs: 1,
        pollIntervalMs: 1,
        spawnSync: (command, args) => {
          if (args.includes("api-token:create")) {
            return {
              stdout: "Created Koed API token.\nToken: koed_test_token\n",
              stderr: "",
              status: 0,
              signal: null,
              pid: 1,
              output: []
            } as never;
          }
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
        spawn: (_command, _args, options) => {
          spawned.push({ env: options?.env });
          return child(spawned.length);
        },
        collectStatus: async () => healthyStatus(root)
      });
    } finally {
      await closeServer(occupiedApi);
    }

    const ports = JSON.parse(
      readFileSync(resolve(root, "config/local-ports.json"), "utf8")
    ) as { api: string; explorer: string; postgres: string; embedding: string };
    expect(ports.api).not.toBe("43300");
    expect(Number(ports.explorer)).toBeGreaterThanOrEqual(45174);
    expect(Number(ports.postgres)).toBeGreaterThanOrEqual(45432);
    expect(Number(ports.embedding)).toBeGreaterThanOrEqual(43800);
    expect(spawned.at(-1)?.env?.API_PORT).toBe(ports.api);
    expect(spawned.at(-1)?.env?.EMBEDDING_SERVICE_URL).toBe(
      `http://127.0.0.1:${ports.embedding}`
    );
    expect(spawned.at(-1)?.env?.CORS_ORIGINS).toContain(
      `http://localhost:${ports.explorer}`
    );
    const credential = JSON.parse(
      readFileSync(resolve(root, "config/explorer-token.json"), "utf8")
    ) as { apiToken: string };
    expect(credential.apiToken).toBe("koed_test_token");
  });

  it("starts packaged app services without workspace pnpm scripts", async () => {
    const root = tempDir();
    createPackagedAppRuntime(root);
    const commands: Array<{ command: string; args: string[] }> = [];
    const spawned: Array<{
      command: string;
      args: string[];
      cwd?: string;
      env?: NodeJS.ProcessEnv;
    }> = [];

    await startKoedServer({
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        KOED_PACKAGED_DESKTOP: "1",
        KOED_DEPENDENCY_MODE: "external",
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
      spawn: (command, args, options) => {
        spawned.push({
          command,
          args,
          cwd: options?.cwd?.toString(),
          env: options?.env
        });
        return child(spawned.length);
      },
      collectStatus: async () => healthyStatus(root)
    });

    expect(commands).toEqual([]);
    expect(spawned[0]?.args).toEqual([
      resolve(root, "koed-runtime/api/dist/index.js")
    ]);
    expect(spawned[1]?.args).toEqual([
      resolve(root, "koed-runtime/worker/dist/index.js")
    ]);
    expect(spawned[1]?.env?.EMBEDDING_SERVICE_TOKEN).toBeDefined();
    expect(spawned[1]?.env?.EMBEDDING_SERVICE_TOKEN).not.toBe("");
    expect(spawned[1]?.env?.EMBEDDING_MODEL).toBe("qwen3-0.6b");
    expect(spawned[2]?.args[0]).toMatch(/explorer-static-server\.js$/);
    expect(spawned[2]?.args.slice(1)).toEqual([
      resolve(root, "koed-runtime/explorer-dist"),
      "--host",
      "127.0.0.1",
      "--port",
      "5174"
    ]);
    expect(spawned.map((entry) => entry.command)).not.toContain("pnpm");
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
        return child(spawned.length);
      },
      collectStatus: async () => healthyStatus(root)
    });

    expect(commands.map((command) => command.args.join(" "))).toEqual([
      resolve(root, "scripts/setup-env.mjs"),
      "--filter @koed/api --filter @koed/worker --filter @koed/embedding-service --filter @koed/explorer build"
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
