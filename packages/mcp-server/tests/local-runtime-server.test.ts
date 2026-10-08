import { createServer } from "node:net";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalAiRuntimeClient } from "../src/local-runtime-client.js";
import {
  localRuntimeRegistrationPath,
  readLocalRuntimeRegistration,
  resolveKoedHome
} from "../src/local-runtime-protocol.js";
import {
  startDefaultLocalAiRuntimeServices,
  startLocalAiRuntime,
  type LocalAiRuntimeServiceDependencies,
  type LocalAiRuntimeServiceFactory,
  type LocalAiRuntimeToolExecutor
} from "../src/local-runtime-server.js";
import { MemoryApiClient, MemoryApiError } from "../src/index.js";

const roots: string[] = [];
const tempHome = (): string => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-local-ai-runtime-"));
  roots.push(root);
  return root;
};

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const fixture = (
  executor: LocalAiRuntimeToolExecutor,
  close = vi.fn(async () => undefined)
): { serviceFactory: LocalAiRuntimeServiceFactory; close: typeof close } => ({
  serviceFactory: async () => ({ executor, close }),
  close
});

const defaultExecutor = (): LocalAiRuntimeToolExecutor => ({
  capabilities: async () => ({ curatedMemoryIntakeAvailable: true }),
  execute: async (name, input, caller) => ({ name, input, caller }),
  executeDesktopAsk: async (input, caller) => ({ input, caller })
});

