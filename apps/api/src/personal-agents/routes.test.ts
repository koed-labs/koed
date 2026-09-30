import Fastify from "fastify";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
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

const writePersonalAgentUpstreamRegistry = (
  routePolicy: "enabled" | "disabled" = "enabled"
): string => {
  const path = resolve(
    mkdtempSync(resolve(tmpdir(), "koed-personal-agent-upstream-")),
    "upstream-backends.json"
  );
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 2,
      updatedAt: "2026-09-22T10:00:00.000Z",
      activeBackendId: "personal-authority",
      backends: [
        {
          id: "personal-authority",
          displayName: "Personal authority",
          baseUrl: "https://personal.example.test/koed",
          profile: "private_vps",
          createdAt: "2026-09-22T10:00:00.000Z",
          updatedAt: "2026-09-22T10:00:00.000Z",
          routePolicy: { managedExecution: routePolicy },
          credential: { status: "configured" },
          capabilities: {
            state: "validated",
            checkedAt: "2026-09-22T10:00:00.000Z",
            expiresAt: "2099-09-22T10:00:00.000Z",
            schemaVersion: 3,
            profile: "private_vps",
            payload: {
              capabilities: {
                "memory.managedConversations": {
                  availability: "available"
                }
              }
            }
          }
        }
      ]
    })
  );
  return path;
};

