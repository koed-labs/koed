import { describe, expect, it, vi } from "vitest";
import { buildPersonalAgentTurnContext } from "./personal-agent-context.js";

const agent = {
  contractVersion: 1 as const,
  id: "22a6397c-fd63-4d0e-a049-976bc9363178",
  ownerUserId: "ab647003-4095-4a98-8515-c872ba78a717",
  name: "Mira",
  role: "Reviewer",
  avatarReference: "preset:reviewer",
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
  avatarReference: agent.avatarReference,
  defaultProvider: agent.defaultProvider,
  defaultModel: agent.defaultModel,
  defaultReasoningEffort: null,
  soulInstructions: "Legacy stored instructions are ignored.",
  instructionSource: "custom" as const,
  createdByUserId: agent.ownerUserId,
  createdAt: agent.createdAt
};

const makeRepository = (overrides: Record<string, unknown> = {}) => ({
  getPersonalAgentIdentity: vi.fn(async () => agent),
  getPersonalAgentPresentationVersion: vi.fn(async () => version),
  getPersonalAgent: vi.fn(async () => {
    throw new Error("execution preparation must not load Agent history");
  }),
  listLcmGraphThreads: vi.fn(async () => [
    {
      id: "project-7",
      name: "Koed",
      path: "/workspace/koed",
      eventCount: 2,
      threads: []
    }
  ]),
  searchMemoryNodes: vi.fn(),
  listTeamWorkspaceContexts: vi.fn(),
  ...overrides
});

describe("buildPersonalAgentTurnContext", () => {
  it("resolves presentation identity and Project attribution without eager Memory retrieval", async () => {
    const repository = makeRepository() as never;

    const result = await buildPersonalAgentTurnContext({
      repository,
      ownerUserId: agent.ownerUserId,
      agentId: agent.id,
      projectId: "project-7"
    });

    expect(result.expectedAgentVersion).toBe(4);
    expect(result.context).toEqual({
      schemaVersion: 1,
      identity: {
        agentId: agent.id,
        version: 4,
        identityVersionId: version.id,
        name: "Mira",
        role: "Reviewer",
        avatarReference: "preset:reviewer"
      },
      project: { projectId: "project-7", name: "Koed" }
    });
    expect(repository.listLcmGraphThreads).toHaveBeenCalledWith(
      { userId: agent.ownerUserId },
      { projectId: "project-7", limit: 1 }
    );
    expect(repository.getPersonalAgent).not.toHaveBeenCalled();
    expect(repository.searchMemoryNodes).not.toHaveBeenCalled();
    expect(repository.listTeamWorkspaceContexts).not.toHaveBeenCalled();
  });

  it("keeps an owner-verified Project reference when no Project name is available", async () => {
    const repository = makeRepository({
      listLcmGraphThreads: vi.fn(async () => [])
    }) as never;

    const result = await buildPersonalAgentTurnContext({
      repository,
      ownerUserId: agent.ownerUserId,
      agentId: agent.id,
      projectId: "project-empty"
    });

    expect(result.context.project).toEqual({
      projectId: "project-empty",
      name: null
    });
  });

  it("uses a null Project for a standalone conversation", async () => {
    const repository = makeRepository() as never;

    const result = await buildPersonalAgentTurnContext({
      repository,
      ownerUserId: agent.ownerUserId,
      agentId: agent.id,
      projectId: null
    });

    expect(result.context.project).toEqual({ projectId: null, name: null });
    expect(repository.listLcmGraphThreads).not.toHaveBeenCalled();
  });

  it("does not resolve another owner's or retired Agent", async () => {
    const otherOwnerRepository = makeRepository({
      getPersonalAgentIdentity: vi.fn(async () => null)
    }) as never;
    await expect(
      buildPersonalAgentTurnContext({
        repository: otherOwnerRepository,
        ownerUserId: agent.ownerUserId,
        agentId: agent.id,
        projectId: null
      })
    ).rejects.toMatchObject({ statusCode: 404 });

    const retiredRepository = makeRepository({
      getPersonalAgentIdentity: vi.fn(async () => ({
        ...agent,
        lifecycle: "retired" as const
      }))
    }) as never;
    await expect(
      buildPersonalAgentTurnContext({
        repository: retiredRepository,
        ownerUserId: agent.ownerUserId,
        agentId: agent.id,
        projectId: null
      })
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects a stale selected identity version before Project or Memory work", async () => {
    const repository = makeRepository() as never;

    await expect(
      buildPersonalAgentTurnContext({
        repository,
        ownerUserId: agent.ownerUserId,
        agentId: agent.id,
        expectedAgentVersion: 3,
        projectId: "project-7"
      })
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(
      repository.getPersonalAgentPresentationVersion
    ).not.toHaveBeenCalled();
    expect(repository.getPersonalAgent).not.toHaveBeenCalled();
    expect(repository.listLcmGraphThreads).not.toHaveBeenCalled();
    expect(repository.searchMemoryNodes).not.toHaveBeenCalled();
  });
});
