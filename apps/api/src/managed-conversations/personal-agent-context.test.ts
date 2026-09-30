import { describe, expect, it, vi } from "vitest";
import {
  buildPersonalAgentTurnContext,
  buildPersonalMemoryTurnContext,
  buildPersonalAgentMemoryTurnContext
} from "./personal-agent-context.js";

const agent = {
  contractVersion: 1 as const,
  id: "22a6397c-fd63-4d0e-a049-976bc9363178",
  ownerUserId: "ab647003-4095-4a98-8515-c872ba78a717",
  name: "Mira",
  role: "Reviewer",
  avatarReference: null,
  lifecycle: "active" as const,
  defaultProvider: "codex",
  defaultModel: "gpt-test",
  defaultReasoningEffort: null,
  currentVersion: 4,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-02-01T00:00:00.000Z",
  retiredAt: null
};

const version = {
  contractVersion: 1 as const,
  id: "9c7d7a1b-5c88-4c44-9b15-172e56017fcb",
  agentId: agent.id,
  ownerUserId: agent.ownerUserId,
  version: agent.currentVersion,
  name: agent.name,
  role: agent.role,
  avatarReference: null,
  defaultProvider: agent.defaultProvider,
  defaultModel: agent.defaultModel,
  defaultReasoningEffort: null,
  soulInstructions: "Be concise.",
  instructionSource: "custom" as const,
  createdByUserId: agent.ownerUserId,
  createdAt: agent.createdAt
};

const workspaceContext = (teamId: string, workspaceId: string) => ({
  teamId,
  teamName: `Team ${teamId}`,
  teamRole: "member" as const,
  teamWorkspaceId: workspaceId,
  teamWorkspaceName: `Workspace ${workspaceId}`,
  access: "read" as const
});

const teamBoundary = (
  teamId: string,
  workspaceId: string,
  grantId: string
) => ({
  teamId,
  teamVersion: 1,
  teamWorkspaceId: workspaceId,
  workspaceVersion: 1,
  membershipVersion: 1,
  workspaceAccessVersion: 1,
  userRowVersion: "1",
  shareGrantIds: [grantId]
});

const teamCandidate = (input: {
  candidateId: string;
  logicalMemoryId: string;
  pseudonymousSourceId: string;
  text: string;
  score: number;
}) => ({
  source: {
    kind: "captured_session" as const,
    sessionId: input.logicalMemoryId,
    logicalMemoryId: input.logicalMemoryId
  },
  candidateId: input.candidateId,
  shareGrantId: "55555555-5555-4555-8555-555555555555",
  sourceArtifactId: "66666666-6666-4666-8666-666666666666",
  sourceRevisionHash: "a".repeat(64),
  representationId: "77777777-7777-4777-8777-777777777777",
  representation: "lcm_rollups" as const,
  pseudonymousSourceId: input.pseudonymousSourceId,
  sourceItemIndex: 0,
  sourceRevision: 1,
  provenanceHash: "b".repeat(64),
  representationPolicyRevision: 1,
  contentPolicyVersion: 1,
  classifierVersion: 1,
  embeddingModel: "qwen3-0.6b",
  embeddingDimensions: 1024,
  embeddingVersion: "test-v1",
  itemType: "lcm_rollup" as const,
  occurredAt: null,
  text: input.text,
  lexicalAnchors: [],
  score: input.score,
  freshness: "fresh" as const
});

