import { createServer } from "node:net";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalAiRuntimeClient } from "../src/local-runtime-client.js";
import {
  localRuntimeRegistrationPath,
  readLocalRuntimeRegistration
} from "../src/local-runtime-protocol.js";
import {
  startLocalAiRuntime,
  type LocalAiRuntimeServiceFactory,
  type LocalAiRuntimeToolExecutor
} from "../src/local-runtime-server.js";

const roots: string[] = [];
const tempHome = (): string => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-local-ai-runtime-"));
  roots.push(root);
  return root;
};

afterEach(() => {
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
  execute: async (name, input, caller) => ({ name, input, caller })
});

describe("Local AI Runtime", () => {
  it("publishes an owner-only registration and authenticates adapter calls", async () => {
    const koedHome = tempHome();
    const environment = { KOED_HOME: koedHome };
    const execute = vi.fn(defaultExecutor().execute);
    const services = fixture({
      capabilities: defaultExecutor().capabilities,
      execute
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
    } finally {
      await runtime.close();
    }

    expect(services.close).toHaveBeenCalledTimes(1);
    expect(() =>
      readFileSync(localRuntimeRegistrationPath(koedHome))
    ).toThrow();
  });

  it("rejects malformed, oversized, and unknown requests without dispatch", async () => {
    const koedHome = tempHome();
    const environment = { KOED_HOME: koedHome };
    const execute = vi.fn(defaultExecutor().execute);
    const runtime = await startLocalAiRuntime({
      environment,
      serviceFactory: fixture({
        capabilities: defaultExecutor().capabilities,
        execute
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
        execute
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
      execute
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
        execute: async () => ({ instance: "first" })
      }).serviceFactory
    });
    const secondRuntime = await startLocalAiRuntime({
      environment: secondEnvironment,
      serviceFactory: fixture({
        capabilities: defaultExecutor().capabilities,
        execute: async () => ({ instance: "second" })
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