describe("Local AI Runtime", () => {
  it.each([
    ["local", "Local Koed API request limit reached. Retry later."],
    ["remote", "Remote Team Backend request limit reached. Retry later."]
  ] as const)(
    "transports %s API throttle diagnostics without upstream error text",
    async (rateLimitSource, message) => {
      const environment = { KOED_HOME: tempHome() };
      const runtime = await startLocalAiRuntime({
        environment,
        serviceFactory: fixture({
          ...defaultExecutor(),
          execute: async () => {
            throw new MemoryApiError("PRIVATE_PROVIDER_MESSAGE", {
              status: 429,
              retryAfterMs: 7000,
              rateLimitSource
            });
          }
        }).serviceFactory
      });
      try {
        await expect(
          new LocalAiRuntimeClient(environment).callTool(
            "memory_answer",
            { query: "dinner" },
            { cwd: "/fixture" }
          )
        ).rejects.toMatchObject({
          statusCode: 429,
          retryAfterMs: 7000,
          rateLimitSource,
          message
        });
      } finally {
        await runtime.close();
      }
    }
  );
  it.each([
    2000,
    0,
    -1,
    0.5,
    300_001,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "2000"
  ])(
    "transports only bounded numeric 429 retry metadata: %s",
    async (retryAfterMs) => {
      const environment = { KOED_HOME: tempHome() };
      const runtime = await startLocalAiRuntime({
        environment,
        serviceFactory: fixture({
          ...defaultExecutor(),
          execute: async () => {
            throw new MemoryApiError("PRIVATE_PROVIDER_MESSAGE", {
              status: 429,
              retryAfterMs: retryAfterMs as number
            });
          }
        }).serviceFactory
      });
      try {
        const client = new LocalAiRuntimeClient(environment);
        await expect(
          client.callTool(
            "memory_answer",
            { query: "decision" },
            { cwd: "/fixture" }
          )
        ).rejects.toMatchObject({
          statusCode: 429,
          message: "Koed memory API is busy. Retry later.",
          retryAfterMs: retryAfterMs === 2000 ? 2000 : undefined
        });
      } finally {
        await runtime.close();
      }
    }
  );

  it("reports the runtime's own full queue separately from an upstream rate limit", async () => {
    const environment = { KOED_HOME: tempHome() };
    const runtime = await startLocalAiRuntime({
      environment,
      serviceFactory: fixture({
        ...defaultExecutor(),
        execute: async () => {
          throw Object.assign(new Error("PRIVATE"), {
            statusCode: 429,
            retryAfterMs: 2000
          });
        }
      }).serviceFactory
    });
    try {
      await expect(
        new LocalAiRuntimeClient(environment).callTool(
          "memory_answer",
          { query: "decision" },
          { cwd: "/fixture" }
        )
      ).rejects.toMatchObject({
        statusCode: 429,
        message: "Koed Memory Answer queue is full",
        retryAfterMs: 2000
      });
    } finally {
      await runtime.close();
    }
  });

  it.each([
    [401, 502, "Koed memory API rejected the configured API Token."],
    [403, 502, "Koed memory API denied this memory operation."],
    [404, 502, "Koed memory API request failed."],
    [410, 502, "Koed memory API request failed."],
    [500, 502, "Koed memory API request failed."],
    [
      undefined,
      503,
      "Koed memory API is unavailable or did not respond. Check that Koed is running."
    ]
  ])(
    "reports upstream API status %s on tool and Desktop routes as HTTP %s",
    async (upstream, statusCode, message) => {
      const environment = { KOED_HOME: tempHome() };
      const fail = async (): Promise<never> => {
        throw new MemoryApiError("PRIVATE_UPSTREAM_DETAIL", {
          status: upstream
        });
      };
      const runtime = await startLocalAiRuntime({
        environment,
        serviceFactory: fixture({
          ...defaultExecutor(),
          execute: fail,
          executeDesktopAsk: fail
        }).serviceFactory
      });
      try {
        const client = new LocalAiRuntimeClient(environment);
        await expect(
          client.callTool(
            "memory_search",
            { query: "decision" },
            { cwd: "/fixture" }
          )
        ).rejects.toMatchObject({ statusCode, message });
        const registration = readLocalRuntimeRegistration(environment);
        const desktop = await fetch(`${runtime.url}/v1/desktop/ask`, {
          method: "POST",
          headers: {
            authorization: registration.authorization,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            input: { idempotencyKey: "ask-1", query: "decision" },
            caller: { cwd: "/fixture" }
          })
        });
        expect(desktop.status).toBe(statusCode);
        const body = JSON.stringify(await desktop.json());
        expect(body).toContain(message);
        expect(body).not.toContain("PRIVATE");
      } finally {
        await runtime.close();
      }
    }
  );

  it.each([
    [
      "failed",
      "hard_timeout",
      500,
      "Memory Answer exceeded its time limit. Try a narrower question."
    ],
    ["failed", "toString", 500, "Memory Answer failed. Try again."],
    ["cancelled", "cancelled", 409, "Memory Answer was cancelled."]
  ])(
    "returns static blocking recall text for a %s task (%s)",
    async (status, lastErrorCode, statusCode, message) => {
      const environment = { KOED_HOME: tempHome() };
      const task = (overrides: Record<string, unknown>) => ({
        id: "7c07a3cc-5679-4df2-bb67-c86571df93c2",
        invocationKey: "invocation-1",
        status: "accepted",
        version: 1,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        lastErrorCode: null,
        lastErrorMessage: null,
        result: null,
        ...overrides
      });
      const runtime = await startLocalAiRuntime({
        environment,
        serviceFactory: async ({ apiClient }) => {
          apiClient.acceptMemoryAnswerTask = vi.fn(async () => ({
            task: task({})
          })) as unknown as typeof apiClient.acceptMemoryAnswerTask;
          apiClient.getMemoryAnswerTask = vi.fn(async () => ({
            task: task({
              status,
              version: 3,
              lastErrorCode,
              lastErrorMessage: "PRIVATE_PROVIDER_FAILURE"
            })
          })) as unknown as typeof apiClient.getMemoryAnswerTask;
          apiClient.claimMemoryAnswerTask = vi.fn(async () => ({
            task: null,
            reconciled: []
          }));
          apiClient.deleteExpiredMemoryAnswerTasks = vi.fn(async () => ({
            deleted: 0
          }));
          return {
            executor: {
              ...defaultExecutor(),
              durableMemoryAnswerEligible: () => true,
              executeMemoryAnswerTask: vi.fn()
            },
            close: vi.fn(async () => undefined)
          };
        }
      });
      try {
        await expect(
          new LocalAiRuntimeClient(environment).callTool(
            "memory_answer",
            { query: "decision" },
            { cwd: "/fixture" },
            undefined,
            "invocation-1"
          )
        ).rejects.toMatchObject({ statusCode, message });
      } finally {
        await runtime.close();
      }
    }
  );

  it.each([401, 403, 404, 410])(
    "preserves task denial HTTP %s before stream headers and remains alive",
    async (status) => {
      const environment = { KOED_HOME: tempHome() };
      const runtime = await startLocalAiRuntime({
        environment,
        serviceFactory: async ({ apiClient }) => {
          apiClient.getMemoryAnswerTask = vi.fn(async () => {
            throw new MemoryApiError("MEMORY_CREDENTIAL_SECRET", { status });
          });
          apiClient.claimMemoryAnswerTask = vi.fn(async () => ({
            task: null,
            reconciled: []
          }));
          apiClient.deleteExpiredMemoryAnswerTasks = vi.fn(async () => ({
            deleted: 0
          }));
          return {
            executor: {
              ...defaultExecutor(),
              executeMemoryAnswerTask: vi.fn()
            },
            close: vi.fn(async () => undefined)
          };
        }
      });
      try {
        const registration = readLocalRuntimeRegistration(environment);
        const taskId = "7c07a3cc-5679-4df2-bb67-c86571df93c2";
        const denied = await fetch(`${runtime.url}/v1/tasks/${taskId}/events`, {
          headers: { authorization: registration.authorization }
        });
        expect(denied.status).toBe(status);
        expect(denied.headers.get("content-type")).toContain(
          "application/json"
        );
        expect(JSON.stringify(await denied.json())).not.toContain(
          "MEMORY_CREDENTIAL_SECRET"
        );
        await expect(
          new LocalAiRuntimeClient(environment).getMemoryAnswerTask(taskId)
        ).rejects.toMatchObject({ statusCode: status });
        const ready = await fetch(`${runtime.url}/ready`, {
          headers: { authorization: registration.authorization }
        });
        expect(ready.status).toBe(200);
      } finally {
        await runtime.close();
      }
    }
  );

  it("recovers durable Desktop Ask turns before starting runtime services", async () => {
    const callOrder: string[] = [];
    const recoverPendingDesktopAsks = vi.fn(async () => {
      callOrder.push("recover");
      return { recovered: 1 };
    });
    const dependencies = {
      recoverPendingDesktopAsks,
      startLcmSummaryService: vi.fn(() => {
        callOrder.push("services");
        return null;
      }),
      watchKoedLocalWork: vi.fn(),
      startCuratedMemoryReviewService: vi.fn(() => ({ stop: vi.fn() })),
      startCodexTranscriptWatcher: vi.fn(() => ({ stop: vi.fn() })),
      startClaudeTranscriptWatcher: vi.fn(() => ({ stop: vi.fn() })),
      createExecutor: vi.fn(() => defaultExecutor())
    } as unknown as LocalAiRuntimeServiceDependencies;
    const apiClient = new MemoryApiClient({
      apiUrl: "http://127.0.0.1:3300",
      apiToken: "test-token"
    });

    const services = await startDefaultLocalAiRuntimeServices(
      { apiClient, environment: {}, koedHome: tempHome() },
      dependencies
    );

    expect(recoverPendingDesktopAsks).toHaveBeenCalledWith(apiClient);
    expect(callOrder).toEqual(["recover", "services"]);
    await services.close();
  });

  it("owns and stops both transcript watchers", async () => {
    const lcmStop = vi.fn();
    const lcmWorkStop = vi.fn();
    const curatedStop = vi.fn();
    const codexStop = vi.fn(async () => undefined);
    const claudeStop = vi.fn(async () => undefined);
    const dependencies = {
      startLcmSummaryService: vi.fn(() => ({
        stop: lcmStop,
        nudge: vi.fn()
      })),
      watchKoedLocalWork: vi.fn(async () => ({ stop: lcmWorkStop })),
      startCuratedMemoryReviewService: vi.fn(() => ({ stop: curatedStop })),
      startCodexTranscriptWatcher: vi.fn(() => ({ stop: codexStop })),
      startClaudeTranscriptWatcher: vi.fn(() => ({ stop: claudeStop })),
      createExecutor: vi.fn(() => defaultExecutor())
    } as unknown as LocalAiRuntimeServiceDependencies;
    const apiClient = new MemoryApiClient({
      apiUrl: "http://127.0.0.1:3300",
      apiToken: "test-token"
    });

    const services = await startDefaultLocalAiRuntimeServices(
      { apiClient, environment: {}, koedHome: tempHome() },
      dependencies
    );

    expect(dependencies.startCodexTranscriptWatcher).toHaveBeenCalledTimes(1);
    const backgroundClient = vi.mocked(dependencies.startCodexTranscriptWatcher)
      .mock.calls[0]?.[0];
    expect(backgroundClient).not.toBe(apiClient);
    expect((backgroundClient as MemoryApiClient).config.requestClass).toBe(
      "background"
    );
    expect(dependencies.startClaudeTranscriptWatcher).toHaveBeenCalledWith(
      backgroundClient,
      {}
    );
    expect(dependencies.startLcmSummaryService).toHaveBeenCalledWith(
      backgroundClient,
      expect.any(Object)
    );
    expect(dependencies.startCuratedMemoryReviewService).toHaveBeenCalledWith(
      backgroundClient,
      expect.any(Object)
    );
    expect(dependencies.createExecutor).toHaveBeenCalledWith(
      apiClient,
      {},
      expect.any(Object)
    );
    await services.close();
    expect(codexStop).toHaveBeenCalledTimes(1);
    expect(claudeStop).toHaveBeenCalledTimes(1);
    expect(lcmWorkStop).toHaveBeenCalledTimes(1);
    expect(lcmStop).toHaveBeenCalledTimes(1);
    expect(curatedStop).toHaveBeenCalledTimes(1);
  });

  it("starts independent automatic-history adapters for Claude Code and Pi", async () => {
    const historicalAdapter = (aiClient: string) => ({
      aiClient,
      discoverCandidates: async () => [],
      candidateId: (candidate: { id: string }) => candidate.id,
      selectCandidates: () => [],
      processNextBatch: vi.fn()
    });
    const createClaudeHistoricalProviderAdapter = vi.fn(() =>
      historicalAdapter("claude")
    );
    const createPiHistoricalProviderAdapter = vi.fn(() =>
      historicalAdapter("pi")
    );
    const dependencies = {
      startLcmSummaryService: vi.fn(() => null),
      watchKoedLocalWork: vi.fn(),
      startCuratedMemoryReviewService: vi.fn(() => ({ stop: vi.fn() })),
      startCodexTranscriptWatcher: vi.fn(() => ({ stop: vi.fn() })),
      startClaudeTranscriptWatcher: vi.fn(() => ({ stop: vi.fn() })),
      startPiTranscriptWatcher: vi.fn(() => ({ stop: vi.fn() })),
      createClaudeHistoricalProviderAdapter,
      createPiHistoricalProviderAdapter,
      createExecutor: vi.fn(() => defaultExecutor())
    } as unknown as LocalAiRuntimeServiceDependencies;
    const apiClient = new MemoryApiClient({
      apiUrl: "http://127.0.0.1:3300",
      apiToken: "test-token"
    });
    const environment = { KOED_HOME: tempHome() };

    const services = await startDefaultLocalAiRuntimeServices(
      { apiClient, environment, koedHome: environment.KOED_HOME },
      dependencies
    );

    const backgroundClient = vi.mocked(dependencies.startCodexTranscriptWatcher)
      .mock.calls[0]?.[0];
    expect(createClaudeHistoricalProviderAdapter).toHaveBeenCalledWith({
      client: backgroundClient,
      env: environment
    });
    expect(createPiHistoricalProviderAdapter).toHaveBeenCalledWith({
      client: backgroundClient,
      env: environment
    });
    await services.close();
  });

  it("publishes capabilities during runtime startup and stops publisher on close", async () => {
    const refresh = vi.fn(async () => []);
    const stop = vi.fn();
    const dependencies = {
      startLcmSummaryService: vi.fn(() => null),
      watchKoedLocalWork: vi.fn(),
      startCuratedMemoryReviewService: vi.fn(() => ({ stop: vi.fn() })),
      startCodexTranscriptWatcher: vi.fn(() => ({ stop: vi.fn() })),
      startClaudeTranscriptWatcher: vi.fn(() => ({ stop: vi.fn() })),
      startAiClientCapabilityPublisher: vi.fn(() => ({ refresh, stop })),
      createExecutor: vi.fn(() => defaultExecutor())
    } as unknown as LocalAiRuntimeServiceDependencies;
    const apiClient = new MemoryApiClient({
      apiUrl: "http://127.0.0.1:3300",
      apiToken: "test-token"
    });
    const environment = { KOED_HOME: tempHome() };

    const services = await startDefaultLocalAiRuntimeServices(
      { apiClient, environment, koedHome: environment.KOED_HOME },
      dependencies
    );

    expect(dependencies.startAiClientCapabilityPublisher).toHaveBeenCalledWith(
      apiClient,
      environment
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    await services.close();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("does not await a hanging capability refresh during startup", async () => {
    let resolveRefresh!: () => void;
    const refresh = vi.fn(
      () =>
        new Promise<[]>((resolve) => {
          resolveRefresh = () => resolve([]);
        })
    );
    const stop = vi.fn();
    const dependencies = {
      startLcmSummaryService: vi.fn(() => null),
      watchKoedLocalWork: vi.fn(),
      startCuratedMemoryReviewService: vi.fn(() => ({ stop: vi.fn() })),
      startCodexTranscriptWatcher: vi.fn(() => ({ stop: vi.fn() })),
      startClaudeTranscriptWatcher: vi.fn(() => ({ stop: vi.fn() })),
      startAiClientCapabilityPublisher: vi.fn(() => ({ refresh, stop })),
      createExecutor: vi.fn(() => defaultExecutor())
    } as unknown as LocalAiRuntimeServiceDependencies;
    const services = await startDefaultLocalAiRuntimeServices(
      {
        apiClient: new MemoryApiClient({ apiUrl: "http://127.0.0.1:3300" }),
        environment: {},
        koedHome: tempHome()
      },
      dependencies
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    await services.close();
    expect(stop).toHaveBeenCalledTimes(1);
    resolveRefresh();
  });

  it("does not start disabled transcript watchers", async () => {
    const dependencies = {
      startLcmSummaryService: vi.fn(() => null),
      watchKoedLocalWork: vi.fn(),
      startCuratedMemoryReviewService: vi.fn(() => ({ stop: vi.fn() })),
      startCodexTranscriptWatcher: vi.fn(),
      startClaudeTranscriptWatcher: vi.fn(),
      createExecutor: vi.fn(() => defaultExecutor())
    } as unknown as LocalAiRuntimeServiceDependencies;
    const services = await startDefaultLocalAiRuntimeServices(
      {
        apiClient: new MemoryApiClient({ apiUrl: "http://127.0.0.1:3300" }),
        environment: {
          MEMORY_CODEX_TRANSCRIPT_WATCHER_ENABLED: "false",
          MEMORY_CLAUDE_TRANSCRIPT_WATCHER_ENABLED: "false"
        },
        koedHome: tempHome()
      },
      dependencies
    );

    expect(dependencies.startCodexTranscriptWatcher).not.toHaveBeenCalled();
    expect(dependencies.startClaudeTranscriptWatcher).not.toHaveBeenCalled();
    await services.close();
  });

  it("expands a home-relative KOED_HOME from Codex TOML", () => {
    expect(resolveKoedHome({ KOED_HOME: "~" })).toBe(homedir());
    expect(resolveKoedHome({ KOED_HOME: "~/.koed-test" })).toBe(
      join(homedir(), ".koed-test")
    );
  });

  it("leaves tool duration to the runtime worker and caller cancellation", async () => {
    vi.useFakeTimers();
    const koedHome = tempHome();
    const registrationPath = localRuntimeRegistrationPath(koedHome);
    mkdirSync(resolve(koedHome, "run"), { recursive: true, mode: 0o700 });
    writeFileSync(
      registrationPath,
      JSON.stringify({
        protocolVersion: 1,
        url: "http://127.0.0.1:32123",
        authorization: `Bearer ${"a".repeat(32)}`,
        pid: process.pid,
        startedAt: new Date().toISOString()
      }),
      { mode: 0o600 }
    );
    let requestSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        await new Promise<Response>((_resolveResponse, rejectResponse) => {
          requestSignal = init?.signal ?? undefined;
          requestSignal?.addEventListener(
            "abort",
            () => rejectResponse(requestSignal?.reason),
            { once: true }
          );
        })
    );
    const caller = new AbortController();
    const pending = new LocalAiRuntimeClient(
      { KOED_HOME: koedHome },
      fetchImpl as typeof fetch
    ).callTool(
      "memory_answer",
      { query: "long answer" },
      { cwd: "/work" },
      caller.signal
    );

    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
    expect(requestSignal?.aborted).toBe(false);
    caller.abort();
    await expect(pending).rejects.toThrow("cancelled");
  });

  it("propagates a caller signal that was aborted before dispatch", async () => {
    const koedHome = tempHome();
    const registrationPath = localRuntimeRegistrationPath(koedHome);
    mkdirSync(resolve(koedHome, "run"), { recursive: true, mode: 0o700 });
    writeFileSync(
      registrationPath,
      JSON.stringify({
        protocolVersion: 1,
        url: "http://127.0.0.1:32123",
        authorization: `Bearer ${"a".repeat(32)}`,
        pid: process.pid,
        startedAt: new Date().toISOString()
      }),
      { mode: 0o600 }
    );
    const caller = new AbortController();
    caller.abort(new Error("caller stopped"));
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        expect(init?.signal?.aborted).toBe(true);
        throw init?.signal?.reason;
      }
    );

    await expect(
      new LocalAiRuntimeClient(
        { KOED_HOME: koedHome },
        fetchImpl as typeof fetch
      ).callTool(
        "memory_answer",
        { query: "cancelled answer" },
        { cwd: "/work" },
        caller.signal
      )
    ).rejects.toThrow("cancelled");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("publishes an owner-only registration and authenticates adapter calls", async () => {
    const koedHome = tempHome();
    const environment = { KOED_HOME: koedHome };
    const execute = vi.fn(defaultExecutor().execute);
    const executeDesktopAsk = vi.fn(defaultExecutor().executeDesktopAsk);
    const services = fixture({
      capabilities: defaultExecutor().capabilities,
      execute,
      executeDesktopAsk
    });
    const runtime = await startLocalAiRuntime({
      environment,
      serviceFactory: services.serviceFactory
    });

    try {
      const registrationPath = localRuntimeRegistrationPath(koedHome);
      expect(statSync(registrationPath).mode & 0o777).toBe(0o600);
      const registration = readLocalRuntimeRegistration(environment);
      expect(registration.url).toBe(runtime.url);
      expect(registration.authorization).toMatch(/^Bearer /);

      const unauthorized = await fetch(`${runtime.url}/ready`);
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get("cache-control")).toBe("no-store");

      const client = new LocalAiRuntimeClient(environment);
      await expect(client.capabilities()).resolves.toMatchObject({
        curatedMemoryIntakeAvailable: true,
        protocolVersion: 1,
        supportedTools: expect.arrayContaining([
          "memory_answer",
          "memory_workspaces"
        ]) as unknown,
        memoryAnswerTeamBackendAvailable: true
      });
      await expect(
        client.callTool(
          "memory_answer",
          { query: "Where is the launch plan?" },
          { cwd: "/work/project", protocolVersion: "2026-07-28" }
        )
      ).resolves.toMatchObject({
        name: "memory_answer",
        input: { query: "Where is the launch plan?" },
        caller: { cwd: "/work/project", protocolVersion: "2026-07-28" }
      });
      expect(execute).toHaveBeenCalledTimes(1);
      await expect(
        client.askDesktop(
          {
            idempotencyKey: "desktop-ask-request-1",
            query: "What did I decide?"
          },
          { cwd: "/work/project" }
        )
      ).resolves.toMatchObject({
        input: {
          idempotencyKey: "desktop-ask-request-1",
          query: "What did I decide?"
        },
        caller: { cwd: "/work/project" }
      });
      expect(executeDesktopAsk).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.close();
    }

    expect(services.close).toHaveBeenCalledTimes(1);
    expect(() =>
      readFileSync(localRuntimeRegistrationPath(koedHome))
    ).toThrow();
  });

  it("refreshes capabilities through authenticated bounded runtime client", async () => {
    const koedHome = tempHome();
    const refresh = vi.fn(async () => [
      {
        instanceId: "codex.default",
        driverId: "codex",
        published: true,
        error: null
      }
    ]);
    const runtime = await startLocalAiRuntime({
      environment: { KOED_HOME: koedHome },
      serviceFactory: async () => ({
        executor: defaultExecutor(),
        capabilityPublisher: { refresh, stop: vi.fn() },
        close: vi.fn(async () => undefined)
      })
    });
    try {
      await expect(
        new LocalAiRuntimeClient({ KOED_HOME: koedHome }).refreshCapabilities()
      ).resolves.toMatchObject({ protocolVersion: 1 });
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.close();
    }
  });

  it("reports capability publication failures as unavailable", async () => {
    const koedHome = tempHome();
    const runtime = await startLocalAiRuntime({
      environment: { KOED_HOME: koedHome },
      serviceFactory: async () => ({
        executor: defaultExecutor(),
        capabilityPublisher: {
          refresh: vi.fn(async () => [
            {
              instanceId: "codex.default",
              driverId: "codex",
              published: false,
              error: "Codex is not authenticated"
            }
          ]),
          stop: vi.fn()
        },
        close: vi.fn(async () => undefined)
      })
    });
    try {
      await expect(
        new LocalAiRuntimeClient({ KOED_HOME: koedHome }).refreshCapabilities()
      ).rejects.toThrow("Capability refresh failed for 1 AI Client instance");
    } finally {
      await runtime.close();
    }
  });

  it("rejects refresh when capability publisher is unavailable", async () => {
    const koedHome = tempHome();
    const runtime = await startLocalAiRuntime({
      environment: { KOED_HOME: koedHome },
      serviceFactory: async () => ({
        executor: defaultExecutor(),
        close: vi.fn(async () => undefined)
      })
    });
    try {
      await expect(
        new LocalAiRuntimeClient({ KOED_HOME: koedHome }).refreshCapabilities()
      ).rejects.toThrow("Local AI Client capability publisher is unavailable");
    } finally {
      await runtime.close();
    }
  });

  it("rejects malformed, oversized, and unknown requests without dispatch", async () => {
    const koedHome = tempHome();
    const environment = { KOED_HOME: koedHome };
    const execute = vi.fn(defaultExecutor().execute);
    const runtime = await startLocalAiRuntime({
      environment,
      serviceFactory: fixture({
        capabilities: defaultExecutor().capabilities,
        execute,
        executeDesktopAsk: defaultExecutor().executeDesktopAsk
      }).serviceFactory
    });
    const registration = readLocalRuntimeRegistration(environment);
    const headers = {
      authorization: registration.authorization,
      "content-type": "application/json"
    };

    try {
      const malformed = await fetch(`${runtime.url}/v1/tools/memory_answer`, {
        method: "POST",
        headers,
        body: JSON.stringify({ input: {}, caller: { cwd: "relative" } })
      });
      expect(malformed.status).toBe(400);

      const unknown = await fetch(`${runtime.url}/v1/tools/not-a-tool`, {
        method: "POST",
        headers,
        body: JSON.stringify({ input: {}, caller: { cwd: "/work" } })
      });
      expect(unknown.status).toBe(404);

      const oversized = await fetch(`${runtime.url}/v1/tools/memory_answer`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          input: { query: "x".repeat(257 * 1024) },
          caller: { cwd: "/work" }
        })
      });
      expect(oversized.status).toBe(413);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });

  it.runIf(process.platform !== "win32")(
    "refuses a registration credential exposed to other operating-system users",
    async () => {
      const koedHome = tempHome();
      const environment = { KOED_HOME: koedHome };
      const runtime = await startLocalAiRuntime({
        environment,
        serviceFactory: fixture(defaultExecutor()).serviceFactory
      });
      try {
        chmodSync(localRuntimeRegistrationPath(koedHome), 0o644);
        expect(() => readLocalRuntimeRegistration(environment)).toThrow(
          "registration is invalid"
        );
      } finally {
        await runtime.close();
      }
    }
  );

  it("bounds concurrent Memory Answers and removes cancelled queued work", async () => {
    const koedHome = tempHome();
    const environment = {
      KOED_HOME: koedHome,
      KOED_LOCAL_AI_RUNTIME_MAX_ACTIVE_ANSWERS: "1",
      KOED_LOCAL_AI_RUNTIME_MAX_QUEUED_ANSWERS: "1"
    };
    let releaseActive!: () => void;
    const active = new Promise<void>((resolveActive) => {
      releaseActive = resolveActive;
    });
    const execute = vi.fn(async () => {
      await active;
      return { ok: true };
    });
    const runtime = await startLocalAiRuntime({
      environment,
      serviceFactory: fixture({
        capabilities: defaultExecutor().capabilities,
        execute,
        executeDesktopAsk: defaultExecutor().executeDesktopAsk
      }).serviceFactory
    });
    const client = new LocalAiRuntimeClient(environment);
    const first = client.callTool(
      "memory_answer",
      { query: "first" },
      { cwd: "/work" }
    );
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    const queuedAbort = new AbortController();
    const queued = client.callTool(
      "memory_answer",
      { query: "queued" },
      { cwd: "/work" },
      queuedAbort.signal
    );
    await vi.waitFor(async () => {
      const registration = readLocalRuntimeRegistration(environment);
      const ready = await fetch(`${runtime.url}/ready`, {
        headers: { authorization: registration.authorization }
      });
      expect(await ready.json()).toMatchObject({
        memoryAnswers: { active: 1, queued: 1 }
      });
    });

    await expect(
      client.callTool("memory_answer", { query: "overflow" }, { cwd: "/work" })
    ).rejects.toThrow("queue is full");
    queuedAbort.abort();
    await expect(queued).rejects.toThrow("cancelled");
    await vi.waitFor(async () => {
      const registration = readLocalRuntimeRegistration(environment);
      const ready = await fetch(`${runtime.url}/ready`, {
        headers: { authorization: registration.authorization }
      });
      expect(await ready.json()).toMatchObject({
        memoryAnswers: { active: 1, queued: 0 }
      });
    });
    releaseActive();
    await expect(first).resolves.toEqual({ ok: true });
    expect(execute).toHaveBeenCalledTimes(1);
    await runtime.close();
  });

  it("serves multiple adapter clients from one durable runtime", async () => {
    const koedHome = tempHome();
    const environment = { KOED_HOME: koedHome };
    const execute = vi.fn(defaultExecutor().execute);
    const services = fixture({
      capabilities: defaultExecutor().capabilities,
      execute,
      executeDesktopAsk: defaultExecutor().executeDesktopAsk
    });
    const runtime = await startLocalAiRuntime({
      environment,
      serviceFactory: services.serviceFactory
    });
    const firstClient = new LocalAiRuntimeClient(environment);
    const secondClient = new LocalAiRuntimeClient(environment);

    try {
      await expect(
        Promise.all([
          firstClient.callTool(
            "memory_access_check",
            { include_notes: true },
            { cwd: "/work/first" }
          ),
          secondClient.callTool(
            "memory_search",
            { query: "shared runtime" },
            { cwd: "/work/second" }
          )
        ])
      ).resolves.toMatchObject([
        { name: "memory_access_check", caller: { cwd: "/work/first" } },
        { name: "memory_search", caller: { cwd: "/work/second" } }
      ]);
      expect(execute).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.close();
    }
    expect(services.close).toHaveBeenCalledTimes(1);
  });

  it("isolates registrations and credentials between KOED_HOME instances", async () => {
    const firstHome = tempHome();
    const secondHome = tempHome();
    const firstEnvironment = { KOED_HOME: firstHome };
    const secondEnvironment = { KOED_HOME: secondHome };
    const firstRuntime = await startLocalAiRuntime({
      environment: firstEnvironment,
      serviceFactory: fixture({
        capabilities: defaultExecutor().capabilities,
        execute: async () => ({ instance: "first" }),
        executeDesktopAsk: defaultExecutor().executeDesktopAsk
      }).serviceFactory
    });
    const secondRuntime = await startLocalAiRuntime({
      environment: secondEnvironment,
      serviceFactory: fixture({
        capabilities: defaultExecutor().capabilities,
        execute: async () => ({ instance: "second" }),
        executeDesktopAsk: defaultExecutor().executeDesktopAsk
      }).serviceFactory
    });

    try {
      const firstRegistration = readLocalRuntimeRegistration(firstEnvironment);
      const secondRegistration =
        readLocalRuntimeRegistration(secondEnvironment);
      expect(firstRegistration.url).not.toBe(secondRegistration.url);
      expect(firstRegistration.authorization).not.toBe(
        secondRegistration.authorization
      );
      await expect(
        new LocalAiRuntimeClient(firstEnvironment).callTool(
          "memory_access_check",
          {},
          { cwd: "/work" }
        )
      ).resolves.toEqual({ instance: "first" });
      const crossed = await fetch(`${secondRuntime.url}/ready`, {
        headers: { authorization: firstRegistration.authorization }
      });
      expect(crossed.status).toBe(401);
    } finally {
      await Promise.all([firstRuntime.close(), secondRuntime.close()]);
    }
  });

  it("cleans up services when the runtime cannot bind", async () => {
    const koedHome = tempHome();
    const occupied = createServer();
    await new Promise<void>((resolveListen) =>
      occupied.listen(0, "127.0.0.1", resolveListen)
    );
    const address = occupied.address();
    if (!address || typeof address === "string")
      throw new Error("missing port");
    const services = fixture(defaultExecutor());

    await expect(
      startLocalAiRuntime({
        environment: { KOED_HOME: koedHome },
        port: address.port,
        serviceFactory: services.serviceFactory
      })
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(services.close).toHaveBeenCalledTimes(1);
    await new Promise<void>((resolveClose) =>
      occupied.close(() => resolveClose())
    );
  });
});
