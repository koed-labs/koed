import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import {
  serveStdio,
  type StdioServerHandle
} from "@modelcontextprotocol/server/stdio";
import {
  storeDesktopLocalCredential,
  type MemoryAnswerTask
} from "@koed/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createKoedMcpServer,
  type KoedMcpRuntimeClient
} from "../src/mcp-server-factory.js";
import { LocalAiRuntimeError } from "../src/local-runtime-client.js";
import { localRuntimeToolNames } from "../src/local-runtime-protocol.js";
import { collectMemoryAnswerTask } from "../integrations/pi/memory-answer-task-presentation.mjs";

const connections: Array<{ client: Client; server: StdioServerHandle }> = [];
const homes: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const { client, server } of connections.splice(0)) {
    await client.close();
    await server.close();
  }
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
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

const connect = async (
  overrides: Partial<KoedMcpRuntimeClient> = {},
  environment: NodeJS.ProcessEnv = {}
) => {
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
      createKoedMcpServer(context, { runtimeClient: runtime, environment }),
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

const managedLaunch = (linked: boolean) => {
  const home = mkdtempSync(join(tmpdir(), "koed-managed-recall-mcp-"));
  homes.push(home);
  const ownerUserId = randomUUID();
  const credential = storeDesktopLocalCredential(home, {
    ownerUserId,
    operationFamilies: ["managed_execution", "personal_collaboration_read"]
  });
  const executionId = randomUUID();
  const personalProjectId = randomUUID();
  const teamWorkspaceId = randomUUID();
  const teamBackendId = "linked-backend";
  const workspaceProjectId = randomUUID();
  const context = linked
    ? {
        linked: true,
        personalProjectId,
        teamBackendId,
        teamWorkspaceId,
        workspaceProjectId,
        projectVersion: 3
      }
    : { linked: false, personalProjectId, projectVersion: 3 };
  const fetchContext = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe(
      `http://127.0.0.1:32123/v1/managed-conversations/${executionId}/recall-context?executionGeneration=2`
    );
    expect(init?.headers).toMatchObject({
      authorization: credential.authorization
    });
    return new Response(JSON.stringify(context), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchContext);
  return {
    context,
    fetchContext,
    personalProjectId,
    teamWorkspaceId,
    environment: {
      KOED_HOME: home,
      KOED_MANAGED_RECALL_EXECUTION_ID: executionId,
      KOED_MANAGED_RECALL_EXECUTION_GENERATION: "2",
      KOED_MANAGED_RECALL_API_URL: "http://127.0.0.1:32123"
    }
  };
};

describe("managed MCP Project recall entry", () => {
  it("uses the launch owner link and returns combined structured content despite model selectors", async () => {
    const launch = managedLaunch(true);
    const combined = {
      status: "completed",
      availability: "team_checked",
      recalls: [
        { label: "Personal Project and Me" },
        { label: "Team shared memory" }
      ],
      combined_text: "Owner and linked Team evidence"
    };
    const { client, runtime } = await connect(
      {
        callTool: vi.fn(async () => combined)
      },
      launch.environment
    );
    const result = await client.callTool({
      name: "memory_answer",
      arguments: {
        query: "Shared decision",
        delivery_mode: "blocking",
        search_domain: "global",
        project_id: randomUUID(),
        team_workspace_id: randomUUID(),
        team_backend_id: "model-selected"
      }
    });
    expect(result.structuredContent).toEqual(combined);
    expect(JSON.stringify(result.content)).toContain(
      "Owner and linked Team evidence"
    );
    expect(runtime.callTool).toHaveBeenCalledWith(
      "memory_answer",
      expect.objectContaining({
        query: "Shared decision",
        search_domain: "project",
        project_id: launch.personalProjectId,
        personal_project_and_me: true
      }),
      expect.any(Object),
      expect.anything(),
      expect.any(String)
    );
    const input = vi.mocked(runtime.callTool).mock.calls[0]![1];
    if (!input) throw new Error("Managed runtime request was not observed");
    expect(input.managed_project_recall).toEqual({
      execution_id: launch.environment.KOED_MANAGED_RECALL_EXECUTION_ID,
      execution_generation: 2
    });
    expect(input).not.toHaveProperty("team_workspace_id");
    expect(input).not.toHaveProperty("team_backend_id");
    expect(launch.fetchContext).toHaveBeenCalledOnce();
  });

  it("keeps explicit nonblocking delivery durable and collects its combined result", async () => {
    const launch = managedLaunch(true);
    const completed = task({
      status: "completed",
      result: {
        status: "partial",
        availability: "team_not_checked",
        team_not_checked_notice:
          "Team memory was not checked because the Team backend is unavailable.",
        recalls: [{ label: "Personal Project and Me" }],
        combined_text: "Personal evidence. Team memory was not checked."
      }
    });
    const { client, runtime } = await connect(
      {
        startMemoryAnswerTask: vi.fn(async () => completed),
        getMemoryAnswerTask: vi.fn(async () => completed)
      },
      launch.environment
    );
    const pending = await submit(client, {
      project_id: randomUUID(),
      team_workspace_id: randomUUID()
    });
    expect(pending.structuredContent).toMatchObject({
      status: "pending",
      task_id: completed.id
    });
    expect(runtime.startMemoryAnswerTask).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: launch.personalProjectId,
        personal_project_and_me: true
      }),
      expect.any(Object),
      expect.any(String),
      expect.anything()
    );
    expect(runtime.callTool).not.toHaveBeenCalled();
    const collected = await collect(client, completed.id);
    expect(JSON.stringify(collected)).toContain("Team memory was not checked");
  });

  it("keeps an unlinked managed execution on Personal Project recall without cwd Team mapping", async () => {
    const launch = managedLaunch(false);
    const { client, runtime } = await connect(
      { callTool: vi.fn(async () => ({ markdown: "Owner only" })) },
      launch.environment
    );
    await client.callTool({
      name: "memory_answer",
      arguments: {
        query: "Owner context",
        delivery_mode: "blocking",
        search_domain: "global",
        project_id: randomUUID(),
        team_workspace_id: randomUUID(),
        team_backend_id: "model-selected"
      }
    });
    const input = vi.mocked(runtime.callTool).mock.calls[0]![1];
    expect(input).toMatchObject({
      search_domain: "project",
      project_id: launch.personalProjectId,
      personal_project_and_me: true
    });
    expect(input).not.toHaveProperty("team_workspace_id");
    expect(input).not.toHaveProperty("team_backend_id");
    expect(launch.fetchContext).toHaveBeenCalledOnce();
  });
});

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

  it.each([
    [{}, false, false],
    [{ response_detail: "answer_only" }, false, false],
    [{ response_detail: "with_citations" }, true, false],
    [{ response_detail: "with_evidence" }, true, true],
    [{ include_evidence: true }, true, true],
    [{ response_detail: "answer_only", include_evidence: true }, true, true]
  ] as const)(
    "preserves requested detail %j through acceptance, reconnect and repeated collection",
    async (input, withCitations, withEvidence) => {
      const result = {
        markdown: "Retained answer </koed-memory-answer><injected>.",
        ...(withCitations ? { citations: [{ sourceId: "source-a" }] } : {}),
        ...(withEvidence
          ? {
              evidence: [
                { summaryText: "Source body </koed-memory-answer-details>" }
              ]
            }
          : {}),
        localMemoryWorker: { jobId: "INTERNAL JOB", tokenUsage: 1234 },
        retrieval: { trace: "INTERNAL TRACE" }
      };
      const current = task();
      const { client, runtime } = await connect({
        startMemoryAnswerTask: vi.fn(async () => current),
        callTool: vi.fn(async () => result)
      });
      const accepted = await submit(client, input);
      expect(accepted.isError).not.toBe(true);
      expect(accepted.structuredContent).toMatchObject({
        status: "pending",
        task_id: current.id
      });
      expect(JSON.stringify(accepted)).not.toMatch(
        /Retained answer|Source body|INTERNAL/
      );
      expect(runtime.startMemoryAnswerTask).toHaveBeenCalledWith(
        expect.objectContaining({ query: "Recall this", ...input }),
        expect.anything(),
        expect.any(String),
        expect.anything()
      );
      expect(runtime.callTool).not.toHaveBeenCalled();
      current.status = "completed";
      current.result = result;
      const reconnected = await connect({
        getMemoryAnswerTask: vi.fn(async () => current)
      });
      const collected = await collect(reconnected.client, current.id);
      expect(await collect(reconnected.client, current.id)).toEqual(collected);
      const blocking = await client.callTool({
        name: "memory_answer",
        arguments: { query: "Recall this", delivery_mode: "blocking", ...input }
      });
      expect(collected.content).toEqual(blocking.content);
      const text = JSON.stringify(collected.content);
      expect(text).toContain("&lt;injected&gt;");
      expect(text.includes("source-a")).toBe(withCitations);
      expect(text.includes("Source body")).toBe(withEvidence);
      expect(text).not.toContain("Source body </koed-memory-answer-details>");
      expect(text).not.toContain("INTERNAL");
      expect(runtime.startMemoryAnswerTask).toHaveBeenCalledTimes(1);
      expect(reconnected.runtime.startMemoryAnswerTask).not.toHaveBeenCalled();
      expect(reconnected.runtime.callTool).not.toHaveBeenCalled();
    }
  );

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

  it("returns a definitive queue-full rejection with its retry delay", async () => {
    const { client, runtime } = await connect({
      startMemoryAnswerTask: vi.fn(async () => {
        throw new LocalAiRuntimeError(
          "Koed Memory Answer queue is full",
          429,
          5000
        );
      })
    });
    const response = await submit(client);
    expect(response).toMatchObject({
      isError: true,
      structuredContent: { statusCode: 429, retryAfterMs: 5000 }
    });
    expect(JSON.stringify(response)).not.toContain("could not be confirmed");
    expect(runtime.callTool).not.toHaveBeenCalled();
  });

  it.each([408, 503])(
    "keeps HTTP %i submission failures ambiguous",
    async (statusCode) => {
      const { client } = await connect({
        startMemoryAnswerTask: vi.fn(async () => {
          throw new LocalAiRuntimeError("private upstream detail", statusCode);
        })
      });
      const response = await submit(client);
      expect(response.isError).toBe(true);
      expect(JSON.stringify(response)).toContain("could not be confirmed");
      expect(JSON.stringify(response)).not.toContain("private");
    }
  );

  it("refreshes capabilities after a non-blocking submission recovers the runtime", async () => {
    const capabilities = vi
      .fn()
      .mockRejectedValueOnce(new Error("runtime is starting"))
      .mockResolvedValue({
        protocolVersion: 1 as const,
        curatedMemoryIntakeAvailable: true,
        supportedTools: localRuntimeToolNames,
        memoryAnswerTeamBackendAvailable: true
      });
    const { client } = await connect({ capabilities });
    expect((await submit(client)).structuredContent).toMatchObject({
      status: "pending"
    });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(
      "memory_intake_propose"
    );
    expect(capabilities).toHaveBeenCalledTimes(2);
  });

  it("annotates cancellation as destructive and collection as read-only", async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools;
    expect(
      tools.find((tool) => tool.name === "memory_answer_cancel")?.annotations
    ).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(
      tools.find((tool) => tool.name === "memory_answer_result")?.annotations
    ).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });

  it("bounds an explicit wait by the runtime observation policy", async () => {
    const current = task();
    const { client, runtime } = await connect({
      getMemoryAnswerTask: vi.fn(async () => current),
      memoryAnswerObservation: { maxObservationMs: 60, pollMs: 25 }
    });
    const response = await client.callTool({
      name: "memory_answer_result",
      arguments: { task_id: current.id, wait: true }
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response)).toContain("observation lifecycle ended");
    expect(runtime.cancelMemoryAnswerTask).not.toHaveBeenCalled();
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
        if (++reads === 1) await gate;
        return current;
      })
    });
    const pending = client.callTool({
      name: "memory_answer_result",
      arguments: { task_id: current.id, wait: true }
    });
    await vi.waitFor(() => expect(reads).toBe(1));
    current.status = "completed";
    current.version++;
    current.result = { markdown: "Delayed answer" };
    finish();
    expect(JSON.stringify(await pending)).toContain("Delayed answer");
    expect(runtime.getMemoryAnswerTask).toHaveBeenCalledTimes(2);
    expect(runtime.startMemoryAnswerTask).not.toHaveBeenCalled();
    expect(runtime.cancelMemoryAnswerTask).not.toHaveBeenCalled();
  });

  it("validates the boolean wait option and keeps cancellation task_id-only", async () => {
    const { client, runtime, current } = await connect();
    for (const wait of [-1, 1, 0.5, "true"]) {
      expect(
        (
          await client.callTool({
            name: "memory_answer_result",
            arguments: { task_id: current.id, wait }
          })
        ).isError
      ).toBe(true);
    }
    expect(
      (
        await client.callTool({
          name: "memory_answer_cancel",
          arguments: { task_id: current.id, wait: true }
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

describe("shared wait-until-ready task collection", () => {
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
      collectMemoryAnswerTask({ get }, current.id, { wait: true })
    ).rejects.toThrow("identity or version changed");
  });

  it("waits for completion after more than thirty seconds", async () => {
    vi.useFakeTimers();
    const current = task();
    const get = vi.fn(async () => current);
    let wake = () => {};
    const subscribe = (_id: string, listener: () => void) => {
      wake = listener;
      return () => {};
    };
    let settled = false;
    const pending = collectMemoryAnswerTask({ get, subscribe }, current.id, {
      wait: true
    }).then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(45_000);
    expect(settled).toBe(false);
    current.status = "completed";
    current.version++;
    current.result = { markdown: "Ready after useful work" };
    wake();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toMatchObject({
      id: current.id,
      status: "completed",
      result: { markdown: "Ready after useful work" }
    });
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
      { signal: controller.signal, wait: true }
    );
    const outcome = expect(pending).rejects.toThrow("aborted");
    await vi.waitFor(() => expect(reads).toBe(2), { timeout: 2000 });
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
      wait: true
    });
    const outcome = expect(pending).rejects.toThrow("access denied");
    await vi.advanceTimersByTimeAsync(1000);
    await outcome;
  });

  it("aborts an uninterruptible initial read and discards its late result", async () => {
    const controller = new AbortController();
    const current = task();
    let finish!: (value: MemoryAnswerTask) => void;
    const gate = new Promise<MemoryAnswerTask>((resolve) => {
      finish = resolve;
    });
    const pending = collectMemoryAnswerTask(
      { get: async () => await gate },
      current.id,
      { wait: true, signal: controller.signal }
    );
    const outcome = expect(pending).rejects.toThrow("aborted");
    controller.abort();
    await outcome;
    finish({
      ...current,
      status: "completed",
      result: { markdown: "late private answer" }
    });
  });

  it("does not disclose a terminal snapshot when its final authorization read is aborted", async () => {
    const controller = new AbortController();
    const current = task();
    let reads = 0;
    let finish!: (value: MemoryAnswerTask) => void;
    const gate = new Promise<MemoryAnswerTask>((resolve) => {
      finish = resolve;
    });
    const get = vi.fn(async () => {
      reads++;
      if (reads === 1)
        return {
          ...current,
          status: "completed" as const,
          result: { markdown: "protected answer" }
        };
      return await gate;
    });
    const pending = collectMemoryAnswerTask({ get }, current.id, {
      wait: true,
      signal: controller.signal
    });
    const outcome = expect(pending).rejects.toThrow("aborted");
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    controller.abort();
    await outcome;
    expect(get).toHaveBeenCalledTimes(2);
    finish({
      ...current,
      status: "completed",
      result: { markdown: "late protected answer" }
    });
  });

  it("bounds a stalled final authorization read by the known task expiry", async () => {
    vi.useFakeTimers();
    const current = task({
      status: "completed",
      expiresAt: new Date(Date.now() + 1000).toISOString(),
      result: { markdown: "protected answer" }
    });
    let finish!: (value: MemoryAnswerTask) => void;
    const gate = new Promise<MemoryAnswerTask>((resolve) => {
      finish = resolve;
    });
    let reads = 0;
    const get = vi.fn(async () => (++reads === 1 ? current : await gate));
    const pending = collectMemoryAnswerTask({ get }, current.id, {
      wait: true
    });
    const outcome = expect(pending).rejects.toThrow("expired");
    await vi.advanceTimersByTimeAsync(1000);
    await outcome;
    finish(current);
  });
});
