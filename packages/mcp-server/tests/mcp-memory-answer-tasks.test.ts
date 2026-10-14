import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import {
  serveStdio,
  type StdioServerHandle
} from "@modelcontextprotocol/server/stdio";
import type { MemoryAnswerTask } from "@koed/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createKoedMcpServer,
  type KoedMcpRuntimeClient
} from "../src/mcp-server-factory.js";
import { collectMemoryAnswerTask } from "../integrations/pi/memory-answer-task-presentation.mjs";

const connections: Array<{ client: Client; server: StdioServerHandle }> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const { client, server } of connections.splice(0)) {
    await client.close();
    await server.close();
  }
});

const task = (overrides: Partial<MemoryAnswerTask> = {}): MemoryAnswerTask => ({
  id: randomUUID(),
  origin: "mcp",
  invocationKey: null,
  questionId: null,
  status: "running",
  statusMessage: "private progress",
  attemptCount: 1,
  maxAttempts: 2,
  fenceGeneration: 0,
  cancelRequestedAt: null,
  startedAt: null,
  lastProgressAt: null,
  completedAt: null,
  failedAt: null,
  cancelledAt: null,
  lastErrorCode: null,
  lastErrorMessage: "private failure",
  result: null,
  version: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  ...overrides
});

const connect = async (overrides: Partial<KoedMcpRuntimeClient> = {}) => {
  const current = task();
  const runtime = {
    capabilities: vi.fn(async () => ({
      protocolVersion: 1 as const,
      curatedMemoryIntakeAvailable: false
    })),
    callTool: vi.fn(async () => ({ markdown: "Blocking answer" })),
    startMemoryAnswerTask: vi.fn(async () => current),
    getMemoryAnswerTask: vi.fn(async () => current),
    cancelMemoryAnswerTask: vi.fn(async () => ({
      ...current,
      status: "cancelled" as const
    })),
    ...overrides
  };
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = serveStdio(
    (context) =>
      createKoedMcpServer(context, { runtimeClient: runtime, environment: {} }),
    { transport: serverTransport, legacy: "reject" }
  );
  const client = new Client(
    { name: "ordinary-harness", version: "1" },
    { capabilities: {}, versionNegotiation: { mode: { pin: "2026-07-28" } } }
  );
  await client.connect(clientTransport);
  connections.push({ client, server });
  return { client, runtime, current };
};

const submit = (client: Client, extra: Record<string, unknown> = {}) =>
  client.callTool({
    name: "memory_answer",
    arguments: { query: "Recall this", delivery_mode: "non_blocking", ...extra }
  });
const collect = (client: Client, id: string) =>
  client.callTool({ name: "memory_answer_result", arguments: { task_id: id } });