const embeddingFetch: typeof fetch = async () =>
  new Response(
    JSON.stringify({
      model: "qwen3-0.6b",
      dimensions: 1024,
      vectors: [Array.from({ length: 1024 }, () => 0.1)]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );

describe("buildPersonalAgentTurnContext", () => {
  it("uses the execution Project as relevance context and drops non-Personal personal-search hits", async () => {
    const searchMemoryNodes = vi.fn(async () => ({
      results: [
        {
          nodeId: "node-personal",
          sourceType: "memory_node",
          sourceId: "source-personal",
          summaryText: "Relevant earlier decision.",
          citation: { nodeId: "node-personal", visibility: "personal" },
          visibility: "personal",
          occurredAt: "2026-02-01T00:00:00.000Z"
        },
        {
          nodeId: "node-team",
          summaryText: "Do not include this.",
          citation: { nodeId: "node-team", visibility: "team" },
          visibility: "team"
        }
      ],
      metadata: {}
    }));
    const repository = {
      getPersonalAgent: vi.fn(async () => ({
        agent,
        soulInstructions: version.soulInstructions,
        history: {}
      })),
      getPersonalAgentVersion: vi.fn(async () => version),
      listTeamWorkspaceContexts: vi.fn(async () => []),
      listLcmGraphThreads: vi.fn(async () => [
        {
          id: "project-7",
          name: "Koed",
          path: "/workspace/koed",
          eventCount: 2,
          threads: []
        }
      ]),
      searchMemoryNodes
    } as never;

    const result = await buildPersonalAgentTurnContext({
      repository,
      ownerUserId: agent.ownerUserId,
      agentId: agent.id,
      projectId: "project-7",
      prompt: "Review the current Project decision."
    });

    expect(result.expectedAgentVersion).toBe(4);
    expect(result.context.identity.identityVersionId).toBe(version.id);
    expect(result.context.project).toEqual({
      projectId: "project-7",
      name: "Koed"
    });
    expect(result.context.memory.searchDomain).toBe("global");
    expect(result.context.memory.evidence).toHaveLength(1);
    expect(searchMemoryNodes).toHaveBeenCalledWith(
      { userId: agent.ownerUserId },
      expect.objectContaining({
        scope: "personal",
        searchDomain: "global"
      })
    );
  });

  it("uses authorized Personal global recall for a standalone conversation", async () => {
    const searchMemoryNodes = vi.fn(async () => ({
      results: [],
      metadata: {}
    }));
    const repository = {
      getPersonalAgent: vi.fn(async () => ({
        agent,
        soulInstructions: version.soulInstructions,
        history: {}
      })),
      getPersonalAgentVersion: vi.fn(async () => version),
      listTeamWorkspaceContexts: vi.fn(async () => []),
      searchMemoryNodes
    } as never;

    const result = await buildPersonalAgentTurnContext({
      repository,
      ownerUserId: agent.ownerUserId,
      agentId: agent.id,
      projectId: null,
      prompt: "What should I do next?"
    });

    expect(result.context.project).toEqual({ projectId: null, name: null });
    expect(result.context.memory.searchDomain).toBe("global");
    expect(searchMemoryNodes).toHaveBeenCalledWith(
      { userId: agent.ownerUserId },
      expect.objectContaining({ scope: "personal", searchDomain: "global" })
    );
  });

  it("keeps an owner-verified Project context when it has no memory graph rows", async () => {
    const repository = {
      getPersonalAgent: vi.fn(async () => ({
        agent,
        soulInstructions: version.soulInstructions,
        history: {}
      })),
      getPersonalAgentVersion: vi.fn(async () => version),
      listTeamWorkspaceContexts: vi.fn(async () => []),
      listLcmGraphThreads: vi.fn(async () => []),
      searchMemoryNodes: vi.fn(async () => ({ results: [], metadata: {} }))
    } as never;
    const result = await buildPersonalAgentTurnContext({
      repository,
      ownerUserId: agent.ownerUserId,
      agentId: agent.id,
      projectId: "project-empty",
      prompt: "Review this Project."
    });
    expect(result.context.project).toEqual({
      projectId: "project-empty",
      name: null
    });
  });

  it("does not resolve another owner's or retired agent", async () => {
    const repository = {
      getPersonalAgent: vi.fn(async () => null)
    } as never;
    await expect(
      buildPersonalAgentTurnContext({
        repository,
        ownerUserId: agent.ownerUserId,
        agentId: agent.id,
        projectId: null,
        prompt: "Hello"
      })
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects a stale selected identity version instead of switching versions", async () => {
    const repository = {
      getPersonalAgent: vi.fn(async () => ({
        agent,
        soulInstructions: version.soulInstructions,
        history: {}
      })),
      getPersonalAgentVersion: vi.fn(async () => version),
      listTeamWorkspaceContexts: vi.fn(async () => []),
      searchMemoryNodes: vi.fn()
    } as never;

    await expect(
      buildPersonalAgentTurnContext({
        repository,
        ownerUserId: agent.ownerUserId,
        agentId: agent.id,
        expectedAgentVersion: 3,
        projectId: null,
        prompt: "Hello"
      })
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(repository.searchMemoryNodes).not.toHaveBeenCalled();
  });

  it("merges Personal evidence with authorized evidence from every accessible Team Workspace", async () => {
    const ownerUserId = agent.ownerUserId;
    const teamOneId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const teamTwoId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const workspaceOneId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const workspaceTwoId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const actor = { userId: ownerUserId };
    const teamRows = new Map([
      [
        workspaceOneId,
        teamCandidate({
          candidateId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          logicalMemoryId: "10101010-1010-4010-8010-101010101010",
          pseudonymousSourceId: "team-one-source",
          text: "Team one decision.",
          score: 0.93
        })
      ],
      [
        workspaceTwoId,
        teamCandidate({
          candidateId: "12121212-1212-4212-8212-121212121212",
          logicalMemoryId: "13131313-1313-4313-8313-131313131313",
          pseudonymousSourceId: "team-two-source",
          text: "Team two decision.",
          score: 0.89
        })
      ]
    ]);
    const searchAuthorized = vi.fn(
      async (_actor: unknown, input: { teamWorkspaceId: string }) => [
        teamRows.get(input.teamWorkspaceId)!
      ]
    );
    const personalSearch = vi.fn(async () => ({
      results: [
        {
          nodeId: "14141414-1414-4414-8414-141414141414",
          sourceType: "memory_node" as const,
          sourceId: "personal-source",
          summaryText: "Personal preference.",
          visibility: "personal" as const,
          citation: {
            nodeId: "14141414-1414-4414-8414-141414141414",
            visibility: "personal" as const
          },
          score: 0.87
        }
      ],
      metadata: {}
    }));
    const accessibleWorkspaceContexts = [
      workspaceContext(teamOneId, workspaceOneId),
      workspaceContext(teamTwoId, workspaceTwoId)
    ];
    const freeze = vi.fn(
      async (_actor: unknown, input: { teamWorkspaceId: string }) =>
        teamBoundary(
          input.teamWorkspaceId === workspaceOneId ? teamOneId : teamTwoId,
          input.teamWorkspaceId,
          input.teamWorkspaceId === workspaceOneId
            ? "15151515-1515-4515-8515-151515151515"
            : "16161616-1616-4616-8616-161616161616"
        )
    );
    const repository = {
      listTeamWorkspaceContexts: vi.fn(async () => accessibleWorkspaceContexts),
      freezeSharedMemorySemanticRecallBoundary: freeze,
      searchAuthorizedSharedMemorySemanticItems: searchAuthorized,
      searchMemoryNodes: personalSearch
    } as never;

    const context = await buildPersonalAgentMemoryTurnContext({
      repository,
      ownerUserId,
      projectId: "project-7",
      projectName: "Koed",
      prompt: "What did we decide?",
      fetchFn: embeddingFetch
    });

    expect(context.status).toBe("available");
    expect(context.searchDomain).toBe("global");
    expect(context.evidence.map((item) => item.visibility)).toEqual([
      "personal",
      "team",
      "team"
    ]);
    expect(context.evidence.map((item) => item.summaryText)).toEqual([
      "Personal preference.",
      "Team one decision.",
      "Team two decision."
    ]);
    expect(repository.listTeamWorkspaceContexts).toHaveBeenCalledWith(actor);
    expect(freeze).toHaveBeenCalledTimes(2);
    expect(searchAuthorized).toHaveBeenCalledTimes(2);
    for (const [calledActor] of searchAuthorized.mock.calls) {
      expect(calledActor).toEqual(actor);
    }
    expect(
      searchAuthorized.mock.calls.map(([, input]) => input.teamWorkspaceId)
    ).toEqual(expect.arrayContaining([workspaceOneId, workspaceTwoId]));
    expect(personalSearch).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        scope: "personal",
        searchDomain: "global"
      })
    );
  });

  it("does not return another account's Team evidence", async () => {
    const authorizedOwner = agent.ownerUserId;
    const anotherOwner = "abababab-abab-4bab-8bab-abababababab";
    const teamId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const workspaceId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const searchAuthorized = vi.fn(async () => [
      teamCandidate({
        candidateId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        logicalMemoryId: "10101010-1010-4010-8010-101010101010",
        pseudonymousSourceId: "private-team-source",
        text: "Evidence owned by the other account.",
        score: 0.99
      })
    ]);
    const listTeamWorkspaceContexts = vi.fn(
      async (actor: { userId: string }) =>
        actor.userId === authorizedOwner
          ? [workspaceContext(teamId, workspaceId)]
          : []
    );
    const repository = {
      listTeamWorkspaceContexts,
      freezeSharedMemorySemanticRecallBoundary: vi.fn(async () =>
        teamBoundary(
          teamId,
          workspaceId,
          "15151515-1515-4515-8515-151515151515"
        )
      ),
      searchAuthorizedSharedMemorySemanticItems: searchAuthorized,
      searchMemoryNodes: vi.fn(async () => ({ results: [], metadata: {} }))
    } as never;

    const context = await buildPersonalAgentMemoryTurnContext({
      repository,
      ownerUserId: anotherOwner,
      projectId: null,
      prompt: "What is shared?",
      fetchFn: embeddingFetch
    });

    expect(listTeamWorkspaceContexts).toHaveBeenCalledWith({
      userId: anotherOwner
    });
    expect(searchAuthorized).not.toHaveBeenCalled();
    expect(context.evidence).toEqual([]);
    expect(context.status).toBe("available");
  });

  it("fails closed on revoked Team access and does not reuse a pre-regrant boundary", async () => {
    const teamId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const workspaceId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    let phase: "active" | "revoked" | "regranted" = "active";
    const searchAuthorized = vi.fn(
      async (
        _actor: unknown,
        input: { authorizationBoundary?: { shareGrantIds: string[] } }
      ) => [
        teamCandidate({
          candidateId:
            input.authorizationBoundary?.shareGrantIds[0] ===
            "21212121-2121-4121-8121-212121212121"
              ? "18181818-1818-4818-8818-181818181818"
              : "19191919-1919-4919-8919-191919191919",
          logicalMemoryId: "20202020-2020-4020-8020-202020202020",
          pseudonymousSourceId: `source-${phase}`,
          text: `Evidence ${phase}.`,
          score: 0.9
        })
      ]
    );
    const freeze = vi.fn(async () => {
      if (phase === "revoked") {
        throw Object.assign(new Error("Workspace access was revoked"), {
          statusCode: 403
        });
      }
      return teamBoundary(
        teamId,
        workspaceId,
        phase === "active"
          ? "17171717-1717-4717-8717-171717171717"
          : "21212121-2121-4121-8121-212121212121"
      );
    });
    const repository = {
      listTeamWorkspaceContexts: vi.fn(async () => [
        workspaceContext(teamId, workspaceId)
      ]),
      freezeSharedMemorySemanticRecallBoundary: freeze,
      searchAuthorizedSharedMemorySemanticItems: searchAuthorized,
      searchMemoryNodes: vi.fn(async () => ({ results: [], metadata: {} }))
    } as never;

    const original = await buildPersonalAgentMemoryTurnContext({
      repository,
      ownerUserId: agent.ownerUserId,
      projectId: null,
      prompt: "What was shared?",
      fetchFn: embeddingFetch
    });
    expect(original.evidence[0]?.citation).toMatchObject({
      visibility: "team",
      teamWorkspaceId: workspaceId
    });

    phase = "revoked";
    await expect(
      buildPersonalAgentMemoryTurnContext({
        repository,
        ownerUserId: agent.ownerUserId,
        projectId: null,
        prompt: "Continue without memory",
        continueWithoutMemory: true
      })
    ).rejects.toMatchObject({ statusCode: 403 });

    phase = "regranted";
    const afterRegrant = await buildPersonalAgentMemoryTurnContext({
      repository,
      ownerUserId: agent.ownerUserId,
      projectId: null,
      prompt: "What was shared again?",
      fetchFn: embeddingFetch
    });
    expect(afterRegrant.evidence[0]?.nodeId).toBe(
      "18181818-1818-4818-8818-181818181818"
    );
    expect(
      searchAuthorized.mock.calls[1]?.[1].authorizationBoundary
    ).toMatchObject({
      shareGrantIds: ["21212121-2121-4121-8121-212121212121"]
    });
    expect(searchAuthorized).toHaveBeenCalledTimes(2);
  });

  it("returns unavailable on transient Team failure and records a verified one-request skip", async () => {
    const teamId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const workspaceId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const searchAuthorized = vi.fn(async () => {
      throw new Error("temporary database failure");
    });
    const repository = {
      listTeamWorkspaceContexts: vi.fn(async () => [
        workspaceContext(teamId, workspaceId)
      ]),
      freezeSharedMemorySemanticRecallBoundary: vi.fn(async () =>
        teamBoundary(
          teamId,
          workspaceId,
          "17171717-1717-4717-8717-171717171717"
        )
      ),
      searchAuthorizedSharedMemorySemanticItems: searchAuthorized,
      searchMemoryNodes: vi.fn(async () => ({ results: [], metadata: {} }))
    } as never;
    const unavailable = await buildPersonalAgentMemoryTurnContext({
      repository,
      ownerUserId: agent.ownerUserId,
      projectId: null,
      prompt: "Question",
      fetchFn: embeddingFetch
    });
    expect(unavailable).toMatchObject({ status: "unavailable", evidence: [] });

    const skipped = await buildPersonalAgentMemoryTurnContext({
      repository,
      ownerUserId: agent.ownerUserId,
      projectId: null,
      prompt: "Question",
      continueWithoutMemory: true
    });
    expect(skipped).toMatchObject({ status: "skipped", evidence: [] });
    expect(searchAuthorized).toHaveBeenCalledOnce();
  });
});

describe("non-Agent managed-chat Memory context", () => {
  it("keeps Project-only Personal recall and never requests Team evidence", async () => {
    const searchMemoryNodes = vi.fn(async () => ({
      results: [
        {
          nodeId: "personal-node",
          sourceType: "memory_node" as const,
          sourceId: "personal-source",
          summaryText: "Personal evidence.",
          visibility: "personal" as const,
          citation: { nodeId: "personal-node", visibility: "personal" },
          score: 0.8
        },
        {
          nodeId: "team-node",
          summaryText: "Team evidence must not enter generic chats.",
          visibility: "team" as const,
          citation: { nodeId: "team-node", visibility: "team" },
          score: 0.99
        }
      ],
      metadata: {}
    }));
    const listTeamWorkspaceContexts = vi.fn(async () => [
      workspaceContext(
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
      )
    ]);
    const repository = {
      searchMemoryNodes,
      listTeamWorkspaceContexts
    } as never;

    const context = await buildPersonalMemoryTurnContext({
      repository,
      ownerUserId: agent.ownerUserId,
      projectId: "project-7",
      prompt: "Question"
    });

    expect(context.searchDomain).toBe("project");
    expect(context.evidence.map((item) => item.nodeId)).toEqual([
      "personal-node"
    ]);
    expect(searchMemoryNodes).toHaveBeenCalledWith(
      { userId: agent.ownerUserId },
      expect.objectContaining({ scope: "personal", searchDomain: "project" })
    );
    expect(listTeamWorkspaceContexts).not.toHaveBeenCalled();
  });
});
