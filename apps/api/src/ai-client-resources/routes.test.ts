import Fastify from "fastify";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiRouteContext } from "../server/context.js";
import { registerAiClientResourceRoutes } from "./routes.js";

const owner = randomUUID();
const localDevice = randomUUID();
const deployment = randomUUID();
const instanceId = "codex.work";
const operationId = randomUUID();
const requestId = randomUUID();
const hostedInstanceId = "runner.0123456789abcdef";
const now = new Date().toISOString();
const stacks: Array<{ app: ReturnType<typeof Fastify>; dir: string }> = [];

const operation = {
  operationId,
  requestId,
  hostedInstanceId,
  projectId: "lp_0123456789abcdef0123456789abcdef",
  state: "pending" as const,
  revision: 1,
  createdAt: now,
  updatedAt: now
};

const makeApp = (input: { local?: boolean; localTarget?: boolean } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "ai-client-resource-routes-"));
  const upstreamBackendsPath = join(dir, "upstream-backends.json");
  writeFileSync(
    upstreamBackendsPath,
    JSON.stringify({
      schemaVersion: 2,
      activeBackendId: "upstream",
      backends: [
        {
          id: "upstream",
          baseUrl: "https://koed.example.test",
          routePolicy: { managedExecution: "enabled" },
          credential: { status: "configured" },
          capabilities: {
            state: "validated",
            expiresAt: "2099-01-01T00:00:00.000Z",
            payload: {
              capabilities: {
                "memory.managedConversations": { availability: "available" }
              }
            }
          }
        }
      ]
    })
  );
  const fetch = vi.fn(async () =>
    Response.json({ error: "unexpected proxy" }, { status: 500 })
  );
  const target = {
    ownerUserId: owner,
    aiClientInstanceId: instanceId,
    sourceDeviceCredentialId: input.localTarget
      ? "00000000-0000-0000-0000-000000000000"
      : randomUUID(),
    hostedInstanceId,
    provider: "codex" as const,
    computerLabel: "MacBook Pro",
    targetDeviceId: localDevice,
    targetDeploymentId: deployment
  };
  const repository = {
    resolveAiClientResourceDiscoveryTarget: vi.fn(async () => target),
    createAiClientResourceDiscoveryOperation: vi.fn(async () => operation),
    getAiClientResourceDiscoveryOperation: vi.fn(async () => null)
  };
  const app = Fastify();
  const context = {
    config: {
      deploymentProfile: input.local ? "developer" : "team_self_hosted"
    },
    requireRepository: () => repository,
    auth: {
      authenticateSessionOrDeviceCredential: vi.fn(async () => ({ id: owner }))
    },
    deploymentIdentity: {
      inspect: () => ({
        health: "healthy",
        deploymentId: deployment,
        deviceInstanceId: localDevice
      })
    },
    localEdge: {
      upstreamBackendsPath,
      remoteOperationsAllowed: () => true,
      fetch,
      resolveUpstreamAuthorization: () => "Koed-Device test"
    }
  } as unknown as ApiRouteContext;
  registerAiClientResourceRoutes(app, context);
  stacks.push({ app, dir });
  return { app, fetch, repository };
};

afterEach(async () => {
  for (const stack of stacks.splice(0)) {
    await stack.app.close();
    rmSync(stack.dir, { recursive: true, force: true });
  }
});

describe("AI Client resource discovery routes", () => {
  it("creates an owner-scoped pending operation for an authorized instance and Project", async () => {
    const { app, repository } = makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/ai-client-resources/discover",
      headers: { cookie: "session=test" },
      payload: { hostedInstanceId, projectId: operation.projectId, requestId }
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual(operation);
    expect(
      repository.resolveAiClientResourceDiscoveryTarget
    ).toHaveBeenCalledWith(
      { userId: owner },
      { hostedInstanceId, localDeviceId: null, localDeploymentId: null }
    );
    expect(
      repository.createAiClientResourceDiscoveryOperation
    ).toHaveBeenCalledWith(
      { userId: owner },
      expect.objectContaining({ projectId: operation.projectId, requestId })
    );
  });

  it("keeps a locally registered instance local when a hosted authority is enrolled", async () => {
    const { app, fetch, repository } = makeApp({
      local: true,
      localTarget: true
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/ai-client-resources/discover",
      headers: { cookie: "session=test" },
      payload: { hostedInstanceId, projectId: operation.projectId, requestId }
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(
      repository.createAiClientResourceDiscoveryOperation
    ).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads operations by authenticated owner", async () => {
    const { app, repository } = makeApp();
    vi.mocked(
      repository.getAiClientResourceDiscoveryOperation
    ).mockResolvedValue(operation);
    const response = await app.inject({
      method: "GET",
      url: `/v1/ai-client-resources/discover/${operationId}`,
      headers: { cookie: "session=test" }
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual(operation);
    expect(
      repository.getAiClientResourceDiscoveryOperation
    ).toHaveBeenCalledWith({ userId: owner }, { operationId });
  });
});
