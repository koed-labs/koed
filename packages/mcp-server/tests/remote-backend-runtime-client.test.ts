import { memoryAnswerInputSchema } from "../src/memory-tool-schemas.js";
import { repositoryScopeId, type RepositoryIdentity } from "@koed/shared";
import { describe, expect, it, vi } from "vitest";
import type { MemoryAnswerTask } from "@koed/shared";
import {
  RemoteBackendRuntimeClient,
  type RemoteMemoryApiClient
} from "../src/remote-backend-runtime-client.js";

const id = "7c07a3cc-5679-4df2-bb67-c86571df93c2";
const task = (overrides: Partial<MemoryAnswerTask> = {}): MemoryAnswerTask => ({
  id,
  origin: "mcp",
  invocationKey: "call-one",
  questionId: null,
  status: "completed",
  statusMessage: null,
  attemptCount: 1,
  maxAttempts: 2,
  fenceGeneration: 1,
  cancelRequestedAt: null,
  startedAt: null,
  lastProgressAt: null,
  completedAt: null,
  failedAt: null,
  cancelledAt: null,
  lastErrorCode: null,
  lastErrorMessage: null,
  result: { markdown: "Retained result." },
  version: 2,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  ...overrides
});

const fixture = () => {
  const client = {
    capabilities: vi.fn<RemoteMemoryApiClient["capabilities"]>(async () => ({
      capabilitySchemaVersion: 4,
      capabilities: {
        "memory.curatedIntake": { availability: "available" },
        "memory.answerTasks": {
          availability: "available",
          version: 2,
          supportedScopes: ["personal", "team"]
        }
      }
    })),
    accessCheck: vi.fn<RemoteMemoryApiClient["accessCheck"]>(),
    search: vi.fn<RemoteMemoryApiClient["search"]>(async () => ({
      results: []
    })),
    expand: vi.fn<RemoteMemoryApiClient["expand"]>(async () => ({ node: {} })),
    proposeCuratedMemory: vi.fn<RemoteMemoryApiClient["proposeCuratedMemory"]>(
      async () => ({ proposal: { id } })
    ),
    acceptMemoryAnswerTask: vi.fn<
      RemoteMemoryApiClient["acceptMemoryAnswerTask"]
    >(async () => ({
      task: task({ status: "accepted", result: null, version: 1 })
    })),
    getMemoryAnswerTask: vi.fn<RemoteMemoryApiClient["getMemoryAnswerTask"]>(
      async () => ({ task: task() })
    ),
    cancelMemoryAnswerTask: vi.fn<
      RemoteMemoryApiClient["cancelMemoryAnswerTask"]
    >(async () => ({ task: task({ status: "cancelled" }) }))
  };
  return {
    client,
    runtime: new RemoteBackendRuntimeClient({
      client,
      pollMs: 25,
      observationTimeoutMs: 100
    })
  };
};

const repositoryContext = (root: string): RepositoryIdentity => ({
  kind: "portable_repository",
  key: "gr_fixture",
  root,
  branch: "main",
  reason: "origin",
  checkoutId: "checkout_fixture",
  originatingDeviceId: "fixture_device",
  selectedRemote: "origin",
  anchorDisplay: "example.test/team/fixture"
});

