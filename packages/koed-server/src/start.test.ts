import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:net";
import type { SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  readDesktopLocalCredentialAuthorization,
  storeDesktopLocalCredential
} from "@koed/shared";
import { afterEach, describe, expect, it } from "vitest";
import { resolveKoedServerPaths } from "./paths.js";
import {
  provisionDesktopApiToken,
  provisionDesktopLocalCredential,
  startKoedServer,
  stopChildProcess,
  waitForManagedProcessExits
} from "./start.js";
import { acquireKoedServerSupervisorLock } from "./supervisor-lock.js";
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
  }) satisfies SpawnSyncReturns<string>;

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
  codexTranscriptWatcher: { state: "healthy" },
  codex: { state: "healthy", configured: true },
  lcmSummaryService: { state: "healthy" },
  deviceIdentity: {
    state: "healthy",
    health: "healthy",
    deploymentId: "11111111-1111-4111-8111-111111111111",
    deviceInstanceId: "22222222-2222-4222-8222-222222222222",
    remoteOperationsAllowed: true,
    platformProtection: "verified"
  },
  upstreamBackends: {
    state: "healthy",
    registered: 0,
    validated: 0,
    stale: 0,
    failed: 0,
    notChecked: 0
  },
  lastVerification: { state: "healthy", checkedAt: "2026-01-01T00:00:00.000Z" }
});

const createPackagedAppRuntime = (root: string) => {
  for (const entry of [
    "koed-runtime/api/dist/index.js",
    "koed-runtime/worker/dist/index.js",
    "koed-runtime/embedding-service/dist/index.js",
    "koed-runtime/mcp-server/dist/cli.js",
    "koed-runtime/mcp-server/dist/local-runtime-cli.js",
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

const createSourceDesktopDbRuntime = (
  root: string,
  ownerUserId: string,
  options: {
    activeTokenHash?: string;
    activeTokenOwnerUserId?: string;
  } = {}
): void => {
  const dbPackageRoot = resolve(root, "packages/db");
  const dbDist = resolve(dbPackageRoot, "dist");
  mkdirSync(dbDist, { recursive: true });
  writeFileSync(
    resolve(dbPackageRoot, "package.json"),
    `${JSON.stringify({ type: "module" })}\n`
  );
  writeFileSync(
    resolve(dbDist, "connection.js"),
    [
      "export const createDbPool = () => ({ end: async () => undefined });",
      "export const createDb = (pool) => pool;",
      ""
    ].join("\n")
  );
  writeFileSync(
    resolve(dbDist, "user-api-token-repository.js"),
    [
      `let activeTokenHash = ${JSON.stringify(options.activeTokenHash ?? null)};`,
      "export const createUserApiTokenRepository = () => ({",
      `  findUserByEmail: async () => ({ id: ${JSON.stringify(ownerUserId)} }),`,
      `  createUser: async () => ({ id: ${JSON.stringify(ownerUserId)} }),`,
      "  createApiToken: async (input) => { activeTokenHash = input.tokenHash; },",
      `  getApiTokenUser: async (tokenHash) => tokenHash === activeTokenHash ? ({ id: ${JSON.stringify(options.activeTokenOwnerUserId ?? ownerUserId)} }) : null`,
      "});",
      ""
    ].join("\n")
  );
};

const child = (pid: number) => {
  const value = new EventEmitter() as EventEmitter & {
    pid: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: (signal?: NodeJS.Signals) => boolean;
  };
  value.pid = pid;
  value.exitCode = null;
  value.signalCode = null;
  value.kill = (signal = "SIGTERM") => {
    setImmediate(() => {
      value.signalCode = signal;
      value.emit("exit", null, signal);
    });
    return true;
  };
  return value as never;
};

const cleanShutdownSignal = (): AbortSignal => AbortSignal.timeout(0);

const controlledChild = (pid: number) => {
  const signals: NodeJS.Signals[] = [];
  const value = new EventEmitter() as EventEmitter & {
    pid: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: (signal?: NodeJS.Signals) => boolean;
  };
  value.pid = pid;
  value.exitCode = null;
  value.signalCode = null;
  value.kill = (signal = "SIGTERM") => {
    signals.push(signal);
    setImmediate(() => {
      value.signalCode = signal;
      value.emit("exit", null, signal);
    });
    return true;
  };
  return {
    process: value as never,
    signals,
    exit: (code: number | null, signal: NodeJS.Signals | null = null) => {
      value.exitCode = code;
      value.signalCode = signal;
      value.emit("exit", code, signal);
    },
    fail: (error: Error) => value.emit("error", error)
  };
};

const listen = (port: number): Promise<Server> =>
  new Promise((resolveListen, rejectListen) => {
    const server = createServer();
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", () => resolveListen(server));
  });

const occupyPort = async (port: number): Promise<Server | null> => {
  try {
    return await listen(port);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "EADDRINUSE"
    ) {
      return null;
    }
    throw error;
  }
};

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolveClose) => server.close(() => resolveClose()));

