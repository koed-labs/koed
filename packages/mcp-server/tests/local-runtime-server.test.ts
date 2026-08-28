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
import { MemoryApiClient } from "../src/index.js";

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
    expect(dependencies.startClaudeTranscriptWatcher).toHaveBeenCalledWith(
      apiClient,
      {}
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

    expect(createClaudeHistoricalProviderAdapter).toHaveBeenCalledWith({
      client: apiClient,
      env: environment
    });
    expect(createPiHistoricalProviderAdapter).toHaveBeenCalledWith({
      client: apiClient,
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
        protocolVersion: 1
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
