import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { personalFolderScopeId } from "@koed-labs/shared";
import { MemoryApiClient } from "../src/index.js";
import { memoryAnswerAdapterInputSchema } from "../src/memory-tool-schemas.js";
import { pinPersonalRecallRequest } from "../src/personal-recall-request.js";
import { createMemoryAnswerTaskCoordinator } from "../src/memory-answer-task-coordinator.js";
import { MemoryToolExecutor } from "../src/memory-tool-executor.js";

const ownerUserId = randomUUID();
const projectId = randomUUID();
const sessionId = randomUUID();
const unionTarget = {
  kind: "projects" as const,
  projects: [
    { ownerUserId, projectId },
    { ownerUserId, projectId: randomUUID() }
  ],
  callerSessionId: sessionId
};
const folder = {
  ownerUserId,
  folderId: randomUUID(),
  originatingDeploymentId: "fixture-deployment",
  originatingDeviceId: "fixture-device",
  originatingProfileId: "fixture-profile",
  directoryIncarnationId: randomUUID()
};
const cases = [
  {
    target: { kind: "project" as const, project: { ownerUserId, projectId } },
    scope: projectId
  },
  {
    target: { kind: "folder" as const, folder },
    scope: personalFolderScopeId(folder)
  }
];
const access = () =>
  ({ user: { id: ownerUserId } }) as Awaited<
    ReturnType<MemoryApiClient["accessCheck"]>
  >;

