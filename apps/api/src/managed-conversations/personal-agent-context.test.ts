import { describe, expect, it, vi } from "vitest";
import { buildPersonalAgentTurnContext } from "./personal-agent-context.js";

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

describe("buildPersonalAgentTurnContext", () => {
  it("uses the execution Project as the recall boundary and drops non-Personal hits", async () => {
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
    expect(result.context.memory.searchDomain).toBe("project");
    expect(result.context.memory.evidence).toHaveLength(1);
    expect(searchMemoryNodes).toHaveBeenCalledWith(
      { userId: agent.ownerUserId },
      expect.objectContaining({
        scope: "personal",
        searchDomain: "project",
        projectId: "project-7"
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
});
