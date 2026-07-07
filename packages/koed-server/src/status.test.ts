import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  type PathLike
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  aggregateState,
  collectKoedServerDoctor,
  collectKoedServerStatus,
  healthy,
  needsAttention,
  notConfigured,
  statusFromApiReady
} from "./status.js";
const temps: string[] = [];
const tempDir = () => {
  const path = mkdtempSync(resolve(tmpdir(), "koed-server-status-"));
  temps.push(path);
  return path;
};

const response = (ok: boolean, status: number, body: unknown): Response =>
  ({ ok, status, text: async () => JSON.stringify(body) }) as Response;

const spawnResult = (stdout: string, status = 0) =>
  ({ stdout, stderr: "", status, signal: null, pid: 1, output: [] }) as never;

afterEach(() => {
  for (const path of temps.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("status state aggregation", () => {
  it("prioritizes needs_attention, then not_configured, then starting", () => {
    expect(aggregateState([healthy(), notConfigured("missing")])).toBe(
      "not_configured"
    );
    expect(aggregateState([healthy(), { state: "starting" }])).toBe("starting");
    expect(
      aggregateState([{ state: "starting" }, notConfigured("missing")])
    ).toBe("not_configured");
    expect(
      aggregateState([{ state: "starting" }, needsAttention("broken")])
    ).toBe("needs_attention");
  });
});

describe("process status/probe mapping", () => {
  it("maps ready payload checks to healthy components", async () => {
    const result = await statusFromApiReady("http://localhost:3300", async () =>
      response(true, 200, {
        checks: [
          { service: "postgres", status: "ok" },
          { service: "postgres-version", status: "ok" },
          { service: "migrations", status: "ok" },
          { service: "pgvector", status: "ok" },
          { service: "redis", status: "ok" },
          { service: "work-queue", status: "ok" },
          { service: "embedding-service", status: "ok" },
          { service: "embedding-model", status: "ok" }
        ]
      })
    );

    expect(result.api.state).toBe("healthy");
    expect(result.database.state).toBe("healthy");
    expect(result.redis.state).toBe("healthy");
    expect(result.embeddingService.state).toBe("healthy");
    expect(result.workerQueues.state).toBe("healthy");
  });

  it("maps 503 readiness details to component actions", async () => {
    const result = await statusFromApiReady("http://localhost:3300", async () =>
      response(false, 503, {
        checks: [
          { service: "postgres", status: "ok" },
          { service: "postgres-version", status: "ok" },
          { service: "migrations", status: "error" },
          { service: "pgvector", status: "ok" },
          { service: "work-queue", status: "ok" },
          { service: "embedding-service", status: "ok" },
          { service: "embedding-model", status: "ok" }
        ]
      })
    );

    expect(result.api.state).toBe("starting");
    expect(result.database.state).toBe("needs_attention");
    expect(result.database.action).toContain("migrations");
  });

  it("maps unhealthy dependency checks to needs_attention", async () => {
    const result = await statusFromApiReady("http://localhost:3300", async () =>
      response(true, 200, {
        checks: [{ service: "postgres", status: "error" }]
      })
    );

    expect(result.database.state).toBe("needs_attention");
    expect(result.redis.state).toBe("starting");
  });
});

describe("status and doctor JSON contracts", () => {
  it("maps missing config to not_configured", async () => {
    const root = tempDir();
    const status = await collectKoedServerStatus(
      {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        HOME: root,
        REDIS_URL: "redis://operator:6379"
      },
      {
        fetch: async () => response(true, 200, { checks: [] }),
        spawnSync: () => spawnResult("", 0),
        now: () => new Date("2026-01-01T00:00:00.000Z")
      }
    );

    expect(status.koedHome).toBe(root);
    expect(status.runtimeMode).toBe("developer");
    expect(status.dependencyMode).toBe("external");
    expect(status.codex.configured).toBe(false);
    expect(status.captureHook.state).toBe("not_configured");
    expect(status.state).toBe("not_configured");
  });

  it("treats external local work queue as Redis-free", async () => {
    const root = tempDir();
    const status = await collectKoedServerStatus(
      {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        HOME: root,
        WORK_QUEUE_BACKEND: "local"
      },
      {
        fetch: async () => response(true, 200, { checks: [] }),
        spawnSync: () => spawnResult("", 0),
        now: () => new Date("2026-01-01T00:00:00.000Z")
      }
    );

    expect(status.redis.state).toBe("healthy");
    expect(status.redis.message).toBe(
      "Postgres-backed local queue does not require Redis."
    );
    expect(status.workerQueues.state).toBe("starting");
  });

  it("treats bundled-local mode from .env as Redis-free by default", async () => {
    const root = tempDir();
    writeFileSync(
      resolve(root, ".env"),
      "KOED_DEPENDENCY_MODE=bundled-local\nWORK_QUEUE_BACKEND=bullmq\n"
    );
    const status = await collectKoedServerStatus(
      {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        HOME: root
      },
      {
        fetch: async () =>
          response(true, 200, {
            checks: [
              { service: "postgres", status: "ok" },
              { service: "postgres-version", status: "ok" },
              { service: "migrations", status: "ok" },
              { service: "pgvector", status: "ok" },
              { service: "work-queue", status: "ok" },
              { service: "embedding-service", status: "ok" },
              { service: "embedding-model", status: "ok" }
            ]
          }),
        spawnSync: () => spawnResult("", 0),
        now: () => new Date("2026-01-01T00:00:00.000Z")
      }
    );

    expect(status.dependencyMode).toBe("bundled-local");
    expect(status.redis.state).toBe("healthy");
    expect(status.redis.message).toBe(
      "Postgres-backed local queue does not require Redis."
    );
    expect(status.workerQueues.state).toBe("starting");
  });

  it("uses native Postgres status before API readiness", async () => {
    const root = tempDir();
    const status = await collectKoedServerStatus(
      {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        HOME: root,
        KOED_DEPENDENCY_MODE: "bundled-local",
        KOED_BUNDLED_POSTGRES_MODE: "native",
        KOED_POSTGRES_BIN_DIR: resolve(root, "bin")
      },
      {
        existsSync: (filePath) =>
          String(filePath).includes("/bin/") ||
          String(filePath).endsWith("PG_VERSION"),
        fetch: async () => response(false, 503, {}),
        spawnSync: (command, args) =>
          command.endsWith("pg_ctl") && args.includes("status")
            ? spawnResult("", 0)
            : spawnResult("", 0),
        now: () => new Date("2026-01-01T00:00:00.000Z")
      }
    );

    expect(status.database.state).toBe("healthy");
    expect(status.database.message).toContain("native Postgres");
    expect(status.database.details?.dataDir).toBe(
      resolve(root, "data", "postgres")
    );
  });

  it("uses native Embedding Service status before API readiness", async () => {
    const root = tempDir();
    const status = await collectKoedServerStatus(
      {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        HOME: root,
        KOED_DEPENDENCY_MODE: "bundled-local",
        KOED_BUNDLED_EMBEDDING_MODE: "native"
      },
      {
        existsSync: (filePath) =>
          String(filePath).endsWith("dist/index.js") ||
          String(filePath).endsWith("llama-server"),
        fetch: async (url) =>
          String(url).endsWith(":3800/health")
            ? response(true, 200, { status: "ok" })
            : response(false, 503, {}),
        spawnSync: () => spawnResult("", 0),
        now: () => new Date("2026-01-01T00:00:00.000Z")
      }
    );

    expect(status.embeddingService.state).toBe("healthy");
    expect(status.embeddingService.message).toContain(
      "native Embedding Service"
    );
    expect(status.embeddingService.details?.healthUrl).toBe(
      "http://127.0.0.1:3800/health"
    );
  });

  it("honors bundled-local BullMQ override from environment", async () => {
    const root = tempDir();
    writeFileSync(
      resolve(root, ".env"),
      "KOED_DEPENDENCY_MODE=bundled-local\nREDIS_URL=redis://operator:6379\n"
    );
    const status = await collectKoedServerStatus(
      {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        HOME: root,
        WORK_QUEUE_BACKEND: "bullmq"
      },
      {
        fetch: async () =>
          response(true, 200, {
            checks: [
              { service: "postgres", status: "ok" },
              { service: "postgres-version", status: "ok" },
              { service: "migrations", status: "ok" },
              { service: "pgvector", status: "ok" },
              { service: "redis", status: "ok" },
              { service: "work-queue", status: "ok" },
              { service: "embedding-service", status: "ok" },
              { service: "embedding-model", status: "ok" }
            ]
          }),
        spawnSync: () => spawnResult("", 0),
        now: () => new Date("2026-01-01T00:00:00.000Z")
      }
    );

    expect(status.dependencyMode).toBe("bundled-local");
    expect(status.redis.state).toBe("healthy");
    expect(status.redis.message).not.toBe(
      "Postgres-backed local queue does not require Redis."
    );
  });

  it("preserves Redis errors in local queue mode when API reports Redis", async () => {
    const root = tempDir();
    const status = await collectKoedServerStatus(
      {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        HOME: root,
        WORK_QUEUE_BACKEND: "local"
      },
      {
        fetch: async () =>
          response(true, 200, {
            checks: [{ service: "redis", status: "error" }]
          }),
        spawnSync: () => spawnResult("", 0),
        now: () => new Date("2026-01-01T00:00:00.000Z")
      }
    );

    expect(status.redis.state).toBe("needs_attention");
    expect(status.workerQueues.state).toBe("starting");
  });

  it("includes packaged artifact source diagnostics in status and doctor", async () => {
    const root = tempDir();
    const environment = {
      KOED_HOME: root,
      KOED_PACKAGED_DESKTOP: "1",
      KOED_PACKAGED_RESOURCES_PATH: root,
      KOED_DEPENDENCY_MODE: "bundled-local",
      HOME: root,
      MEMORY_API_TOKEN: "token"
    };
    const dependencies = {
      existsSync: (filePath: PathLike) =>
        String(filePath).startsWith(resolve(root, "koed-runtime")) ||
        String(filePath).endsWith("PG_VERSION"),
      fetch: async (url: string | URL | Request) =>
        String(url).endsWith(":3800/health")
          ? response(true, 200, { status: "ok" })
          : response(false, 503, {}),
      spawnSync: () => spawnResult("", 0),
      now: () => new Date("2026-01-01T00:00:00.000Z")
    };

    const status = await collectKoedServerStatus(environment, dependencies);
    const doctor = await collectKoedServerDoctor(environment, dependencies);

    expect(status.database.details?.artifactSource).toBe("packaged-resource");
    expect(status.embeddingService.details?.artifactSource).toBe(
      "packaged-resource"
    );
    expect(status.mcpServer.details?.artifactSource).toBe("packaged-resource");
    expect(
      doctor.checks.find((check) => check.id === "database")?.details
        ?.artifactSource
    ).toBe("packaged-resource");
  });

  it("formats doctor result with actionable checks", async () => {
    const root = tempDir();
    const doctor = await collectKoedServerDoctor(
      { KOED_HOME: root, KOED_REPO_ROOT: root, HOME: root },
      {
        fetch: async () => response(false, 503, {}),
        spawnSync: () => spawnResult("", 0),
        now: () => new Date("2026-01-01T00:00:00.000Z")
      }
    );

    expect(doctor.ok).toBe(false);
    expect(doctor.state).toBe("needs_attention");
    expect(doctor.summary).toContain("Operator-managed Redis URL");
    expect(doctor.checks.map((check) => check.id)).toContain("mcpServer");
  });

  it("uses environment API Tokens for status and MCP doctor checks", async () => {
    const root = tempDir();
    mkdirSync(resolve(root, "packages/mcp-server/dist"), { recursive: true });
    writeFileSync(resolve(root, "packages/mcp-server/dist/cli.js"), "");
    const doctorEnvironments: Array<NodeJS.ProcessEnv | undefined> = [];

    const status = await collectKoedServerStatus(
      {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        HOME: root,
        MEMORY_API_TOKEN: "env_token"
      },
      {
        fetch: async () => response(false, 503, {}),
        spawnSync: (_command, args, options) => {
          if (args.includes("doctor")) {
            doctorEnvironments.push(options?.env);
            return spawnResult("", 0);
          }
          return spawnResult("", 0);
        },
        now: () => new Date("2026-01-01T00:00:00.000Z")
      }
    );

    expect(status.apiToken.state).toBe("healthy");
    expect(status.apiToken.configured).toBe(true);
    expect(status.mcpServer.state).toBe("healthy");
    expect(doctorEnvironments[0]?.MEMORY_API_TOKEN).toBe("env_token");
  });

  it("reports Codex and Capture Hook API URL mismatches", async () => {
    const root = tempDir();
    mkdirSync(resolve(root, ".codex"), { recursive: true });
    mkdirSync(resolve(root, "hook"), { recursive: true });
    mkdirSync(resolve(root, "packages/mcp-server/dist"), { recursive: true });
    writeFileSync(resolve(root, "packages/mcp-server/dist/cli.js"), "");
    writeFileSync(
      resolve(root, ".codex/config.toml"),
      '# >>> koed\n[mcp_servers.koed]\ncommand = "node"\n\n[mcp_servers.koed.env]\nMEMORY_API_URL = "http://localhost:3300"\nMEMORY_API_TOKEN = "token"\n# <<< koed\n'
    );
    writeFileSync(
      resolve(root, "hook/config.json"),
      JSON.stringify({ apiUrl: "http://localhost:3300", apiToken: "token" })
    );

    const status = await collectKoedServerStatus(
      {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        HOME: root,
        API_HOST_PORT: "43300",
        MEMORY_API_TOKEN: "token",
        MEMORY_HOOK_CONFIG: resolve(root, "hook/config.json"),
        WORK_QUEUE_BACKEND: "local"
      },
      {
        fetch: async () =>
          response(true, 200, {
            checks: [
              { service: "postgres", status: "ok" },
              { service: "postgres-version", status: "ok" },
              { service: "migrations", status: "ok" },
              { service: "pgvector", status: "ok" },
              { service: "work-queue", status: "ok" },
              { service: "embedding-service", status: "ok" },
              { service: "embedding-model", status: "ok" }
            ]
          }),
        spawnSync: () => spawnResult("", 0),
        now: () => new Date("2026-01-01T00:00:00.000Z")
      }
    );

    expect(status.codex.state).toBe("needs_attention");
    expect(status.codex.message).toContain("localhost:3300");
    expect(status.captureHook.state).toBe("needs_attention");
    expect(status.captureHook.message).toContain("localhost:3300");
  });

  it("verifies Explorer process and reachability", async () => {
    const root = tempDir();
    mkdirSync(resolve(root, "run"), { recursive: true });
    writeFileSync(
      resolve(root, "run/koed-server.json"),
      JSON.stringify({ pid: 10, processes: { explorer: 12, worker: 11 } })
    );

    const status = await collectKoedServerStatus(
      {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        HOME: root,
        WORK_QUEUE_BACKEND: "local"
      },
      {
        fetch: async (url) =>
          String(url).includes(":5174")
            ? response(true, 200, "")
            : response(true, 200, {
                checks: [
                  { service: "postgres", status: "ok" },
                  { service: "postgres-version", status: "ok" },
                  { service: "migrations", status: "ok" },
                  { service: "pgvector", status: "ok" },
                  { service: "work-queue", status: "ok" },
                  { service: "embedding-service", status: "ok" },
                  { service: "embedding-model", status: "ok" }
                ]
              }),
        spawnSync: () => spawnResult("", 0),
        checkPid: (pid) => pid === 10 || pid === 11 || pid === 12,
        now: () => new Date("2026-01-01T00:00:00.000Z")
      }
    );

    expect(status.explorer.state).toBe("healthy");
    expect(status.explorer.message).toContain("reachable");
    expect(status.explorer.details?.explorerPid).toBe(12);
  });

  it("marks Explorer unhealthy when the recorded process is stale", async () => {
    const root = tempDir();
    mkdirSync(resolve(root, "run"), { recursive: true });
    writeFileSync(
      resolve(root, "run/koed-server.json"),
      JSON.stringify({ pid: 10, processes: { explorer: 12, worker: 11 } })
    );

    const status = await collectKoedServerStatus(
      {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        HOME: root,
        WORK_QUEUE_BACKEND: "local"
      },
      {
        fetch: async () =>
          response(true, 200, {
            checks: [
              { service: "postgres", status: "ok" },
              { service: "postgres-version", status: "ok" },
              { service: "migrations", status: "ok" },
              { service: "pgvector", status: "ok" },
              { service: "work-queue", status: "ok" },
              { service: "embedding-service", status: "ok" },
              { service: "embedding-model", status: "ok" }
            ]
          }),
        spawnSync: () => spawnResult("", 0),
        checkPid: (pid) => pid === 10 || pid === 11,
        now: () => new Date("2026-01-01T00:00:00.000Z")
      }
    );

    expect(status.explorer.state).toBe("needs_attention");
    expect(status.explorer.message).toContain("not running");
  });

  it("maps fully prepared but stopped supervisor to starting", async () => {
    const root = tempDir();
    mkdirSync(resolve(root, ".codex"), { recursive: true });
    mkdirSync(resolve(root, "hook"), { recursive: true });
    mkdirSync(resolve(root, "packages/mcp-server/dist"), { recursive: true });
    writeFileSync(
      resolve(root, ".env"),
      "MEMORY_API_TOKEN=replace_with_token_from_pnpm_api_token_create\nVITE_KOED_API_TOKEN=token\n"
    );
    writeFileSync(
      resolve(root, ".codex/config.toml"),
      '# >>> koed\n[mcp_servers.koed]\ncommand = "node"\n\n[mcp_servers.koed.env]\nMEMORY_API_URL = "http://localhost:3300"\nMEMORY_API_TOKEN = "token"\n# <<< koed\n'
    );
    writeFileSync(
      resolve(root, "hook/config.json"),
      JSON.stringify({ apiUrl: "http://localhost:3300", apiToken: "token" })
    );
    writeFileSync(resolve(root, "packages/mcp-server/dist/cli.js"), "");
    mkdirSync(resolve(root, "run"), { recursive: true });
    writeFileSync(
      resolve(root, "run/last-verification.json"),
      JSON.stringify({ ok: true, checkedAt: "2026-01-01T00:00:00.000Z" })
    );
    writeFileSync(
      resolve(root, "run/koed-server.json"),
      JSON.stringify({ pid: 10, processes: { worker: 11 }, services: [] })
    );

    const status = await collectKoedServerStatus(
      {
        KOED_HOME: root,
        KOED_REPO_ROOT: root,
        HOME: root,
        MEMORY_HOOK_CONFIG: resolve(root, "hook/config.json"),
        REDIS_URL: "redis://operator:6379"
      },
      {
        fetch: async () =>
          response(true, 200, {
            checks: [
              { service: "postgres", status: "ok" },
              { service: "postgres-version", status: "ok" },
              { service: "migrations", status: "ok" },
              { service: "pgvector", status: "ok" },
              { service: "redis", status: "ok" },
              { service: "work-queue", status: "ok" },
              { service: "embedding-service", status: "ok" },
              { service: "embedding-model", status: "ok" }
            ]
          }),
        spawnSync: (_command, args) =>
          args.includes("doctor")
            ? spawnResult("", 0)
            : spawnResult(
                '{"Service":"redis","State":"running"}\n{"Service":"worker","State":"running"}\n',
                0
              ),
        checkPid: (pid) => pid === 11,
        now: () => new Date("2026-01-01T00:00:00.000Z")
      }
    );

    expect(status.runtimeMode).toBe("developer");
    expect(status.dependencyMode).toBe("external");
    expect(status.state).toBe("healthy");
    expect(status.explorer.state).toBe("starting");
  });
  it("prefers running runtime state over plain-shell dependency defaults", async () => {
    const root = tempDir();
    mkdirSync(resolve(root, "run"), { recursive: true });
    writeFileSync(
      resolve(root, ".env"),
      "KOED_DEPENDENCY_MODE=external\nWORK_QUEUE_BACKEND=bullmq\n"
    );
    writeFileSync(
      resolve(root, "run/koed-server.json"),
      JSON.stringify({
        pid: 42,
        startedAt: "2026-01-01T00:00:00.000Z",
        repoRoot: root,
        apiUrl: "http://localhost:43300",
        explorerUrl: "http://localhost:45774",
        runtimeMode: "local-personal",
        dependencyMode: "bundled-local",
        services: [
          "postgres-native",
          "embedding-service-native",
          "api",
          "worker",
          "explorer"
        ],
        processes: { api: 43, worker: 44, explorer: 45 }
      })
    );

    const fetchedUrls: string[] = [];
    const status = await collectKoedServerStatus(
      { KOED_HOME: root, KOED_REPO_ROOT: root, HOME: root },
      {
        fetch: async (url) => {
          fetchedUrls.push(String(url));
          return response(true, 200, {
            checks: [
              { service: "postgres", status: "ok" },
              { service: "postgres-version", status: "ok" },
              { service: "migrations", status: "ok" },
              { service: "pgvector", status: "ok" },
              { service: "work-queue", status: "ok" },
              { service: "embedding-service", status: "ok" },
              { service: "embedding-model", status: "ok" }
            ]
          });
        },
        spawnSync: () => spawnResult("", 0),
        checkPid: (pid) => [42, 44, 45].includes(pid),
        now: () => new Date("2026-01-01T00:00:00.000Z")
      }
    );

    expect(fetchedUrls).toContain("http://localhost:43300/ready");
    expect(status.runtimeMode).toBe("local-personal");
    expect(status.dependencyMode).toBe("bundled-local");
    expect(status.redis.message).toContain("local queue");
    expect(status.explorer.url).toBe("http://localhost:45774");
  });
});