describe("remote backend runtime client", () => {
  it.each(["blocking", "non_blocking"] as const)(
    "pins a Personal Project in %s mode without checkout discovery",
    async (mode) => {
      const { client, runtime } = fixture();
      client.accessCheck.mockResolvedValue({ user: { id } } as Awaited<
        ReturnType<RemoteMemoryApiClient["accessCheck"]>
      >);
      const recall_target = {
        kind: "project",
        project: { ownerUserId: id, projectId: id }
      };
      const input = { query: "Decision", recall_target };
      if (mode === "blocking")
        await runtime.callTool("memory_answer", input, { cwd: "/unrelated" });
      else await runtime.startMemoryAnswerTask(input, { cwd: "/unrelated" });
      expect(client.acceptMemoryAnswerTask).toHaveBeenCalledOnce();
      expect(
        client.acceptMemoryAnswerTask.mock.calls[0]![0].request
      ).toMatchObject({
        requestVersion: 1,
        selection: { version: 1, ownerUserId: id, target: recall_target },
        input: {
          search_domain: "project",
          project_id: id,
          repository_context: null
        },
        caller: { cwd: "" }
      });
    }
  );
  it("preserves Windows source Project IDs and rejects relative paths", async () => {
    const { client, runtime } = fixture();
    await runtime.startMemoryAnswerTask(
      {
        query: "fact",
        project_id: "C:\\source\\project",
        repository_context: repositoryContext("C:\\source\\project")
      },
      { cwd: "/ignored" }
    );
    expect(
      client.acceptMemoryAnswerTask.mock.calls[0]![0].request.caller
    ).toEqual({ cwd: "C:\\source\\project" });
    await expect(
      runtime.startMemoryAnswerTask(
        { query: "fact", project_id: "relative/project" },
        { cwd: "/server" }
      )
    ).rejects.toMatchObject({
      statusCode: 400,
      memoryAnswerTaskErrorCode: "invalid_project_scope"
    });
    expect(client.acceptMemoryAnswerTask).toHaveBeenCalledOnce();
  });
  it("accepts and observes the existing Personal task contract with explicit Project context", async () => {
    const { client, runtime } = fixture();
    const result = await runtime.callTool(
      "memory_answer",
      {
        query: "fact",
        project_id: "/provided/project",
        repository_context: repositoryContext("/provided/project")
      },
      {
        cwd: "/server/not-the-client-project",
        protocolVersion: "2026-07-28",
        clientInfo: {
          name: "test-client",
          version: "1",
          authorization: "untrusted metadata"
        },
        clientCapabilities: { authority: "untrusted" }
      },
      undefined,
      "call-one"
    );
    expect(result).toEqual({ markdown: "Retained result." });
    expect(client.acceptMemoryAnswerTask).toHaveBeenCalledOnce();
    const accepted = client.acceptMemoryAnswerTask.mock.calls[0]![0];
    expect(accepted.origin).toBe("mcp");
    const acceptedInput = memoryAnswerInputSchema.parse(accepted.request.input);
    expect(acceptedInput.project_id).toBe(
      repositoryScopeId(repositoryContext("/provided/project"))
    );
    expect(acceptedInput.repository_context).toEqual(
      repositoryContext("/provided/project")
    );
    expect(accepted.invocation_key).toBe("call-one");
    expect(accepted.request.caller).toEqual({
      cwd: "/provided/project",
      protocolVersion: "2026-07-28",
      clientInfo: { name: "test-client", version: "1" }
    });
    expect(JSON.stringify(accepted)).not.toContain("untrusted");
    expect(client.getMemoryAnswerTask).toHaveBeenCalledWith(id);
    expect(client.cancelMemoryAnswerTask).not.toHaveBeenCalled();
  });

  it("does not use caller cwd for global recall and rejects implicit Project recall", async () => {
    const { client, runtime } = fixture();
    await expect(
      runtime.callTool(
        "memory_answer",
        { query: "fact" },
        { cwd: "/server/project" }
      )
    ).rejects.toThrow("project_id is required");
    expect(client.acceptMemoryAnswerTask).not.toHaveBeenCalled();
    await runtime.startMemoryAnswerTask(
      { query: "fact", search_domain: "global" },
      { cwd: "/server/project" }
    );
    expect(
      client.acceptMemoryAnswerTask.mock.calls[0]![0].request.caller
    ).toEqual({ cwd: "" });
  });

  it("detaches observation timeout without creating another task or cancelling", async () => {
    const { client } = fixture();
    client.getMemoryAnswerTask.mockResolvedValue({
      task: task({ status: "running", result: null })
    });
    const runtime = new RemoteBackendRuntimeClient({
      client,
      pollMs: 25,
      observationTimeoutMs: 30
    });
    const response = await runtime.callTool(
      "memory_answer",
      { query: "fact", search_domain: "global" },
      { cwd: "" },
      undefined,
      "call-one"
    );
    expect(response.status).toBe("pending");
    expect(response.task_id).toBe(id);
    expect(client.acceptMemoryAnswerTask).toHaveBeenCalledOnce();
    expect(client.cancelMemoryAnswerTask).not.toHaveBeenCalled();
  });

  it("detaches an aborted waiter after acceptance", async () => {
    const { client, runtime } = fixture();
    const controller = new AbortController();
    client.getMemoryAnswerTask.mockImplementation(async () => {
      controller.abort();
      return { task: task({ status: "running", result: null }) };
    });
    const response = await runtime.callTool(
      "memory_answer",
      { query: "fact", search_domain: "global" },
      { cwd: "" },
      controller.signal,
      "call-one"
    );
    expect(response.status).toBe("pending");
    expect(client.cancelMemoryAnswerTask).not.toHaveBeenCalled();
  });

  it("does not accept an already-aborted request", async () => {
    const { client, runtime } = fixture();
    await expect(
      runtime.callTool(
        "memory_answer",
        { query: "fact", search_domain: "global" },
        { cwd: "" },
        AbortSignal.abort()
      )
    ).rejects.toThrow();
    expect(client.acceptMemoryAnswerTask).not.toHaveBeenCalled();
  });

  it("revalidates authorization for every task read and never cancels on denial", async () => {
    const { client, runtime } = fixture();
    client.getMemoryAnswerTask.mockRejectedValue(
      Object.assign(new Error("Access denied"), { statusCode: 401 })
    );
    await expect(
      runtime.callTool(
        "memory_answer",
        { query: "fact", search_domain: "global" },
        { cwd: "" },
        undefined,
        "call-one"
      )
    ).rejects.toThrow("Access denied");
    expect(client.cancelMemoryAnswerTask).not.toHaveBeenCalled();
  });

  it("accepts and observes Team tasks through the same helper-answer pipeline", async () => {
    const { client } = fixture();
    const discoverWorkspaces = vi.fn(async () => ({ workspaces: [{ id }] }));
    const runtime = new RemoteBackendRuntimeClient({
      client,
      supportedTaskScopes: { personal: true, team: { backendId: "team" } },
      discoverWorkspaces
    });
    const response = await runtime.callTool(
      "memory_answer",
      {
        query: "fact",
        search_domain: "global",
        team_workspace_id: id,
        team_backend_id: "team"
      },
      { cwd: "/ignored" },
      undefined,
      "call-one"
    );
    expect(response).toEqual({ markdown: "Retained result." });
    expect(client.acceptMemoryAnswerTask).toHaveBeenCalledOnce();
    expect(
      client.acceptMemoryAnswerTask.mock.calls[0]![0].request.input
    ).toEqual(
      expect.objectContaining({
        team_workspace_id: id,
        search_domain: "global"
      })
    );
    expect((await runtime.capabilities()).supportedTools).toContain(
      "memory_workspaces"
    );
    await runtime.callTool(
      "memory_workspaces",
      { team_backend_id: "team" },
      { cwd: "" }
    );
    expect(discoverWorkspaces).toHaveBeenCalledWith(
      { team_backend_id: "team" },
      undefined
    );
    await expect(
      runtime.startMemoryAnswerTask(
        {
          query: "fact",
          search_domain: "global",
          team_workspace_id: id,
          team_backend_id: "other"
        },
        { cwd: "" }
      )
    ).rejects.toThrow("Requested Team backend is unavailable");
  });

  it("pins portable Team Project context without changing its Workspace or backend", async () => {
    const { client } = fixture();
    const runtime = new RemoteBackendRuntimeClient({
      client,
      supportedTaskScopes: { personal: true, team: { backendId: "team" } }
    });
    const context = repositoryContext("/teammate/another-clone");
    const input = {
      query: "Project decision",
      search_domain: "project",
      team_workspace_id: id,
      team_backend_id: "team",
      repository_context: context
    };
    await runtime.startMemoryAnswerTask(input, {
      cwd: "/teammate/another-clone/subdirectory"
    });
    expect(
      client.acceptMemoryAnswerTask.mock.calls[0]![0].request.input
    ).toMatchObject({
      repository_context: context,
      project_id: repositoryScopeId(context),
      team_workspace_id: id
    });
    await expect(
      runtime.startMemoryAnswerTask(
        { ...input, team_backend_id: "other" },
        { cwd: context.root! }
      )
    ).rejects.toThrow("Requested Team backend is unavailable");
    await expect(
      runtime.startMemoryAnswerTask(
        {
          ...input,
          repository_context: {
            ...context,
            kind: "device_local_repository",
            key: "dl_fixture"
          }
        },
        { cwd: "/teammate/another-clone" }
      )
    ).rejects.toMatchObject({
      statusCode: 400,
      memoryAnswerTaskErrorCode: "invalid_project_scope"
    });
    expect(client.acceptMemoryAnswerTask).toHaveBeenCalledOnce();
  });

  it("fails closed for unavailable Team task capabilities and capability-gated intake", async () => {
    const { client, runtime } = fixture();
    await expect(
      runtime.callTool(
        "memory_answer",
        { query: "fact", search_domain: "global", team_workspace_id: id },
        { cwd: "" }
      )
    ).rejects.toThrow("Team Memory Answer tasks are unavailable");
    client.capabilities.mockResolvedValue({
      capabilitySchemaVersion: 4,
      capabilities: {}
    });
    expect((await runtime.capabilities()).supportedTools).not.toContain(
      "memory_intake_propose"
    );
    await expect(
      runtime.callTool(
        "memory_intake_propose",
        { proposed_claim: "fact" },
        { cwd: "/server" }
      )
    ).rejects.toThrow("Curated Memory intake is unavailable");
    expect(client.proposeCuratedMemory).not.toHaveBeenCalled();
  });

  it("validates diagnostics and proposals without adding a server Project", async () => {
    const { client, runtime } = fixture();
    await expect(
      runtime.callTool("memory_search", { query: "fact" }, { cwd: "/server" })
    ).rejects.toThrow("project_id is required");
    await expect(
      runtime.callTool("memory_expand", { nodeId: "invalid" }, { cwd: "" })
    ).rejects.toThrow();
    expect(client.search).not.toHaveBeenCalled();
    expect(client.expand).not.toHaveBeenCalled();
    await runtime.callTool(
      "memory_intake_propose",
      { proposed_claim: "fact" },
      { cwd: "/server" }
    );
    expect(
      client.proposeCuratedMemory.mock.calls[0]![0].source_project_id
    ).toBeUndefined();
    await runtime.cancelMemoryAnswerTask(id);
    expect(client.cancelMemoryAnswerTask).toHaveBeenCalledWith(id);
  });

  it("isolates executors bound to different authorized API clients", async () => {
    const first = fixture();
    const second = fixture();
    second.client.getMemoryAnswerTask.mockResolvedValue({
      task: task({ result: { markdown: "Second User result" } })
    });
    const [a, b] = await Promise.all([
      first.runtime.callTool(
        "memory_answer",
        { query: "one", search_domain: "global" },
        { cwd: "" },
        undefined,
        "call-one"
      ),
      second.runtime.callTool(
        "memory_answer",
        { query: "two", search_domain: "global" },
        { cwd: "" },
        undefined,
        "call-one"
      )
    ]);
    expect(a.markdown).toBe("Retained result.");
    expect(b.markdown).toBe("Second User result");
    expect(
      first.client.acceptMemoryAnswerTask.mock.calls[0]![0].request.input
    ).toEqual(expect.objectContaining({ query: "one" }));
    expect(
      second.client.acceptMemoryAnswerTask.mock.calls[0]![0].request.input
    ).toEqual(expect.objectContaining({ query: "two" }));
  });
});