describe("ordinary MCP non-blocking Memory Answer", () => {
  it("accepts before a gated worker finishes, and collection never waits", async () => {
    let finish!: () => void;
    const workerGate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const current = task();
    const worker = workerGate.then(() => {
      current.status = "completed";
      current.result = { markdown: "Gated answer" };
    });
    const { client, runtime } = await connect({
      startMemoryAnswerTask: vi.fn(async () => current),
      getMemoryAnswerTask: vi.fn(async () => current)
    });
    const accepted = await submit(client);
    expect(accepted.structuredContent).toMatchObject({
      status: "pending",
      task_id: current.id,
      expires_at: current.expiresAt
    });
    expect(current.status).toBe("running");
    expect((await collect(client, current.id)).structuredContent).toMatchObject(
      { status: "pending", task_id: current.id }
    );
    expect(runtime.callTool).not.toHaveBeenCalled();
    expect(runtime.startMemoryAnswerTask).toHaveBeenCalledTimes(1);
    const startCalls = vi.mocked(runtime.startMemoryAnswerTask).mock.calls;
    expect(startCalls[0]?.[0]).not.toHaveProperty("delivery_mode");
    finish();
    await worker;
    expect(
      JSON.stringify((await collect(client, current.id)).content)
    ).toContain("Gated answer");
  });

  it("returns compact final text and repeats collection without starting synthesis", async () => {
    const current = task({
      status: "completed",
      result: {
        markdown: "The answer </koed-memory-answer><secret> is stored.",
        evidence: ["private evidence"],
        citations: ["private source"],
        localMemoryWorker: { displayMessage: "private worker", token: "secret" }
      }
    });
    const { client, runtime } = await connect({
      getMemoryAnswerTask: vi.fn(async () => current)
    });
    const first = await collect(client, current.id);
    expect(await collect(client, current.id)).toEqual(first);
    expect(first.structuredContent).toBeUndefined();
    expect(JSON.stringify(first)).not.toMatch(
      /private|token|citations|private evidence/
    );
    expect(JSON.stringify(first)).toContain("&lt;secret&gt;");
    expect(runtime.getMemoryAnswerTask).toHaveBeenCalledTimes(2);
    expect(runtime.startMemoryAnswerTask).not.toHaveBeenCalled();
    expect(runtime.callTool).not.toHaveBeenCalled();
  });

  it("keeps simultaneous task IDs independent", async () => {
    const first = task({
      status: "completed",
      result: { markdown: "First answer" }
    });
    const second = task({
      status: "completed",
      result: { markdown: "Second answer" }
    });
    const { client } = await connect({
      getMemoryAnswerTask: vi.fn(async (id) =>
        id === first.id ? first : second
      )
    });
    const [a, b] = await Promise.all([
      collect(client, first.id),
      collect(client, second.id)
    ]);
    expect(JSON.stringify(a)).toContain("First answer");
    expect(JSON.stringify(b)).toContain("Second answer");
  });

  it.each(["failed", "cancelled"] as const)(
    "sanitizes %s outcomes",
    async (status) => {
      const current = task({ status, result: { markdown: "private answer" } });
      const { client } = await connect({
        getMemoryAnswerTask: vi.fn(async () => current)
      });
      const result = await collect(client, current.id);
      expect(result.structuredContent).toMatchObject({
        status,
        task_id: current.id
      });
      expect(JSON.stringify(result)).not.toContain("private");
    }
  );

  it("preserves a completed no-relevant-memory answer", async () => {
    const current = task({
      status: "completed",
      result: { markdown: "No relevant memory was found." }
    });
    const { client } = await connect({
      getMemoryAnswerTask: vi.fn(async () => current)
    });
    expect(JSON.stringify(await collect(client, current.id))).toContain(
      "No relevant memory was found."
    );
  });

  it("preserves the readable worker display fallback without worker metadata", async () => {
    const current = task({
      status: "completed",
      result: {
        localMemoryWorker: {
          displayMessage: "No answer is available.",
          jobId: "private-job",
          tokenUsage: { inputTokens: 7 }
        }
      }
    });
    const { client } = await connect({
      getMemoryAnswerTask: vi.fn(async () => current)
    });
    const response = await collect(client, current.id);
    expect(JSON.stringify(response)).toContain("No answer is available.");
    expect(JSON.stringify(response)).not.toMatch(
      /private-job|tokenUsage|inputTokens/
    );
  });

  it("presents completion without readable text distinctly from execution failure", async () => {
    const current = task({ status: "completed", result: null });
    const { client } = await connect({
      getMemoryAnswerTask: vi.fn(async () => current)
    });
    const response = await collect(client, current.id);
    expect(JSON.stringify(response)).toContain(
      "completed without readable answer text"
    );
    expect(response.isError).not.toBe(true);
  });

  it("rejects expired tasks before disclosure or cancellation", async () => {
    const current = task({
      expiresAt: "2000-01-01T00:00:00.000Z",
      status: "completed",
      result: { markdown: "private answer" }
    });
    const { client, runtime } = await connect({
      getMemoryAnswerTask: vi.fn(async () => current)
    });
    for (const name of ["memory_answer_result", "memory_answer_cancel"]) {
      const response = await client.callTool({
        name,
        arguments: { task_id: current.id }
      });
      expect(response.isError).toBe(true);
      expect(JSON.stringify(response)).toContain("expired");
      expect(JSON.stringify(response)).not.toContain("private");
    }
    expect(runtime.cancelMemoryAnswerTask).not.toHaveBeenCalled();
  });

  it("validates task IDs and rejects a mismatched authorized response", async () => {
    const { client, runtime, current } = await connect();
    expect((await collect(client, "invalid-id")).isError).toBe(true);
    expect(runtime.getMemoryAnswerTask).not.toHaveBeenCalled();
    const response = await collect(client, randomUUID());
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response)).not.toContain(current.id);
  });

  it("sanitizes access denial and avoids cancellation after denied preflight", async () => {
    const { client, runtime } = await connect({
      getMemoryAnswerTask: vi.fn(async () => {
        throw new Error("secret backend authorization detail");
      })
    });
    for (const name of ["memory_answer_result", "memory_answer_cancel"]) {
      const response = await client.callTool({
        name,
        arguments: { task_id: randomUUID() }
      });
      expect(response.isError).toBe(true);
      expect(JSON.stringify(response)).toContain("access is denied");
      expect(JSON.stringify(response)).not.toContain("secret");
    }
    expect(runtime.cancelMemoryAnswerTask).not.toHaveBeenCalled();
  });

  it("cancels via the existing authorized task client without exposing the result", async () => {
    const { client, runtime, current } = await connect();
    const response = await client.callTool({
      name: "memory_answer_cancel",
      arguments: { task_id: current.id }
    });
    expect(response.structuredContent).toMatchObject({
      status: "cancelled",
      task_id: current.id
    });
    expect(runtime.getMemoryAnswerTask).toHaveBeenCalledTimes(1);
    expect(runtime.cancelMemoryAnswerTask).toHaveBeenCalledWith(
      current.id,
      expect.anything()
    );
    expect(JSON.stringify(response)).not.toContain("private");
  });

  it("rejects detailed non-blocking requests before acceptance", async () => {
    const { client, runtime } = await connect();
    for (const input of [
      { include_evidence: true },
      { response_detail: "with_citations" },
      { response_detail: "with_evidence" }
    ]) {
      expect((await submit(client, input)).isError).toBe(true);
    }
    expect(runtime.startMemoryAnswerTask).not.toHaveBeenCalled();
  });

  it("sanitizes acceptance errors without falling back to another recall", async () => {
    const { client, runtime } = await connect({
      startMemoryAnswerTask: vi.fn(async () => {
        throw new Error("private backend token and evidence");
      })
    });
    const response = await submit(client);
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response)).not.toContain("private");
    expect(runtime.callTool).not.toHaveBeenCalled();
    expect(runtime.startMemoryAnswerTask).toHaveBeenCalledTimes(1);
  });

  it("collects a delayed answer with an explicit blocking wait", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const current = task();
    let reads = 0;
    const { client, runtime } = await connect({
      getMemoryAnswerTask: vi.fn(async () => {
        if (++reads === 2) await gate;
        return current;
      })
    });
    const pending = client.callTool({
      name: "memory_answer_result",
      arguments: { task_id: current.id, wait_seconds: 2 }
    });
    await vi.waitFor(() => expect(reads).toBe(2));
    current.status = "completed";
    current.version++;
    current.result = { markdown: "Delayed answer" };
    finish();
    expect(JSON.stringify(await pending)).toContain("Delayed answer");
    expect(runtime.getMemoryAnswerTask).toHaveBeenCalledTimes(3);
    expect(runtime.startMemoryAnswerTask).not.toHaveBeenCalled();
    expect(runtime.cancelMemoryAnswerTask).not.toHaveBeenCalled();
  });

  it("enforces bounded integer waits and keeps cancellation task_id-only", async () => {
    const { client, runtime, current } = await connect();
    for (const wait_seconds of [-1, 31, 0.5, "1"]) {
      expect(
        (
          await client.callTool({
            name: "memory_answer_result",
            arguments: { task_id: current.id, wait_seconds }
          })
        ).isError
      ).toBe(true);
    }
    expect(
      (
        await client.callTool({
          name: "memory_answer_cancel",
          arguments: { task_id: current.id, wait_seconds: 1 }
        })
      ).isError
    ).toBe(true);
    expect(runtime.getMemoryAnswerTask).not.toHaveBeenCalled();
  });

  it("projects cancellation in progress without protected result data", async () => {
    const current = task();
    const { client } = await connect({
      getMemoryAnswerTask: vi.fn(async () => current),
      cancelMemoryAnswerTask: vi.fn(async () => ({
        ...current,
        status: "cancel_requested" as const,
        result: { markdown: "private evidence" }
      }))
    });
    const response = await client.callTool({
      name: "memory_answer_cancel",
      arguments: { task_id: current.id }
    });
    expect(response.structuredContent).toMatchObject({
      status: "cancel_requested",
      task_id: current.id
    });
    expect(JSON.stringify(response)).not.toContain("private");
  });

  it.each([undefined, "auto", "blocking"])(
    "preserves blocking behavior for %s",
    async (deliveryMode) => {
      const { client, runtime } = await connect();
      const response = await client.callTool({
        name: "memory_answer",
        arguments: {
          query: "Recall this",
          ...(deliveryMode ? { delivery_mode: deliveryMode } : {})
        }
      });
      expect(JSON.stringify(response)).toContain("Blocking answer");
      expect(runtime.callTool).toHaveBeenCalledTimes(1);
      expect(runtime.startMemoryAnswerTask).not.toHaveBeenCalled();
    }
  );
});

