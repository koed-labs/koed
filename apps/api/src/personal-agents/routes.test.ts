import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { MemorySourceRepository } from "@koed/db";
import type { ApiRouteContext } from "../server/context.js";
import {
  registerPersonalAgentRoutes,
  type PersonalAgentDetail
} from "./routes.js";

const ownerId = "a7df776f-74d7-4d8d-b941-a8fed118eba1";
const agentId = "7bd960fe-6ff0-4bff-8101-4232aa61cb69";

const identity = () => ({
  contractVersion: 1 as const,
  id: agentId,
  ownerUserId: ownerId,
  name: "Planner",
  role: "Planning assistant",
  avatarReference: "preset:planner",
  lifecycle: "active" as const,
  defaultProvider: "codex",
  defaultModel: "gpt-test",
  defaultReasoningEffort: "high",
  currentVersion: 1,
  createdAt: "2026-09-22T10:00:00.000Z",
  updatedAt: "2026-09-22T10:00:00.000Z",
  retiredAt: null
});

const detail = (): PersonalAgentDetail => ({
  agent: identity(),
  soulInstructions: "Plan carefully.",
  history: {
    stats: {
      projects: 0,
      runningNow: 0,
      jobsLogged: 0
    },
    jobs: [],
    jobsHasMore: false,
    jobsNextCursor: null,
    projects: []
  }
});

const capabilityInstance = {
  ownerUserId: ownerId,
  instanceId: "codex.default",
  driverId: "codex",
  displayName: "Codex",
  configIdentityHash: "config-hash",
  enabled: true,
  createdAt: "2026-09-22T10:00:00.000Z",
  updatedAt: "2026-09-22T10:00:00.000Z"
};

const capabilitySnapshot = {
  id: randomUUID(),
  ownerUserId: ownerId,
  instanceId: "codex.default",
  installationIdentityHash: "config-hash",
  clientVersion: "1.0.0",
  authenticationState: "authenticated" as const,
  healthState: "healthy" as const,
  models: [
    {
      id: "gpt-test",
      displayName: "GPT Test",
      provider: "openai",
      supportedReasoningEfforts: ["high"]
    }
  ],
  capabilities: {
    descriptors: {
      managed_conversation_start: {
        support: "supported",
        readiness: "ready"
      }
    }
  },
  observedAt: "2026-09-22T10:00:00.000Z",
  expiresAt: "2099-09-22T10:00:00.000Z",
  createdAt: "2026-09-22T10:00:00.000Z"
};

const buildFixture = async (deploymentProfile = "developer") => {
  const repository = {
    listPersonalAgents: vi.fn(async () => [identity()]),
    listPersonalAgentRoleTemplates: vi.fn(async () => []),
    getPersonalAgentRoleTemplate: vi.fn(async () => null),
    getPersonalAgent: vi.fn(async () => detail()),
    getPersonalAgentVersion: vi.fn(async () => ({
      contractVersion: 1 as const,
      id: randomUUID(),
      agentId,
      ownerUserId: ownerId,
      version: 1,
      name: "Planner",
      role: "Planning assistant",
      avatarReference: "preset:planner",
      defaultProvider: "codex",
      defaultModel: "gpt-test",
      defaultReasoningEffort: "high",
      soulInstructions: "Plan carefully.",
      instructionSource: "custom" as const,
      sourceTemplateId: null,
      sourceTemplateVersion: null,
      createdByUserId: ownerId,
      createdAt: "2026-09-22T10:00:00.000Z"
    })),
    createPersonalAgent: vi.fn(async () => detail()),
    updatePersonalAgent: vi.fn(async () => detail()),
    retirePersonalAgent: vi.fn(async () => identity()),
    listAiClientInstances: vi.fn(async () => [capabilityInstance]),
    listCurrentAiClientCapabilitySnapshots: vi.fn(async () => [
      capabilitySnapshot
    ])
  } as unknown as MemorySourceRepository;
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    const statusCode =
      error instanceof z.ZodError
        ? 400
        : error instanceof Error &&
            typeof error === "object" &&
            "statusCode" in error &&
            typeof error.statusCode === "number"
          ? error.statusCode
          : 500;
    return reply.status(statusCode).send({ error: error.message });
  });
  registerPersonalAgentRoutes(app, {
    config: { deploymentProfile },
    requireRepository: () => repository,
    auth: {
      authenticate: vi.fn(async () => ({
        id: ownerId,
        email: "owner@example.test",
        displayName: "Owner"
      })),
      authenticateSession: vi.fn(async (request) => {
        if (request.headers.authorization) {
          throw Object.assign(new Error("Session cookie required"), {
            statusCode: 401
          });
        }
        return {
          id: ownerId,
          email: "owner@example.test",
          displayName: "Owner"
        };
      })
    },
    rateLimit: {
      memoryRead: async () => undefined,
      personalAgentControl: async () => undefined,
      memoryWrite: async () => undefined
    }
  } as unknown as ApiRouteContext);
  await app.ready();
  return { app, repository };
};