afterEach(() => {
  for (const path of temps.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("start supervisor", () => {
  it("creates one Desktop Local Credential for the Personal owner", () => {
    const root = tempDir();
    const paths = resolveKoedServerPaths({
      KOED_HOME: root,
      KOED_REPO_ROOT: root
    });
    const ownerUserId = "11111111-1111-4111-8111-111111111111";

    expect(provisionDesktopLocalCredential(paths, ownerUserId)).toBeUndefined();

    const stored = readDesktopLocalCredentialAuthorization(root);
    expect(stored?.ownerUserId).toBe(ownerUserId);
    expect(stored?.operationFamilies).toEqual([
      "personal_collaboration_read",
      "personal_collaboration_write"
    ]);
  });

  it("reuses the Desktop Local Credential only for the same owner and families", () => {
    const root = tempDir();
    const paths = resolveKoedServerPaths({
      KOED_HOME: root,
      KOED_REPO_ROOT: root
    });
    const ownerUserId = "22222222-2222-4222-8222-222222222222";
    provisionDesktopLocalCredential(paths, ownerUserId);
    const before = readDesktopLocalCredentialAuthorization(root);

    provisionDesktopLocalCredential(paths, ownerUserId);

    const after = readDesktopLocalCredentialAuthorization(root);
    expect(after?.credentialKeyId).toBe(before?.credentialKeyId);
    expect(after?.createdAt).toBe(before?.createdAt);
    expect(after?.updatedAt).toBe(before?.updatedAt);
  });

  it("fails closed when the Desktop Local Credential owner or families mismatch", () => {
    const ownerMismatchRoot = tempDir();
    const ownerMismatchPaths = resolveKoedServerPaths({
      KOED_HOME: ownerMismatchRoot,
      KOED_REPO_ROOT: ownerMismatchRoot
    });
    provisionDesktopLocalCredential(
      ownerMismatchPaths,
      "33333333-3333-4333-8333-333333333333"
    );

    expect(() =>
      provisionDesktopLocalCredential(
        ownerMismatchPaths,
        "44444444-4444-4444-8444-444444444444"
      )
    ).toThrow(/active Personal owner/);

    const familyMismatchRoot = tempDir();
    const familyMismatchPaths = resolveKoedServerPaths({
      KOED_HOME: familyMismatchRoot,
      KOED_REPO_ROOT: familyMismatchRoot
    });
    const ownerUserId = "55555555-5555-4555-8555-555555555555";
    storeDesktopLocalCredential(familyMismatchRoot, {
      ownerUserId,
      operationFamilies: ["personal_collaboration_read"]
    });

    expect(() =>
      provisionDesktopLocalCredential(familyMismatchPaths, ownerUserId)
    ).toThrow(/required Personal operation families/);
  });

  it("rejects an owner mismatch before minting a Desktop API Token", async () => {
    const root = tempDir();
    const paths = resolveKoedServerPaths({
      KOED_HOME: root,
      KOED_REPO_ROOT: root
    });
    provisionDesktopLocalCredential(
      paths,
      "88888888-8888-4888-8888-888888888888"
    );
    createSourceDesktopDbRuntime(root, "99999999-9999-4999-8999-999999999999");

    await expect(
      provisionDesktopApiToken(
        paths,
        {
          kind: "source",
          dbPackageRoot: resolve(root, "packages/db")
        } as never,
        {
          KOED_AUTO_PORTS: "1",
          API_TOKEN_PEPPER: "test-api-token-pepper"
        }
      )
    ).rejects.toThrow(/active Personal owner/);
  });

  it("provisions source Desktop API Tokens through the runtime repository", async () => {
    const root = tempDir();
    const paths = resolveKoedServerPaths({
      KOED_HOME: root,
      KOED_REPO_ROOT: root
    });
    createSourceDesktopDbRuntime(root, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const token = await provisionDesktopApiToken(
      paths,
      {
        kind: "source",
        dbPackageRoot: resolve(root, "packages/db")
      } as never,
      {
        KOED_AUTO_PORTS: "1",
        API_TOKEN_PEPPER: "test-api-token-pepper"
      }
    );

    expect(token).toMatch(/^cmt_/);
    expect(
      JSON.parse(
        readFileSync(resolve(root, "config/local-app-credential.json"), "utf8")
      )
    ).toMatchObject({ apiToken: token, source: "environment" });
  });

  it("reuses an active persisted Desktop API Token across restarts", async () => {
    const root = tempDir();
    const paths = resolveKoedServerPaths({
      KOED_HOME: root,
      KOED_REPO_ROOT: root
    });
    createSourceDesktopDbRuntime(root, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const runtime = {
      kind: "source",
      dbPackageRoot: resolve(root, "packages/db")
    } as never;
    const environment = {
      KOED_AUTO_PORTS: "1",
      API_TOKEN_PEPPER: "test-api-token-pepper"
    };

    const first = await provisionDesktopApiToken(paths, runtime, environment);
    const firstCredential = readFileSync(
      resolve(root, "config/local-app-credential.json"),
      "utf8"
    );
    const second = await provisionDesktopApiToken(paths, runtime, environment);

    expect(second).toBe(first);
    expect(
      readFileSync(resolve(root, "config/local-app-credential.json"), "utf8")
    ).toBe(firstCredential);
  });

  it("replaces a persisted Desktop API Token that is no longer active", async () => {
    const root = tempDir();
    const paths = resolveKoedServerPaths({
      KOED_HOME: root,
      KOED_REPO_ROOT: root
    });
    createSourceDesktopDbRuntime(root, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    mkdirSync(resolve(root, "config"), { recursive: true });
    writeFileSync(
      resolve(root, "config/local-app-credential.json"),
      `${JSON.stringify({
        apiToken: "cmt_revoked",
        provisionedAt: "2026-01-01T00:00:00.000Z",
        source: "environment"
      })}\n`
    );

    const replacement = await provisionDesktopApiToken(
      paths,
      {
        kind: "source",
        dbPackageRoot: resolve(root, "packages/db")
      } as never,
      {
        KOED_AUTO_PORTS: "1",
        API_TOKEN_PEPPER: "test-api-token-pepper"
      }
    );

    expect(replacement).toMatch(/^cmt_/);
    expect(replacement).not.toBe("cmt_revoked");
  });

  it("rejects a persisted Desktop API Token owned by another user", async () => {
    const root = tempDir();
    const paths = resolveKoedServerPaths({
      KOED_HOME: root,
      KOED_REPO_ROOT: root
    });
    const persistedToken = "cmt_other_owner";
    const apiTokenPepper = "test-api-token-pepper";
    createSourceDesktopDbRuntime(root, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
      activeTokenHash: createHash("sha256")
        .update(`${apiTokenPepper}${persistedToken}`)
        .digest("hex"),
      activeTokenOwnerUserId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    });
    mkdirSync(resolve(root, "config"), { recursive: true });
    writeFileSync(
      resolve(root, "config/local-app-credential.json"),
      `${JSON.stringify({
        apiToken: persistedToken,
        provisionedAt: "2026-01-01T00:00:00.000Z",
        source: "environment"
      })}\n`
    );

    await expect(
      provisionDesktopApiToken(
        paths,
        {
          kind: "source",
          dbPackageRoot: resolve(root, "packages/db")
        } as never,
        {
          KOED_AUTO_PORTS: "1",
          API_TOKEN_PEPPER: apiTokenPepper
        }
      )
    ).rejects.toThrow(/different Personal owner/);
  });

  it("does not provision a Desktop API Token outside automatic local ports", async () => {
    const root = tempDir();
    const paths = resolveKoedServerPaths({
      KOED_HOME: root,
      KOED_REPO_ROOT: root
    });
    createSourceDesktopDbRuntime(root, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

    await expect(
      provisionDesktopApiToken(
        paths,
        {
          kind: "source",
          dbPackageRoot: resolve(root, "packages/db")
        } as never,
        {
          KOED_AUTO_PORTS: "0",
          API_TOKEN_PEPPER: "test-api-token-pepper"
        }
      )
    ).resolves.toBeNull();
  });

  it("fails closed without replacing a corrupt Desktop Local Credential", () => {
    const root = tempDir();
    const paths = resolveKoedServerPaths({
      KOED_HOME: root,
      KOED_REPO_ROOT: root
    });
    const ownerUserId = "66666666-6666-4666-8666-666666666666";
    provisionDesktopLocalCredential(paths, ownerUserId);
    const storePath = resolve(root, "secrets/upstream-credentials.json");
    const store = JSON.parse(readFileSync(storePath, "utf8")) as {
      secrets: Record<string, { tag: string }>;
    };
    store.secrets["keychain://koed-desktop-local/install"]!.tag =
      Buffer.alloc(16).toString("base64");
    writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`);
    const corruptedDigest = createHash("sha256")
      .update(readFileSync(storePath))
      .digest("hex");

    expect(readDesktopLocalCredentialAuthorization(root)).toBeNull();
    expect(() => provisionDesktopLocalCredential(paths, ownerUserId)).toThrow(
      /already stored/
    );
    expect(
      createHash("sha256").update(readFileSync(storePath)).digest("hex")
    ).toBe(corruptedDigest);
  });

  it("awaits native child exit without blocking the event loop", async () => {
    const signals: NodeJS.Signals[] = [];
    const value = new EventEmitter() as EventEmitter & {
      pid: number;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      kill: (signal?: NodeJS.Signals) => boolean;
    };
    value.pid = 123;
    value.exitCode = null;
    value.signalCode = null;
    value.kill = (signal = "SIGTERM") => {
      signals.push(signal);
      setImmediate(() => {
        value.signalCode = signal;
        value.emit("exit", null, signal);
      });
      return true;
    };

    await expect(
      stopChildProcess(value as never, 100)
    ).resolves.toBeUndefined();
    expect(signals).toEqual(["SIGTERM"]);
  });

  it("rejects when a managed process exited before listeners attach", async () => {
    const alreadyExited = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
    };
    alreadyExited.exitCode = 0;
    alreadyExited.signalCode = null;
    const live = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
    };
    live.exitCode = null;
    live.signalCode = null;

    const waiting = waitForManagedProcessExits({
      alreadyExited: alreadyExited as never,
      live: live as never
    });
    await expect(waiting).rejects.toThrow(
      "Essential managed child alreadyExited exited unexpectedly with code 0"
    );
    expect(live.listenerCount("exit")).toBe(0);
    expect(live.listenerCount("error")).toBe(0);
  });

  it("coordinates sibling shutdown and rejects when one essential child exits", async () => {
    const root = tempDir();
    const api = controlledChild(1);
    const localAiRuntime = controlledChild(2);
    const worker = controlledChild(3);
    const spawned = [api, localAiRuntime, worker];
    let scheduledFailure = false;

    await expect(
      startKoedServer({
        environment: {
          KOED_HOME: root,
          KOED_REPO_ROOT: root,
          KOED_DEPENDENCY_MODE: "external",
          DATABASE_URL: "postgres://operator/db",
          REDIS_URL: "redis://operator:6379",
          EMBEDDING_SERVICE_URL: "http://operator:8000",
          MEMORY_API_TOKEN: "test-runtime-token"
        },
        timeoutMs: 1,
        pollIntervalMs: 1,
        spawnSync: () => spawnResult(),
        spawn: () => spawned.shift()!.process,
        collectStatus: async () => {
          if (!scheduledFailure) {
            scheduledFailure = true;
            setImmediate(() => api.exit(1));
          }
          return healthyStatus(root);
        }
      })
    ).rejects.toThrow(
      "Essential managed child api exited unexpectedly with code 1"
    );

    expect(worker.signals).toEqual(["SIGTERM"]);
    expect(localAiRuntime.signals).toEqual(["SIGTERM"]);
    expect(api.signals).toEqual([]);
  });

  it("propagates a managed child error after stopping live siblings", async () => {
    const root = tempDir();
    const api = controlledChild(1);
    const localAiRuntime = controlledChild(2);
    const worker = controlledChild(3);
    const spawned = [api, localAiRuntime, worker];
    let scheduledFailure = false;

    await expect(
      startKoedServer({
        environment: {
          KOED_HOME: root,
          KOED_REPO_ROOT: root,
          KOED_DEPENDENCY_MODE: "external",
          DATABASE_URL: "postgres://operator/db",
          REDIS_URL: "redis://operator:6379",
          EMBEDDING_SERVICE_URL: "http://operator:8000",
          MEMORY_API_TOKEN: "test-runtime-token"
        },
        timeoutMs: 1,
        pollIntervalMs: 1,
        spawnSync: () => spawnResult(),
        spawn: () => spawned.shift()!.process,
        collectStatus: async () => {
          if (!scheduledFailure) {
            scheduledFailure = true;
            setImmediate(() =>
              worker.fail(new Error("worker connection lost"))
            );
          }
          return healthyStatus(root);
        }
      })
    ).rejects.toThrow(
      "Essential managed child worker failed: worker connection lost"
    );

    expect(worker.signals).toEqual(["SIGTERM"]);
    expect(api.signals).toEqual(["SIGTERM"]);
    expect(localAiRuntime.signals).toEqual(["SIGTERM"]);
    expect(existsSync(resolve(root, "run/koed-server.json"))).toBe(false);
    expect(existsSync(resolve(root, "run/koed-server.lock"))).toBe(false);
  });

  it("treats an independently terminated essential child as a failure", async () => {
    const root = tempDir();
    const api = controlledChild(1);
    const localAiRuntime = controlledChild(2);
    const worker = controlledChild(3);
    const spawned = [api, localAiRuntime, worker];
    let scheduledStop = false;

    await expect(
      startKoedServer({
        environment: {
          KOED_HOME: root,
          KOED_REPO_ROOT: root,
          KOED_DEPENDENCY_MODE: "external",
          DATABASE_URL: "postgres://operator/db",
          REDIS_URL: "redis://operator:6379",
          EMBEDDING_SERVICE_URL: "http://operator:8000",
          MEMORY_API_TOKEN: "test-runtime-token"
        },
        timeoutMs: 1,
        pollIntervalMs: 1,
        spawnSync: () => spawnResult(),
        spawn: () => spawned.shift()!.process,
        collectStatus: async () => {
          if (!scheduledStop) {
            scheduledStop = true;
            setImmediate(() => worker.exit(null, "SIGTERM"));
          }
          return healthyStatus(root);
        }
      })
    ).rejects.toThrow(
      "Essential managed child worker exited unexpectedly with signal SIGTERM"
    );

    expect(worker.signals).toEqual([]);
    expect(api.signals).toEqual(["SIGTERM"]);
    expect(localAiRuntime.signals).toEqual(["SIGTERM"]);
    expect(existsSync(resolve(root, "run/koed-server.json"))).toBe(false);
    expect(existsSync(resolve(root, "run/koed-server.lock"))).toBe(false);
  });

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
        "DATABASE_URL=postgres://repo/db",
        "REDIS_URL=redis://repo:6379",
        "EMBEDDING_SERVICE_URL=http://repo:3800",
        "EMBEDDING_SERVICE_TOKEN=repo-token",
        "API_COOKIE_SECURE=false"
      ].join("\n")
    );
    const spawned: Array<{
      command: string;
      args: string[];
      env?: NodeJS.ProcessEnv;
    }> = [];
    let runtime: { apiUrl?: string } | undefined;

    await startKoedServer({
      signal: cleanShutdownSignal(),
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        KOED_DEPENDENCY_MODE: "external",
        API_HOST_PORT: "4545",
        DATABASE_URL: "postgres://operator/db",
        REDIS_URL: "redis://operator:6379",
        EMBEDDING_SERVICE_URL: "http://operator:3800",
        EMBEDDING_SERVICE_TOKEN: "operator-token",
        API_COOKIE_SECURE: "true",
        MEMORY_API_TOKEN: "test-runtime-token"
      },
      timeoutMs: 1,
      pollIntervalMs: 1,
      spawnSync: () => spawnResult(),
      spawn: (command, args, options) => {
        spawned.push({ command, args, env: options?.env });
        return child(spawned.length);
      },
      collectStatus: async () => {
        runtime = JSON.parse(
          readFileSync(resolve(root, "run/koed-server.json"), "utf8")
        ) as { apiUrl?: string };
        return healthyStatus(root);
      }
    });

    expect(runtime?.apiUrl).toBe("http://localhost:4545");
    expect(
      spawned
        .filter((entry) =>
          entry.args.some(
            (arg) =>
              arg.endsWith("apps/api/dist/index.js") ||
              arg.endsWith("apps/worker/dist/index.js")
          )
        )
        .map((entry) => entry.env?.EMBEDDING_SERVICE_TOKEN)
    ).toEqual(["operator-token", "operator-token"]);
    expect(
      spawned.find((entry) =>
        entry.args.some((arg) => arg.endsWith("apps/api/dist/index.js"))
      )?.env?.COOKIE_SECURE
    ).toBe("true");
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
        "EMBEDDING_LLAMA_EMBEDDING_SERVER_PORT=18080",
        "EMBEDDING_LLAMA_RERANKER_SERVER_PORT=19080",
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
    let runtime: { dependencyMode?: string; services?: string[] } | undefined;

    await startKoedServer({
      signal: cleanShutdownSignal(),
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        KOED_DEPENDENCY_MODE: "bundled-local",
        MEMORY_API_TOKEN: "test-runtime-token",
        POSTGRES_HOST_PORT: "25432",
        EMBEDDING_LLAMA_EMBEDDING_SERVER_PORT: "18081",
        EMBEDDING_LLAMA_RERANKER_SERVER_PORT: "19081"
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
      collectStatus: async () => {
        runtime = JSON.parse(
          readFileSync(resolve(root, "run/koed-server.json"), "utf8")
        ) as { dependencyMode?: string; services?: string[] };
        return healthyStatus(root);
      }
    });

    expect(commands.some((command) => command.command === "docker")).toBe(
      false
    );
    expect(commands.map((command) => command.command)).toContain(
      resolve(resources.pgBin, "pg_ctl")
    );
    expect(commands.map((command) => command.args.join(" "))).toContain(
      "--filter @koed/api --filter @koed/worker --filter @koed/embedding-service --filter @koed/mcp-server build"
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
    expect(buildEnv?.DATABASE_URL).toMatch(
      /^postgres:\/\/koed:[A-Za-z0-9_-]+@127\.0\.0\.1:25432\/koed$/
    );
    expect(buildEnv?.DATABASE_URL).not.toContain("wrong");
    expect(spawned[0]?.command).toBe(process.execPath);
    expect(spawned[0]?.args).toEqual([resources.serviceEntry]);
    expect(spawned[0]?.env?.LLAMA_SERVER_BINARY).toBe(resources.llamaServer);
    expect(spawned[0]?.env?.LLAMA_EMBEDDING_SERVER_PORT).toBe("18081");
    expect(spawned[0]?.env?.LLAMA_RERANKER_SERVER_PORT).toBe("19081");
    expect(spawned[0]?.env?.MODEL_PATH).toBe(
      resolve(root, "models", "Qwen3-Embedding-0.6B-Q8_0.gguf")
    );
    expect(spawned.map((entry) => entry.args.join(" "))).toContain(
      resolve(root, "apps/worker/dist/index.js")
    );
    expect(runtime?.dependencyMode).toBe("bundled-local");
    expect(runtime?.services).toEqual([
      "postgres-native",
      "embedding-service-native",
      "api",
      "worker",
      "local-ai-runtime"
    ]);
  });

  it("loads runtime and path settings from the selected env before startup", async () => {
    const root = tempDir();
    const resources = createNativeResources(root);
    createSourceDesktopDbRuntime(root, "77777777-7777-4777-8777-777777777777");
    const modelsDir = resolve(root, "shared-models");
    const envPath = resolve(root, "profile.env");
    mkdirSync(modelsDir);
    writeFileSync(
      resolve(modelsDir, "Qwen3-Embedding-0.6B-Q8_0.gguf"),
      "model"
    );
    writeFileSync(
      envPath,
      [
        "KOED_RUNTIME_MODE=local-personal",
        "KOED_DEPENDENCY_MODE=bundled-local",
        `KOED_MODELS_DIR=${modelsDir}`,
        "API_HOST_PORT=23300",
        "POSTGRES_HOST_PORT=25432",
        "EMBEDDING_SERVICE_HOST_PORT=23800",
        "EMBEDDING_LLAMA_EMBEDDING_SERVER_PORT=28080",
        "EMBEDDING_LLAMA_RERANKER_SERVER_PORT=29080",
        ""
      ].join("\n")
    );
    const spawned: Array<{
      command: string;
      args: string[];
      env?: NodeJS.ProcessEnv;
    }> = [];
    let runtime:
      | {
          runtimeMode?: string;
          dependencyMode?: string;
          automaticPorts?: boolean;
        }
      | undefined;

    await startKoedServer({
      signal: cleanShutdownSignal(),
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        KOED_ENV_PATH: envPath,
        KOED_AUTO_PORTS: "1",
        API_TOKEN_PEPPER: "test-api-token-pepper"
      },
      timeoutMs: 1,
      pollIntervalMs: 1,
      spawnSync: (command, args) => {
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
      collectStatus: async () => {
        runtime = JSON.parse(
          readFileSync(resolve(root, "run/koed-server.json"), "utf8")
        ) as { runtimeMode?: string; dependencyMode?: string };
        return healthyStatus(root);
      }
    });

    expect(runtime).toMatchObject({
      runtimeMode: "local-personal",
      dependencyMode: "bundled-local",
      automaticPorts: true
    });
    expect(spawned[0]).toMatchObject({
      command: process.execPath,
      args: [resources.serviceEntry]
    });
    expect(spawned[0]?.env?.MODEL_PATH).toBe(
      resolve(modelsDir, "Qwen3-Embedding-0.6B-Q8_0.gguf")
    );
    expect(spawned[0]?.env?.EMBEDDING_SERVICE_PORT).toBe("23800");
    expect(spawned[0]?.env?.LLAMA_EMBEDDING_SERVER_PORT).toBe("28080");
    expect(spawned[0]?.env?.LLAMA_RERANKER_SERVER_PORT).toBe("29080");
    expect(spawned.at(-1)?.env?.API_PORT).toBe("23300");
    const provisionedTokenFile: unknown = JSON.parse(
      readFileSync(resolve(root, "config/local-app-credential.json"), "utf8")
    );
    if (
      provisionedTokenFile === null ||
      typeof provisionedTokenFile !== "object" ||
      !("apiToken" in provisionedTokenFile) ||
      typeof provisionedTokenFile.apiToken !== "string"
    ) {
      throw new TypeError("Local app credential fixture is invalid");
    }
    const provisionedToken = provisionedTokenFile.apiToken;
    const worker = spawned.find((entry) =>
      entry.args.some((arg) => arg.endsWith("apps/worker/dist/index.js"))
    );
    expect(provisionedToken).toMatch(/^cmt_/);
    expect(worker?.env?.MEMORY_API_TOKEN).toBe(provisionedToken);
    expect(worker?.env?.MEMORY_API_URL).toBe("http://localhost:23300");
    expect(
      JSON.parse(readFileSync(resolve(root, "config/local-ports.json"), "utf8"))
    ).toEqual({
      api: "23300",
      postgres: "25432",
      embedding: "23800",
      llamaEmbedding: "28080",
      llamaReranker: "29080"
    });
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
      signal: cleanShutdownSignal(),
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        KOED_DEPENDENCY_MODE: "bundled-local",
        MEMORY_API_TOKEN: "test-runtime-token",
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
      signal: cleanShutdownSignal(),
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        MEMORY_API_TOKEN: "test-runtime-token"
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
      signal: cleanShutdownSignal(),
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        DATABASE_URL: "postgres://operator/db",
        EMBEDDING_SERVICE_URL: "http://operator:8000",
        MEMORY_API_TOKEN: "test-runtime-token",
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
      resolve(root, "apps/worker/dist/index.js")
    );
  });

  it("allocates and persists free local ports for Desktop bundled-local startup", async () => {
    const root = tempDir();
    createNativeResources(root);
    const ownerUserId = "77777777-7777-4777-8777-777777777777";
    createSourceDesktopDbRuntime(root, ownerUserId);
    const occupiedApi = await occupyPort(43300);
    const occupiedLlamaEmbedding = await occupyPort(18080);
    const spawned: Array<{ env?: NodeJS.ProcessEnv }> = [];

    try {
      await startKoedServer({
        signal: cleanShutdownSignal(),
        environment: {
          KOED_HOME: root,
          KOED_REPO_ROOT: root,
          KOED_AUTO_PORTS: "1",
          KOED_DEPENDENCY_MODE: "bundled-local",
          API_TOKEN_PEPPER: "test-api-token-pepper"
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
      if (occupiedApi) {
        await closeServer(occupiedApi);
      }
      if (occupiedLlamaEmbedding) {
        await closeServer(occupiedLlamaEmbedding);
      }
    }

    const ports = JSON.parse(
      readFileSync(resolve(root, "config/local-ports.json"), "utf8")
    ) as {
      api: string;
      postgres: string;
      embedding: string;
      llamaEmbedding: string;
      llamaReranker: string;
    };
    expect(ports.api).not.toBe("43300");
    expect(Number(ports.postgres)).toBeGreaterThanOrEqual(45432);
    expect(Number(ports.embedding)).toBeGreaterThanOrEqual(43800);
    expect(ports.llamaEmbedding).not.toBe("18080");
    expect(Number(ports.llamaReranker)).toBeGreaterThanOrEqual(19080);
    expect(spawned[0]?.env?.LLAMA_EMBEDDING_SERVER_PORT).toBe(
      ports.llamaEmbedding
    );
    expect(spawned[0]?.env?.LLAMA_RERANKER_SERVER_PORT).toBe(
      ports.llamaReranker
    );
    expect(spawned.at(-1)?.env?.API_PORT).toBe(ports.api);
    expect(spawned.at(-1)?.env?.EMBEDDING_SERVICE_URL).toBe(
      `http://127.0.0.1:${ports.embedding}`
    );
    expect(spawned.at(-1)?.env?.CORS_ORIGINS?.split(",")).toContain(
      "koed://app"
    );
    const credential = JSON.parse(
      readFileSync(resolve(root, "config/local-app-credential.json"), "utf8")
    ) as { apiToken: string };
    expect(credential.apiToken).toMatch(/^cmt_/);
    const desktopCredential = readDesktopLocalCredentialAuthorization(root);
    expect(desktopCredential?.ownerUserId).toBe(ownerUserId);
    expect(desktopCredential?.operationFamilies).toEqual([
      "personal_collaboration_read",
      "personal_collaboration_write"
    ]);
  });

  it("does not inherit implicit repo env ports for a new Desktop device", async () => {
    const root = tempDir();
    createNativeResources(root);
    createSourceDesktopDbRuntime(root, "77777777-7777-4777-8777-777777777777");
    writeFileSync(
      resolve(root, ".env"),
      [
        "API_HOST_PORT=3300",
        "POSTGRES_HOST_PORT=15432",
        "EMBEDDING_SERVICE_HOST_PORT=3800",
        "EMBEDDING_LLAMA_EMBEDDING_SERVER_PORT=28080",
        "EMBEDDING_LLAMA_RERANKER_SERVER_PORT=29080",
        ""
      ].join("\n")
    );
    const spawned: Array<{ env?: NodeJS.ProcessEnv }> = [];

    await startKoedServer({
      signal: cleanShutdownSignal(),
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        KOED_AUTO_PORTS: "1",
        KOED_DEPENDENCY_MODE: "bundled-local",
        API_TOKEN_PEPPER: "test-api-token-pepper"
      },
      timeoutMs: 1,
      pollIntervalMs: 1,
      spawnSync: (command, args) => {
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

    const ports = JSON.parse(
      readFileSync(resolve(root, "config/local-ports.json"), "utf8")
    ) as {
      api: string;
      postgres: string;
      embedding: string;
      llamaEmbedding: string;
      llamaReranker: string;
    };
    expect(ports.api).not.toBe("3300");
    expect(ports.postgres).not.toBe("15432");
    expect(ports.embedding).not.toBe("3800");
    expect(ports.llamaEmbedding).not.toBe("28080");
    expect(ports.llamaReranker).not.toBe("29080");
    expect(spawned.at(-1)?.env?.API_PORT).toBe(ports.api);
  });

  it("does not allocate ports when a live supervisor owns KOED_HOME", async () => {
    const root = tempDir();
    const lock = acquireKoedServerSupervisorLock(
      resolveKoedServerPaths({ KOED_HOME: root, KOED_REPO_ROOT: root })
    );
    expect(lock.acquired).toBe(true);
    const commands: string[] = [];

    await startKoedServer({
      signal: cleanShutdownSignal(),
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        KOED_AUTO_PORTS: "1",
        KOED_DEPENDENCY_MODE: "bundled-local"
      },
      spawnSync: (command) => {
        commands.push(command);
        return spawnResult();
      }
    });

    expect(commands).toEqual([]);
    expect(() =>
      readFileSync(resolve(root, "config/local-ports.json"), "utf8")
    ).toThrow();
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
      signal: cleanShutdownSignal(),
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        KOED_PACKAGED_DESKTOP: "1",
        KOED_DEPENDENCY_MODE: "external",
        DATABASE_URL: "postgres://operator/db",
        REDIS_URL: "redis://operator:6379",
        EMBEDDING_SERVICE_URL: "http://operator:8000",
        MEMORY_API_TOKEN: "test-runtime-token"
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
      resolve(root, "koed-runtime/mcp-server/dist/local-runtime-cli.js")
    ]);
    expect(spawned[2]?.args).toEqual([
      resolve(root, "koed-runtime/worker/dist/index.js")
    ]);
    expect(spawned[2]?.env?.EMBEDDING_SERVICE_TOKEN).toBeDefined();
    expect(spawned[2]?.env?.EMBEDDING_SERVICE_TOKEN).not.toBe("");
    expect(
      spawned[0]?.env?.OWNER_PRIVATE_REPLICA_DATA_ENCRYPTION_KEY
    ).toBeDefined();
    expect(spawned[0]?.env?.OWNER_PRIVATE_REPLICA_DATA_ENCRYPTION_KEY).not.toBe(
      spawned[0]?.env?.DATA_ENCRYPTION_KEY
    );
    expect(spawned[2]?.env?.EMBEDDING_MODEL).toBe("qwen3-0.6b");
    expect(spawned).toHaveLength(3);
    expect(spawned.map((entry) => entry.command)).not.toContain("pnpm");
  });

  it("cleans the API when status collection fails before dependent apps start", async () => {
    const root = tempDir();
    const killed: number[] = [];
    let nextPid = 20;

    await expect(
      startKoedServer({
        environment: {
          KOED_HOME: root,
          KOED_REPO_ROOT: root,
          KOED_RUNTIME_MODE: "developer",
          MEMORY_API_TOKEN: "watcher-token",
          DATABASE_URL: "postgres://operator/db",
          REDIS_URL: "redis://operator:6379",
          EMBEDDING_SERVICE_URL: "http://operator:8000"
        },
        timeoutMs: 1,
        pollIntervalMs: 1,
        spawnSync: () => spawnResult(),
        spawn: () => {
          const value = new EventEmitter() as EventEmitter & {
            pid: number;
            exitCode: number | null;
            signalCode: NodeJS.Signals | null;
            kill: (signal?: NodeJS.Signals) => boolean;
          };
          value.pid = nextPid++;
          value.exitCode = null;
          value.signalCode = null;
          value.kill = (signal = "SIGTERM") => {
            killed.push(value.pid);
            value.signalCode = signal;
            setImmediate(() => value.emit("exit", null, signal));
            return true;
          };
          return value as never;
        },
        collectStatus: async () => {
          throw new Error("status failed");
        }
      })
    ).rejects.toThrow("status failed");

    expect(killed).toEqual([20]);
    expect(() =>
      readFileSync(resolve(root, "run/koed-server.json"), "utf8")
    ).toThrow();
  });

  it("starts the Local AI Runtime after readiness with the final API Token", async () => {
    const root = tempDir();
    const controller = new AbortController();
    const spawned: Array<{
      args: string[];
      env?: NodeJS.ProcessEnv;
    }> = [];

    const running = startKoedServer({
      signal: controller.signal,
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        KOED_RUNTIME_MODE: "developer",
        MEMORY_API_TOKEN: "watcher-token",
        DATABASE_URL: "postgres://operator/db",
        REDIS_URL: "redis://operator:6379",
        EMBEDDING_SERVICE_URL: "http://operator:8000"
      },
      timeoutMs: 1,
      pollIntervalMs: 1,
      spawnSync: () => spawnResult(),
      spawn: (_command, args, options) => {
        spawned.push({ args, env: options?.env });
        return child(spawned.length);
      },
      collectStatus: async () => healthyStatus(root)
    });
    while (
      !spawned.some((entry) =>
        entry.args.some((arg) => arg.endsWith("local-runtime-cli.js"))
      )
    ) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 1));
    }

    try {
      const localAiRuntime = spawned.find((entry) =>
        entry.args.some((arg) => arg.endsWith("local-runtime-cli.js"))
      );
      expect(localAiRuntime?.args).toEqual([
        resolve(root, "packages/mcp-server/dist/local-runtime-cli.js")
      ]);
      expect(localAiRuntime?.env?.MEMORY_API_TOKEN).toBe("watcher-token");
      expect(localAiRuntime?.env?.KOED_HOME).toBe(root);
      const runtime = JSON.parse(
        readFileSync(resolve(root, "run/koed-server.json"), "utf8")
      ) as { services: string[]; processes: Record<string, number> };
      expect(runtime.services).toContain("local-ai-runtime");
      expect(runtime.processes.localAiRuntime).toBeGreaterThan(0);
    } finally {
      controller.abort();
      await running;
    }
  });

  it("starts app services without managing external dependencies", async () => {
    const root = tempDir();
    const commands: Array<{ command: string; args: string[] }> = [];
    const spawned: Array<{ command: string; args: string[] }> = [];

    await startKoedServer({
      signal: cleanShutdownSignal(),
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        DATABASE_URL: "postgres://operator/db",
        REDIS_URL: "redis://operator:6379",
        EMBEDDING_SERVICE_URL: "http://operator:8000",
        MEMORY_API_TOKEN: "test-runtime-token"
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
      "--filter @koed/api --filter @koed/worker --filter @koed/embedding-service --filter @koed/mcp-server build"
    ]);
    expect(commands.some((command) => command.command === "docker")).toBe(
      false
    );
    expect(spawned.map((entry) => entry.args.join(" "))).toEqual([
      resolve(root, "apps/api/dist/index.js"),
      resolve(root, "packages/mcp-server/dist/local-runtime-cli.js"),
      resolve(root, "apps/worker/dist/index.js")
    ]);
  });

  it("does not start the Local AI Runtime for an external server", async () => {
    const root = tempDir();
    const controller = new AbortController();
    const spawned: Array<{ command: string; args: string[] }> = [];

    const running = startKoedServer({
      signal: controller.signal,
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        KOED_RUNTIME_MODE: "external",
        DATABASE_URL: "postgres://operator/db",
        REDIS_URL: "redis://operator:6379",
        EMBEDDING_SERVICE_URL: "http://operator:8000"
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
    while (spawned.length < 2) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 1));
    }

    try {
      expect(
        spawned.some((entry) =>
          entry.args.some((arg) => arg.endsWith("local-runtime-cli.js"))
        )
      ).toBe(false);
      const runtime = JSON.parse(
        readFileSync(resolve(root, "run/koed-server.json"), "utf8")
      ) as { services: string[]; processes: Record<string, number> };
      expect(runtime.services).not.toContain("local-ai-runtime");
      expect(runtime.processes).not.toHaveProperty("localAiRuntime");
    } finally {
      controller.abort();
      await running;
    }
  });
});