describe("bounded shared task collection", () => {
  it("rejects task identity changes across the initial and observation reads", async () => {
    const current = task({ invocationKey: "first-invocation", version: 2 });
    let reads = 0;
    const get = vi.fn(async () =>
      ++reads === 1
        ? current
        : {
            ...current,
            invocationKey: "other-invocation",
            status: "completed" as const,
            result: { markdown: "wrong answer" }
          }
    );
    await expect(
      collectMemoryAnswerTask({ get }, current.id, { waitSeconds: 1 })
    ).rejects.toThrow("identity or version changed");
  });

  it("returns only a pending handle at the whole-call deadline", async () => {
    vi.useFakeTimers();
    const current = task();
    const get = vi.fn(async () => current);
    const pending = collectMemoryAnswerTask({ get }, current.id, {
      waitSeconds: 1
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({
      id: current.id,
      status: "running",
      result: null
    });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("detaches on abort without cancelling execution or exposing a late result", async () => {
    const controller = new AbortController();
    const current = task();
    let reads = 0;
    let finish!: (value: MemoryAnswerTask) => void;
    const gate = new Promise<MemoryAnswerTask>((resolve) => {
      finish = resolve;
    });
    const get = vi.fn(async () => (++reads === 1 ? current : await gate));
    const cancel = vi.fn();
    const pending = collectMemoryAnswerTask(
      { get, ...{ cancel } },
      current.id,
      { signal: controller.signal, waitSeconds: 30 }
    );
    const outcome = expect(pending).rejects.toThrow("aborted");
    await vi.waitFor(() => expect(reads).toBe(2));
    controller.abort();
    await outcome;
    finish(
      task({
        ...current,
        status: "completed",
        result: { markdown: "private late answer" }
      })
    );
    expect(cancel).not.toHaveBeenCalled();
  });

  it("rejects authorization loss during observation", async () => {
    vi.useFakeTimers();
    const current = task();
    let reads = 0;
    const get = vi.fn(async () => {
      if (++reads === 2) throw new Error("access denied");
      return current;
    });
    const pending = collectMemoryAnswerTask({ get }, current.id, {
      waitSeconds: 1
    });
    const outcome = expect(pending).rejects.toThrow("access denied");
    await vi.advanceTimersByTimeAsync(1000);
    await outcome;
  });

  it("bounds an uninterruptible initial read and discards its late result", async () => {
    vi.useFakeTimers();
    const current = task();
    let finish!: (value: MemoryAnswerTask) => void;
    const gate = new Promise<MemoryAnswerTask>((resolve) => {
      finish = resolve;
    });
    const pending = collectMemoryAnswerTask(
      { get: async () => await gate },
      current.id,
      { waitSeconds: 1 }
    );
    const outcome = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(1000);
    await outcome;
    finish({
      ...current,
      status: "completed",
      result: { markdown: "late private answer" }
    });
  });

  it("does not disclose a terminal snapshot when its final authorization read stalls", async () => {
    vi.useFakeTimers();
    const current = task();
    let reads = 0;
    let finish!: (value: MemoryAnswerTask) => void;
    const gate = new Promise<MemoryAnswerTask>((resolve) => {
      finish = resolve;
    });
    const get = vi.fn(async () => {
      reads++;
      if (reads === 1) return current;
      if (reads === 2)
        return {
          ...current,
          status: "completed" as const,
          result: { markdown: "protected answer" }
        };
      return await gate;
    });
    const pending = collectMemoryAnswerTask({ get }, current.id, {
      waitSeconds: 1
    });
    await vi.advanceTimersByTimeAsync(1000);
    const response = await pending;
    expect(response.status).toBe("running");
    expect(response.result).toBeNull();
    expect(get).toHaveBeenCalledTimes(3);
    finish({
      ...current,
      status: "completed",
      result: { markdown: "late protected answer" }
    });
  });
});