describe("public Personal recall targets", () => {
  it("pins the current Conversation Project union before durable acceptance", async () => {
    const client = new MemoryApiClient({
      apiUrl: "https://unavailable.fixture"
    });
    vi.spyOn(client, "accessCheck").mockResolvedValue(access());
    const resolve = vi
      .spyOn(client, "resolvePersonalProjectRecall")
      .mockResolvedValue({ sessionId, target: unionTarget });
    const accept = vi
      .spyOn(client, "acceptMemoryAnswerTask")
      .mockResolvedValue({
        task: { id: randomUUID(), teamWorkspaceId: null }
      } as Awaited<ReturnType<MemoryApiClient["acceptMemoryAnswerTask"]>>);
    const coordinator = createMemoryAnswerTaskCoordinator(client, {
      KOED_HOME: "/fixture/no-enrollment"
    });
    await coordinator.acceptMemoryAnswerTask({
      origin: "mcp",
      request: {
        input: { query: "Decision", search_domain: "project" },
        caller: { cwd: "/missing/checkout", conversation: { sessionId } }
      },
      max_queued: 4
    });
    expect(resolve).toHaveBeenCalledWith({ sessionId });
    const request = accept.mock.calls[0]![0].request;
    expect(request).toMatchObject({
      requestVersion: 1,
      selection: { version: 1, ownerUserId, target: unionTarget },
      input: { search_domain: "project", repository_context: null }
    });
    expect(
      (request.input as Record<string, unknown>).project_id
    ).toBeUndefined();
  });

  it("preserves the Project union on direct search and expansion", async () => {
    const search = vi.fn<MemoryApiClient["search"]>(async () => ({
      candidates: []
    }));
    const expand = vi.fn<MemoryApiClient["expand"]>(async () => ({
      expanded: { sourceItems: [], sources: [] }
    }));
    const client = {
      accessCheck: vi.fn(async () => access()),
      resolvePersonalProjectRecall: vi.fn(async () => ({
        sessionId,
        target: unionTarget
      })),
      listLocalMemoryAgentSettings: vi.fn(async () => ({ settings: [] })),
      search,
      expand
    } as unknown as MemoryApiClient;
    const executor = new MemoryToolExecutor(
      client,
      {},
      {
        answerWithMemoryWorker: async (_payload, options) => {
          expect(options).toMatchObject({ searchDomain: "project" });
          await options?.client?.search({
            query: "Decision",
            search_domain: "global"
          });
          await options?.client?.expand(randomUUID(), {
            searchDomain: "global"
          });
          throw new Error("Retrieval boundary reached");
        }
      }
    );
    await expect(
      executor.execute(
        "memory_answer",
        {
          query: "Decision",
          repository_context: null
        },
        { cwd: "/missing/checkout", conversation: { sessionId } }
      )
    ).rejects.toThrow("Retrieval boundary reached");
    expect(search.mock.calls[0]?.[0]).toMatchObject({
      personal_selection: {
        version: 1,
        ownerUserId,
        target: unionTarget
      }
    });
    expect(expand.mock.calls[0]?.[1]).toMatchObject({
      personalSelection: {
        version: 1,
        ownerUserId,
        target: unionTarget
      }
    });
  });

  it.each([false, true])(
    "retains the accepted Project union in final task output (fallback=%s)",
    async (usedFallback) => {
      const client = {
        accessCheck: vi.fn(async () => access()),
        listLocalMemoryAgentSettings: vi.fn(async () => ({ settings: [] })),
        recordTokenUsage: vi.fn(async () => ({}))
      } as unknown as MemoryApiClient;
      const executor = new MemoryToolExecutor(
        client,
        {},
        {
          answerWithMemoryWorker: async () => ({
            markdown: "Decision",
            evidenceBundle: { evidence: [], retrieval: {} },
            citations: [],
            retrieval: { evidenceCount: 0 },
            localMemoryWorker: {
              provider: "codex",
              model: "fixture-model",
              promptVersion: "test",
              jobId: "union-final",
              usedFallback
            }
          })
        }
      );
      const selection = {
        version: 1 as const,
        ownerUserId,
        target: unionTarget,
        callerRepositoryContext: null
      };
      const prepared = await executor.executeMemoryAnswerTask(
        {
          query: "Decision",
          search_domain: "project",
          repository_context: null
        } as never,
        { cwd: "/missing/checkout" },
        randomUUID(),
        undefined,
        undefined,
        {
          personalSelection: selection,
          getExecutionAuthority: () => ({ scope: "personal" })
        } as never
      );
      expect(prepared.finalQuestion).toMatchObject({
        search_domain: "project",
        personal_selection: selection,
        status: usedFallback ? "error" : "answered"
      });
      expect(prepared.finalQuestion.project_id).toBeUndefined();
    }
  );

  it("rejects a resolver response for another Conversation", async () => {
    const client = {
      accessCheck: vi.fn(async () => access()),
      resolvePersonalProjectRecall: vi.fn(async () => ({
        sessionId: randomUUID(),
        target: unionTarget
      }))
    };
    await expect(
      pinPersonalRecallRequest({ query: "Decision" }, client, {
        conversation: { sessionId }
      })
    ).rejects.toThrow("does not match");
  });

  it("keeps the trusted caller Session separate from query Session filtering", async () => {
    const client = {
      accessCheck: vi.fn(async () => access()),
      resolvePersonalProjectRecall: vi.fn(async () => ({
        sessionId,
        target: unionTarget
      }))
    };
    await expect(
      pinPersonalRecallRequest(
        { query: "Decision", session_id: sessionId },
        client,
        { conversation: { sessionId } }
      )
    ).rejects.toThrow("cannot contain session_id");
    expect(client.resolvePersonalProjectRecall).not.toHaveBeenCalled();
    const pinned = await pinPersonalRecallRequest(
      { query: "Decision" },
      client,
      { conversation: { sessionId } }
    );
    expect(pinned.input.session_id).toBeUndefined();
  });

  it.each([
    undefined,
    {},
    { sessionId: "not-a-session" },
    {
      externalSessionId: "native-conversation",
      sourceRuntime: "unknown"
    }
  ])(
    "requires a valid trusted Conversation binding: %j",
    async (conversation) => {
      const client = { accessCheck: vi.fn(async () => access()) };
      await expect(
        pinPersonalRecallRequest({ query: "Decision" }, client, {
          conversation
        } as never)
      ).rejects.toThrow("current Conversation binding");
      expect(client.accessCheck).not.toHaveBeenCalled();
    }
  );

  it("resolves native Conversation bindings and propagates membership failures", async () => {
    const conversation = {
      externalSessionId: "native-id",
      sourceRuntime: "codex-cli" as const
    };
    const client = {
      accessCheck: vi.fn(async () => access()),
      resolvePersonalProjectRecall: vi.fn(async () => ({
        sessionId,
        target: unionTarget
      }))
    };
    expect(
      (
        await pinPersonalRecallRequest({ query: "Decision" }, client, {
          conversation
        })
      ).selection
    ).toMatchObject({ target: unionTarget });
    expect(client.resolvePersonalProjectRecall).toHaveBeenCalledWith(
      conversation
    );
    client.resolvePersonalProjectRecall.mockRejectedValueOnce(
      new Error("Conversation has no Projects")
    );
    await expect(
      pinPersonalRecallRequest({ query: "Decision" }, client, { conversation })
    ).rejects.toThrow("no Projects");
  });

  it("does not resolve a Project union for Global, Session, legacy repository or explicit Team", async () => {
    const client = {
      accessCheck: vi.fn(async () => access()),
      resolvePersonalProjectRecall: vi.fn()
    };
    for (const selectors of [
      { search_domain: "global" },
      { search_domain: "session", session_id: sessionId },
      { search_domain: "project", project_id: "legacy-repository" },
      { search_domain: "project", team_workspace_id: randomUUID() }
    ])
      expect(
        (
          await pinPersonalRecallRequest(
            { query: "Decision", ...selectors },
            client
          )
        ).selection
      ).toBeUndefined();
    expect(client.resolvePersonalProjectRecall).not.toHaveBeenCalled();
  });

  it("does not replace accepted selections and rejects Team-mixed Personal unions", async () => {
    const client = new MemoryApiClient({
      apiUrl: "https://unavailable.fixture"
    });
    const resolve = vi.spyOn(client, "resolvePersonalProjectRecall");
    const selection = {
      version: 1,
      ownerUserId,
      target: unionTarget,
      callerRepositoryContext: null
    };
    const coordinator = createMemoryAnswerTaskCoordinator(client, {});
    await expect(
      coordinator.acceptMemoryAnswerTask({
        origin: "mcp",
        max_queued: 4,
        request: {
          requestVersion: 1,
          selection,
          input: { query: "Decision", recall_target: cases[0]!.target }
        }
      })
    ).rejects.toThrow("cannot replace an accepted selection");
    await expect(
      coordinator.acceptMemoryAnswerTask({
        origin: "mcp",
        max_queued: 4,
        request: {
          requestVersion: 1,
          selection,
          input: {
            query: "Decision",
            search_domain: "project",
            team_workspace_id: randomUUID()
          }
        }
      })
    ).rejects.toThrow("cannot route to Team");
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each(cases)(
    "pins $target.kind to the authenticated owner before task acceptance",
    async ({ target, scope }) => {
      const client = new MemoryApiClient({
        apiUrl: "https://unavailable.fixture"
      });
      vi.spyOn(client, "accessCheck").mockResolvedValue(access());
      const accept = vi
        .spyOn(client, "acceptMemoryAnswerTask")
        .mockResolvedValue({
          task: { id: randomUUID(), teamWorkspaceId: null }
        } as Awaited<ReturnType<MemoryApiClient["acceptMemoryAnswerTask"]>>);
      const coordinator = createMemoryAnswerTaskCoordinator(client, {
        KOED_HOME: "/fixture/no-enrollment"
      });
      const input = memoryAnswerAdapterInputSchema.parse({
        query: "Synthetic decision",
        recall_target: target
      });
      await coordinator.acceptMemoryAnswerTask({
        origin: "mcp",
        request: { input, caller: { cwd: "/unrelated/checkout" } },
        max_queued: 4
      });
      expect(accept.mock.calls[0]![0].request).toMatchObject({
        requestVersion: 1,
        selection: {
          version: 1,
          ownerUserId,
          target,
          callerRepositoryContext: null
        },
        input: {
          search_domain: "project",
          project_id: scope,
          repository_context: null
        }
      });
      expect(
        (accept.mock.calls[0]![0].request.input as Record<string, unknown>)
          .recall_target
      ).toBeUndefined();
    }
  );

  it.each(cases)(
    "keeps $target.kind on every expansion in direct execution",
    async ({ target }) => {
      const expand = vi.fn<MemoryApiClient["expand"]>(async () => ({
        expanded: { sourceItems: [], sources: [] }
      }));
      const client = {
        accessCheck: vi.fn(async () => access()),
        listLocalMemoryAgentSettings: vi.fn(async () => ({ settings: [] })),
        expand
      } as unknown as MemoryApiClient;
      const executor = new MemoryToolExecutor(
        client,
        {},
        {
          answerWithMemoryWorker: async (_payload, options) => {
            await options?.client?.expand(randomUUID(), {
              searchDomain: "global"
            });
            throw new Error("Expansion boundary reached");
          }
        }
      );
      await expect(
        executor.execute(
          "memory_answer",
          { query: "Decision", recall_target: target },
          { cwd: "/unrelated/checkout" }
        )
      ).rejects.toThrow("Expansion boundary reached");
      expect(expand.mock.calls[0]?.[1]).toMatchObject({
        personalSelection: { version: 1, ownerUserId, target }
      });
    }
  );

  it.each([
    { search_domain: "project" },
    { project_id: projectId },
    { session_id: randomUUID() },
    { team_workspace_id: randomUUID() },
    { team_backend_id: "team" }
  ])("rejects conflicting selectors and Team routing: %j", (extra) => {
    expect(
      memoryAnswerAdapterInputSchema.safeParse({
        query: "Decision",
        recall_target: cases[0]!.target,
        ...extra
      }).success
    ).toBe(false);
  });

  it("rejects another owner's target before acceptance", async () => {
    const client = { accessCheck: vi.fn(async () => access()) };
    await expect(
      pinPersonalRecallRequest(
        {
          query: "Decision",
          recall_target: {
            kind: "project",
            project: { ownerUserId: randomUUID(), projectId }
          }
        },
        client
      )
    ).rejects.toThrow("another owner");
    await expect(
      pinPersonalRecallRequest(
        {
          query: "Decision",
          recall_target: {
            kind: "folder",
            folder: { ...folder, ownerUserId: randomUUID() }
          }
        },
        client
      )
    ).rejects.toThrow("another owner");
  });
});