describe("Personal Agent API", () => {
  it("lists published role templates through authenticated catalogue reads", async () => {
    const fixture = await buildFixture();
    vi.mocked(
      fixture.repository.listPersonalAgentRoleTemplates
    ).mockResolvedValue([
      {
        id: "code-reviewer",
        version: 1,
        title: "Code Reviewer",
        role: "Code reviewer",
        soulInstructions: "Reviewed instructions",
        contentSha256: "a".repeat(64)
      }
    ]);
    const response = await fixture.app.inject({
      method: "GET",
      url: "/v1/personal-agent-role-templates"
    });
    await fixture.app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json().templates[0]).toMatchObject({
      id: "code-reviewer",
      version: 1
    });
  });

  it("requires an exact published template version when creating from a template", async () => {
    const fixture = await buildFixture();
    vi.mocked(
      fixture.repository.getPersonalAgentRoleTemplate
    ).mockResolvedValue({
      id: "code-reviewer",
      version: 1,
      title: "Code Reviewer",
      role: "Code reviewer",
      soulInstructions: "Original template content",
      contentSha256: "a".repeat(64)
    });
    const response = await fixture.app.inject({
      method: "POST",
      url: "/v1/personal-agents",
      payload: {
        requestId: randomUUID(),
        name: "Review",
        role: "Code reviewer",
        soulInstructions: "Edited independent copy",
        defaultProvider: "codex",
        defaultModel: "gpt-test",
        defaultReasoningEffort: "high",
        sourceTemplateId: "code-reviewer",
        sourceTemplateVersion: 1
      }
    });
    await fixture.app.close();

    expect(response.statusCode).toBe(200);
    expect(fixture.repository.createPersonalAgent).toHaveBeenCalledWith(
      { userId: ownerId },
      expect.objectContaining({
        soulInstructions: "Edited independent copy",
        sourceTemplateId: "code-reviewer",
        sourceTemplateVersion: 1
      })
    );
  });

  it("lists only the authenticated owner's public identities", async () => {
    const fixture = await buildFixture();
    const response = await fixture.app.inject({
      method: "GET",
      url: "/v1/personal-agents"
    });
    await fixture.app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      agents: [
        expect.objectContaining({
          id: agentId,
          name: "Planner",
          defaultProvider: "codex"
        })
      ]
    });
    expect(fixture.repository.listPersonalAgents).toHaveBeenCalledWith(
      { userId: ownerId },
      { includeRetired: true }
    );
  });

  it("requires a version and stable request id for updates", async () => {
    const fixture = await buildFixture();
    const response = await fixture.app.inject({
      method: "PATCH",
      url: `/v1/personal-agents/${agentId}`,
      payload: { name: "Renamed" }
    });
    await fixture.app.close();

    expect(response.statusCode).toBe(400);
    expect(fixture.repository.updatePersonalAgent).not.toHaveBeenCalled();
  });

  it("rejects incomplete and mixed template provenance updates", async () => {
    const fixture = await buildFixture();
    const common = {
      requestId: randomUUID(),
      expectedVersion: 1,
      name: "Review"
    };
    const responses = await Promise.all([
      fixture.app.inject({
        method: "PATCH",
        url: `/v1/personal-agents/${agentId}`,
        payload: { ...common, sourceTemplateId: "backend-engineer" }
      }),
      fixture.app.inject({
        method: "PATCH",
        url: `/v1/personal-agents/${agentId}`,
        payload: { ...common, sourceTemplateId: null, sourceTemplateVersion: 1 }
      }),
      fixture.app.inject({
        method: "PATCH",
        url: `/v1/personal-agents/${agentId}`,
        payload: {
          ...common,
          sourceTemplateId: "backend-engineer",
          sourceTemplateVersion: null
        }
      })
    ]);
    await fixture.app.close();

    expect(responses.map((response) => response.statusCode)).toEqual([
      400, 400, 400
    ]);
    expect(fixture.repository.updatePersonalAgent).not.toHaveBeenCalled();
  });

  it("surfaces repository idempotency conflicts as safe 409 responses", async () => {
    const fixture = await buildFixture();
    vi.mocked(fixture.repository.createPersonalAgent).mockRejectedValue(
      Object.assign(new Error("database constraint details"), {
        statusCode: 409,
        code: "personal_agent_request_conflict"
      })
    );
    const response = await fixture.app.inject({
      method: "POST",
      url: "/v1/personal-agents",
      payload: {
        requestId: randomUUID(),
        name: "Planner",
        role: "Planning assistant",
        soulInstructions: "Plan carefully.",
        defaultProvider: "codex",
        defaultModel: "gpt-test",
        defaultReasoningEffort: null
      }
    });
    await fixture.app.close();

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "Personal Agent request conflicts with existing state"
    });
  });

  it("validates defaults against a healthy AI Client capability snapshot", async () => {
    const fixture = await buildFixture();
    const response = await fixture.app.inject({
      method: "POST",
      url: "/v1/personal-agents",
      payload: {
        requestId: randomUUID(),
        name: "Planner",
        role: "Planning assistant",
        avatarReference: null,
        soulInstructions: "Plan carefully.",
        defaultProvider: "codex",
        defaultModel: "missing-model",
        defaultReasoningEffort: null
      }
    });
    await fixture.app.close();

    expect(response.statusCode).toBe(409);
    expect(fixture.repository.createPersonalAgent).not.toHaveBeenCalled();
  });

  it("requires a concrete role and soul when creating an agent", async () => {
    const fixture = await buildFixture();
    const response = await fixture.app.inject({
      method: "POST",
      url: "/v1/personal-agents",
      payload: {
        requestId: randomUUID(),
        name: "Planner",
        role: null,
        defaultProvider: "codex",
        defaultModel: "gpt-test",
        defaultReasoningEffort: null
      }
    });
    const missingSoul = await fixture.app.inject({
      method: "POST",
      url: "/v1/personal-agents",
      payload: {
        requestId: randomUUID(),
        name: "Planner",
        role: "Planning assistant",
        defaultProvider: "codex",
        defaultModel: "gpt-test",
        defaultReasoningEffort: null
      }
    });
    await fixture.app.close();

    expect(response.statusCode).toBe(400);
    expect(missingSoul.statusCode).toBe(400);
    expect(fixture.repository.createPersonalAgent).not.toHaveBeenCalled();
  });

  it("allows metadata edits when unchanged defaults are temporarily offline", async () => {
    const fixture = await buildFixture();
    vi.mocked(fixture.repository.listAiClientInstances).mockResolvedValue([]);
    vi.mocked(
      fixture.repository.listCurrentAiClientCapabilitySnapshots
    ).mockResolvedValue([]);
    const response = await fixture.app.inject({
      method: "PATCH",
      url: `/v1/personal-agents/${agentId}`,
      payload: {
        requestId: randomUUID(),
        expectedVersion: 1,
        name: "Renamed Planner",
        defaultProvider: "codex",
        defaultModel: "gpt-test",
        defaultReasoningEffort: "high"
      }
    });
    await fixture.app.close();

    expect(response.statusCode).toBe(200);
    expect(fixture.repository.listAiClientInstances).not.toHaveBeenCalled();
    expect(fixture.repository.updatePersonalAgent).toHaveBeenCalledWith(
      { userId: ownerId },
      expect.objectContaining({
        agentId,
        expectedVersion: 1,
        defaultProvider: "codex",
        defaultModel: "gpt-test"
      })
    );
  });

  it("publishes provider and instance identity with ready models", async () => {
    const fixture = await buildFixture();
    const response = await fixture.app.inject({
      method: "GET",
      url: "/v1/personal-agents/capabilities"
    });
    await fixture.app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json().models).toEqual([
      expect.objectContaining({
        id: "gpt-test",
        provider: "codex",
        instanceId: "codex.default",
        supportedReasoningEfforts: ["high"]
      })
    ]);
  });

  it("returns retained activity records without synthesizing jobs", async () => {
    const fixture = await buildFixture();
    const response = await fixture.app.inject({
      method: "GET",
      url: `/v1/personal-agents/${agentId}`
    });
    await fixture.app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      agent: { id: agentId },
      soulInstructions: "Plan carefully.",
      stats: { projects: 0, runningNow: 0, jobsLogged: 0 },
      jobs: [],
      jobsHasMore: false,
      jobsNextCursor: null,
      projects: []
    });
  });

  it("forwards version-checked retirement to the owner-scoped repository", async () => {
    const fixture = await buildFixture();
    const requestId = randomUUID();
    const response = await fixture.app.inject({
      method: "POST",
      url: `/v1/personal-agents/${agentId}/retire`,
      payload: { requestId, expectedVersion: 1 }
    });
    await fixture.app.close();

    expect(response.statusCode).toBe(200);
    expect(fixture.repository.retirePersonalAgent).toHaveBeenCalledWith({
      actor: { userId: ownerId },
      agentId,
      requestId,
      expectedVersion: 1
    });
  });

  it("uses the local API-token auth path for local profiles", async () => {
    const fixture = await buildFixture("developer");
    const response = await fixture.app.inject({
      method: "GET",
      url: "/v1/personal-agents",
      headers: { authorization: "Bearer local-personal-token" }
    });
    await fixture.app.close();

    expect(response.statusCode).toBe(200);
  });

  it("does not accept a Personal API token on hosted profiles", async () => {
    const fixture = await buildFixture("private_vps");
    const response = await fixture.app.inject({
      method: "GET",
      url: "/v1/personal-agents",
      headers: { authorization: "Bearer hosted-token" }
    });
    await fixture.app.close();

    expect(response.statusCode).toBe(401);
  });
});
