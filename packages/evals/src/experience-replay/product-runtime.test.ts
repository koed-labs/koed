import {
  Client,
  StreamableHTTPClientTransport
} from "@modelcontextprotocol/client";
import Fastify from "fastify";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  LocalAiRuntimeServiceFactory,
  LocalAiRuntimeToolExecutor
} from "@koed/mcp-server/runtime-contracts";
import { startLocalAiRuntime } from "@koed/mcp-server/runtime-contracts";
import type { TrialRedisHandle } from "./isolation.js";
import {
  startExperienceReplayProductRuntime,
  type ExperienceReplayProductRuntimeHandle,
  type ProductRuntimeDependencies
} from "./product-runtime.js";

const open: ExperienceReplayProductRuntimeHandle[] = [];

afterEach(async () => {
  await Promise.allSettled(open.splice(0).map((runtime) => runtime.close()));
});

const identity = {
  runId: "run-product",
  trialId: "trial-product",
  taskDigest: `sha256:${"a".repeat(64)}`,
  condition: "relevant" as const
};

const fakeRedis = (): TrialRedisHandle => ({
  url: "redis://default:secret@localhost/0?path=%2Ftmp%2Freplay.sock",
  pid: process.pid,
  processGroupId: process.pid,
  socketPath: "/tmp/replay.sock",
  password: "secret",
  close: vi.fn(async () => undefined)
});

const startApi = async (): Promise<{
  url: string;
  request(input: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: unknown;
  }): Promise<any>;
  close(): Promise<any>;
}> => {
  const app = Fastify({ logger: false });
  app.get("/ready", async () => ({ ok: true }));
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("no API port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    async request(input) {
      const response = (await app.inject({
        method: input.method,
        url: input.path,
        headers: input.headers,
        payload: input.body
      } as any)) as unknown as { body: string };
      return JSON.parse(response.body || "{}") as any;
    },
    async close() {
      await app.close();
      return {
        pid: process.pid,
        graceful: true,
        forced: false,
        exitCode: 0,
        signal: null
      };
    }
  };
};

const fixture = async () => {
  const calls: Array<{
    name: string;
    input: Record<string, unknown>;
    cwd: string;
  }> = [];
  const executor: LocalAiRuntimeToolExecutor = {
    capabilities: async () => ({ curatedMemoryIntakeAvailable: false }),
    execute: async (name, input, caller) => {
      calls.push({ name, input, cwd: caller.cwd });
      return { contract: "deterministic-app-server", name, input, caller };
    }
  };
  const serviceFactory: LocalAiRuntimeServiceFactory = async () => ({
    executor,
    close: async () => undefined
  });
  const redis = fakeRedis();
  const dependencies: Partial<ProductRuntimeDependencies> = {
    startRedis: async () => redis,
    startEmbeddingService: async () => ({
      environment: {
        EMBEDDING_SERVICE_URL: "http://127.0.0.1:43101",
        EMBEDDING_SERVICE_TOKEN: "deterministic-embedding-token"
      },
      close: async () => undefined
    }),
    startAppServer: async () => ({
      environment: { MEMORY_CODEX_APP_SERVER_BINARY: "/fixture/app-server" },
      close: async () => undefined
    }),
    startApi: async () => startApi(),
    startRuntime: (options) =>
      startLocalAiRuntime({ ...options, serviceFactory })
  };
  const trialWorkspaceRoot = path.join(process.cwd(), "packages", "evals");
  const projectCwd = path.join(trialWorkspaceRoot, "src");
  await mkdir(projectCwd, { recursive: true });
  const runtime = await startExperienceReplayProductRuntime({
    scopeId: "product-runtime-test",
    databaseUrl: "postgres://eval@127.0.0.1:5432/koed_eval_product",
    apiToken: "koed_fixture_token",
    projectCwd,
    trialWorkspaceRoot,
    identity,
    dependencies
  });
  open.push(runtime);
  return { runtime, calls, redis };
};

describe("Experience Replay product runtime", () => {
  it("isolates homes, disables transcript watching, and traverses runtime plus MCP contracts", async () => {
    const { runtime, calls } = await fixture();
    expect(runtime.koedHome).not.toBe(runtime.codexHome);
    expect(runtime.environment).toMatchObject({
      DATABASE_URL: "postgres://eval@127.0.0.1:5432/koed_eval_product",
      MEMORY_API_URL: runtime.api.url,
      MEMORY_API_TOKEN: "koed_fixture_token",
      MEMORY_CODEX_TRANSCRIPT_WATCHER_ENABLED: "false",
      EMBEDDING_SERVICE_URL: "http://127.0.0.1:43101",
      MEMORY_CODEX_APP_SERVER_BINARY: "/fixture/app-server"
    });
    await Promise.all([access(runtime.koedHome), access(runtime.codexHome)]);

    runtime.activateBridgeCredential();

    const client = new Client(
      { name: "product-runtime-test", version: "1.0.0" },
      { capabilities: {}, versionNegotiation: { mode: { pin: "2026-07-28" } } }
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(runtime.bridge.url),
      {
        authProvider: { token: async () => runtime.bridge.token }
      }
    );
    await client.connect(transport);
    try {
      await expect(
        client.callTool({
          name: "memory_answer",
          arguments: { query: "fixture recall" }
        })
      ).resolves.toMatchObject({
        structuredContent: {
          contract: "deterministic-app-server",
          name: "memory_answer",
          input: { query: "fixture recall" },
          caller: { cwd: path.join(process.cwd(), "packages", "evals", "src") }
        }
      });
    } finally {
      await client.close();
    }
    expect(calls).toHaveLength(1);
  });

  it("revokes the bridge credential before closing ordinary resources", async () => {
    const { runtime, redis } = await fixture();
    expect(runtime.bridge.attestation().activatedAt).toBeUndefined();
    const attestation = await runtime.close();
    open.splice(open.indexOf(runtime), 1);
    expect(attestation.cleanups[0]).toMatchObject({
      cleanupName: "product-runtime:trial-product:bridge-credential",
      priority: "credential-revocation",
      status: "completed"
    });
    expect(runtime.bridge.attestation().revokedAt).toEqual(expect.any(Number));
    expect(redis.close).toHaveBeenCalledOnce();
    await expect(access(runtime.root)).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("rejects unsafe databases before allocating dependencies", async () => {
    const startRedis = vi.fn(async () => fakeRedis());
    await expect(
      startExperienceReplayProductRuntime({
        scopeId: "unsafe",
        databaseUrl: "postgres://127.0.0.1/production",
        apiToken: "token",
        projectCwd: process.cwd(),
        trialWorkspaceRoot: path.dirname(process.cwd()),
        identity,
        dependencies: { startRedis }
      })
    ).rejects.toThrow("koed_eval_");
    expect(startRedis).not.toHaveBeenCalled();
  });
});