const buildFixture = async (
  deploymentProfile = "developer",
  options: {
    upstreamBackendsPath?: string;
    remoteOperationsAllowed?: boolean;
    upstreamAuthorization?: string | null;
    fetch?: typeof globalThis.fetch;
    ownerId?: string;
  } = {}
) => {
  const authenticatedOwnerId = options.ownerId ?? ownerId;
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
    restorePersonalAgent: vi.fn(async () => identity()),
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
  const auth = {
    authenticate: vi.fn(async () => ({
      id: authenticatedOwnerId,
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
        id: authenticatedOwnerId,
        email: "owner@example.test",
        displayName: "Owner"
      };
    }),
    authenticateSessionOrDeviceCredential: vi.fn(async () => ({
      id: authenticatedOwnerId,
      email: "owner@example.test",
      displayName: "Owner"
    }))
  };
  registerPersonalAgentRoutes(app, {
    config: { deploymentProfile },
    requireRepository: () => repository,
    auth,
    localEdge: {
      upstreamBackendsPath:
        options.upstreamBackendsPath ??
        resolve(tmpdir(), `koed-no-upstream-${randomUUID()}.json`),
      remoteOperationsAllowed: () => options.remoteOperationsAllowed ?? true,
      resolveUpstreamAuthorization: () =>
        options.upstreamAuthorization === undefined
          ? "Koed-Device fixture:secret"
          : options.upstreamAuthorization,
      fetch: options.fetch ?? globalThis.fetch
    },
    rateLimit: {
      memoryRead: async () => undefined,
      personalAgentControl: async () => undefined,
      memoryWrite: async () => undefined
    }
  } as unknown as ApiRouteContext);
  await app.ready();
  return { app, repository, auth };
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

  it("surfaces normalized name conflicts as useful 409 responses", async () => {
    const fixture = await buildFixture();
    vi.mocked(fixture.repository.createPersonalAgent).mockRejectedValue(
      Object.assign(new Error("database constraint details"), {
        code: "PERSONAL_AGENT_NAME_CONFLICT"
      })
    );
    const response = await fixture.app.inject({
      method: "POST",
      url: "/v1/personal-agents",
      payload: {
        requestId: randomUUID(),
        name: "Planner",
        soulInstructions: "Plan carefully.",
        defaultProvider: null,
        defaultModel: null
      }
    });
    await fixture.app.close();

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error:
        "A Personal Agent with this name or a previous name already exists for this account"
    });
  });

  it("stores an unavailable saved default as account-owned profile data", async () => {
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

    expect(response.statusCode).toBe(200);
    expect(fixture.repository.createPersonalAgent).toHaveBeenCalledWith(
      { userId: ownerId },
      expect.objectContaining({
        defaultProvider: "codex",
        defaultModel: "missing-model"
      })
    );
  });

  it("creates a Personal Agent with no saved provider or model", async () => {
    const fixture = await buildFixture();
    const response = await fixture.app.inject({
      method: "POST",
      url: "/v1/personal-agents",
      payload: {
        requestId: randomUUID(),
        name: "Planner",
        soulInstructions: "Plan carefully."
      }
    });
    await fixture.app.close();

    expect(response.statusCode).toBe(200);
    expect(fixture.repository.createPersonalAgent).toHaveBeenCalledWith(
      { userId: ownerId },
      expect.objectContaining({ defaultProvider: null, defaultModel: null })
    );
    expect(fixture.repository.listAiClientInstances).not.toHaveBeenCalled();
  });

  it("rejects a saved reasoning effort without provider and model defaults", async () => {
    const fixture = await buildFixture();
    const response = await fixture.app.inject({
      method: "POST",
      url: "/v1/personal-agents",
      payload: {
        requestId: randomUUID(),
        name: "Planner",
        soulInstructions: "Plan carefully.",
        defaultProvider: null,
        defaultModel: null,
        defaultReasoningEffort: "high"
      }
    });
    await fixture.app.close();

    expect(response.statusCode).toBe(400);
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

  it("clears both provider and model defaults together", async () => {
    const fixture = await buildFixture();
    const response = await fixture.app.inject({
      method: "PATCH",
      url: `/v1/personal-agents/${agentId}`,
      payload: {
        requestId: randomUUID(),
        expectedVersion: 1,
        defaultProvider: null,
        defaultModel: null,
        defaultReasoningEffort: null
      }
    });
    await fixture.app.close();

    expect(response.statusCode).toBe(200);
    expect(fixture.repository.updatePersonalAgent).toHaveBeenCalledWith(
      { userId: ownerId },
      expect.objectContaining({ defaultProvider: null, defaultModel: null })
    );
  });

  it("requires effort to be cleared when provider and model defaults are cleared", async () => {
    const fixture = await buildFixture();
    const response = await fixture.app.inject({
      method: "PATCH",
      url: `/v1/personal-agents/${agentId}`,
      payload: {
        requestId: randomUUID(),
        expectedVersion: 1,
        defaultProvider: null,
        defaultModel: null
      }
    });
    await fixture.app.close();

    expect(response.statusCode).toBe(400);
    expect(fixture.repository.updatePersonalAgent).not.toHaveBeenCalled();
  });

  it("rejects a partial clear of the paired defaults", async () => {
    const fixture = await buildFixture();
    const response = await fixture.app.inject({
      method: "PATCH",
      url: `/v1/personal-agents/${agentId}`,
      payload: {
        requestId: randomUUID(),
        expectedVersion: 1,
        defaultProvider: null
      }
    });
    await fixture.app.close();

    expect(response.statusCode).toBe(400);
    expect(fixture.repository.updatePersonalAgent).not.toHaveBeenCalled();
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

  it("forwards version-checked restore to the owner-scoped repository", async () => {
    const fixture = await buildFixture();
    const requestId = randomUUID();
    const response = await fixture.app.inject({
      method: "POST",
      url: `/v1/personal-agents/${agentId}/restore`,
      payload: { requestId, expectedVersion: 1 }
    });
    await fixture.app.close();

    expect(response.statusCode).toBe(200);
    expect(fixture.repository.restorePersonalAgent).toHaveBeenCalledWith({
      actor: { userId: ownerId },
      agentId,
      requestId,
      expectedVersion: 1
    });
  });

  it("surfaces reused restore request IDs as safe 409 responses", async () => {
    const fixture = await buildFixture();
    vi.mocked(fixture.repository.restorePersonalAgent).mockRejectedValue(
      Object.assign(new Error("database constraint details"), {
        code: "IDEMPOTENCY_CONFLICT"
      })
    );
    const response = await fixture.app.inject({
      method: "POST",
      url: `/v1/personal-agents/${agentId}/restore`,
      payload: { requestId: randomUUID(), expectedVersion: 1 }
    });
    await fixture.app.close();

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "Personal Agent request conflicts with existing state"
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

  it("uses the managed authority for the full Personal Agent library when configured", async () => {
    const upstreamPath = writePersonalAgentUpstreamRegistry();
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ authority: "hosted" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    );
    const fixture = await buildFixture("developer", {
      upstreamBackendsPath: upstreamPath,
      fetch
    });
    const createBody = {
      requestId: randomUUID(),
      name: "Hosted Planner",
      role: "",
      avatarReference: null,
      soulInstructions: "Plan carefully.",
      defaultProvider: null,
      defaultModel: null,
      defaultReasoningEffort: null,
      sourceTemplateId: "code-reviewer",
      sourceTemplateVersion: 1
    };
    const updateBody = {
      requestId: randomUUID(),
      expectedVersion: 1,
      name: "Updated Planner"
    };
    const lifecycleBody = {
      requestId: randomUUID(),
      expectedVersion: 1
    };
    const requests = [
      { method: "GET", url: "/v1/personal-agent-role-templates" },
      { method: "GET", url: "/v1/personal-agents/capabilities" },
      { method: "GET", url: "/v1/personal-agents" },
      { method: "GET", url: `/v1/personal-agents/${agentId}` },
      {
        method: "POST",
        url: "/v1/personal-agents",
        payload: createBody
      },
      {
        method: "PATCH",
        url: `/v1/personal-agents/${agentId}`,
        payload: updateBody
      },
      {
        method: "POST",
        url: `/v1/personal-agents/${agentId}/retire`,
        payload: lifecycleBody
      },
      {
        method: "POST",
        url: `/v1/personal-agents/${agentId}/restore`,
        payload: lifecycleBody
      }
    ] as const;

    try {
      for (const request of requests) {
        const response = await fixture.app.inject({
          ...request,
          headers: { authorization: "Bearer local-personal-token" }
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ authority: "hosted" });
      }

      expect(fetch).toHaveBeenCalledTimes(requests.length);
      expect(
        fetch.mock.calls.map(([url, init]) => ({
          method: init?.method,
          pathname: new URL(String(url)).pathname,
          authorization: new Headers(init?.headers).get("authorization"),
          body: init?.body ? JSON.parse(String(init.body)) : undefined
        }))
      ).toEqual([
        {
          method: "GET",
          pathname: "/koed/v1/personal-agent-role-templates",
          authorization: "Koed-Device fixture:secret",
          body: undefined
        },
        {
          method: "GET",
          pathname: "/koed/v1/personal-agents/capabilities",
          authorization: "Koed-Device fixture:secret",
          body: undefined
        },
        {
          method: "GET",
          pathname: "/koed/v1/personal-agents",
          authorization: "Koed-Device fixture:secret",
          body: undefined
        },
        {
          method: "GET",
          pathname: `/koed/v1/personal-agents/${agentId}`,
          authorization: "Koed-Device fixture:secret",
          body: undefined
        },
        {
          method: "POST",
          pathname: "/koed/v1/personal-agents",
          authorization: "Koed-Device fixture:secret",
          body: createBody
        },
        {
          method: "PATCH",
          pathname: `/koed/v1/personal-agents/${agentId}`,
          authorization: "Koed-Device fixture:secret",
          body: updateBody
        },
        {
          method: "POST",
          pathname: `/koed/v1/personal-agents/${agentId}/retire`,
          authorization: "Koed-Device fixture:secret",
          body: lifecycleBody
        },
        {
          method: "POST",
          pathname: `/koed/v1/personal-agents/${agentId}/restore`,
          authorization: "Koed-Device fixture:secret",
          body: lifecycleBody
        }
      ]);
      expect(fixture.repository.listPersonalAgents).not.toHaveBeenCalled();
      expect(fixture.repository.createPersonalAgent).not.toHaveBeenCalled();
      expect(fixture.repository.updatePersonalAgent).not.toHaveBeenCalled();
      expect(fixture.repository.retirePersonalAgent).not.toHaveBeenCalled();
      expect(fixture.repository.restorePersonalAgent).not.toHaveBeenCalled();
      expect(
        fixture.repository.getPersonalAgentRoleTemplate
      ).not.toHaveBeenCalled();
    } finally {
      await fixture.app.close();
    }
  });

  it("fails closed instead of using the local Agent library when hosted authority is unavailable", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const fixture = await buildFixture("developer", {
      upstreamBackendsPath: writePersonalAgentUpstreamRegistry(),
      remoteOperationsAllowed: false,
      fetch
    });
    const response = await fixture.app.inject({
      method: "GET",
      url: "/v1/personal-agents",
      headers: { authorization: "Bearer local-personal-token" }
    });
    await fixture.app.close();

    expect(response.statusCode).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
    expect(fixture.repository.listPersonalAgents).not.toHaveBeenCalled();
  });

  it("does not fall back locally when the configured hosted credential is missing", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const fixture = await buildFixture("developer", {
      upstreamBackendsPath: writePersonalAgentUpstreamRegistry(),
      upstreamAuthorization: null,
      fetch
    });
    const response = await fixture.app.inject({
      method: "GET",
      url: "/v1/personal-agents",
      headers: { authorization: "Bearer local-personal-token" }
    });
    await fixture.app.close();

    expect(response.statusCode).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
    expect(fixture.repository.listPersonalAgents).not.toHaveBeenCalled();
  });

  it("does not expose a same-ID local Agent when hosted owner lookup returns not found", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ error: "Personal Agent not found" }), {
          status: 404,
          headers: { "content-type": "application/json" }
        })
    );
    const fixture = await buildFixture("developer", {
      upstreamBackendsPath: writePersonalAgentUpstreamRegistry(),
      fetch
    });
    const response = await fixture.app.inject({
      method: "GET",
      url: `/v1/personal-agents/${agentId}`,
      headers: { authorization: "Bearer local-personal-token" }
    });
    await fixture.app.close();

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Personal Agent not found" });
    expect(fixture.repository.getPersonalAgent).not.toHaveBeenCalled();
    expect(fixture.repository.getPersonalAgentVersion).not.toHaveBeenCalled();
  });

  it("uses the local Agent library when no managed remote authority is configured", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const fixture = await buildFixture("developer", { fetch });
    const response = await fixture.app.inject({
      method: "GET",
      url: "/v1/personal-agents",
      headers: { authorization: "Bearer local-personal-token" }
    });
    await fixture.app.close();

    expect(response.statusCode).toBe(200);
    expect(fixture.repository.listPersonalAgents).toHaveBeenCalledWith(
      { userId: ownerId },
      { includeRetired: true }
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("allows only scoped managed-execution device credentials on hosted Agent routes", async () => {
    const hostedOwnerId = randomUUID();
    const fixture = await buildFixture("private_vps", {
      ownerId: hostedOwnerId
    });
    const response = await fixture.app.inject({
      method: "GET",
      url: "/v1/personal-agents",
      headers: { authorization: "Koed-Device upstream:credential" }
    });
    await fixture.app.close();

    expect(response.statusCode).toBe(200);
    expect(
      fixture.auth.authenticateSessionOrDeviceCredential
    ).toHaveBeenCalledWith(expect.anything(), "managed_execution");
    expect(fixture.repository.listPersonalAgents).toHaveBeenCalledWith(
      { userId: hostedOwnerId },
      { includeRetired: true }
    );
  });
});
