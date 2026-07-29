import { generateKeyPairSync, randomUUID } from "node:crypto";

import Fastify, { type FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { ApiRouteContext } from "../server/context.js";
import { registerManagedConversationRunnerRoutes } from "./runner-routes.js";

const ids = {
  user: randomUUID(),
  credential: randomUUID(),
  deployment: randomUUID(),
  otherDeployment: randomUUID(),
  device: randomUUID(),
  otherDevice: randomUUID(),
  execution: randomUUID(),
  handoff: randomUUID(),
  fork: randomUUID(),
  snapshot: randomUUID(),
  otherSnapshot: randomUUID(),
  other: randomUUID(),
  sourceGeneration: randomUUID()
};
const recipientKeyId = randomUUID();
const recipientPublicJwk = generateKeyPairSync("rsa", {
  modulusLength: 2048
}).publicKey.export({ format: "jwk" });

const buildServer = async (options?: {
  operationFamilies?: string[];
  protocolDeploymentId?: string | null;
  repository?: Record<string, unknown>;
}) => {
  const repository = {
    claimManagedConversationCommands: vi.fn(async () => []),
    listManagedConversationExecutionsForRunner: vi.fn(async () => []),
    reconcileAbandonedManagedConversationCommands: vi.fn(async () => 0),
    getManagedConversationExecution: vi.fn(async () => null),
    getManagedConversationHandoff: vi.fn(async () => null),
    getLatestManagedConversationHandoffForExecution: vi.fn(async () => null),
    getManagedConversationFork: vi.fn(async () => null),
    ...options?.repository
  };
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const candidate =
      typeof error === "object" && error !== null && "statusCode" in error
        ? error.statusCode
        : undefined;
    reply
      .status(
        error instanceof z.ZodError
          ? 400
          : typeof candidate === "number"
            ? candidate
            : 500
      )
      .send({
        error:
          error instanceof z.ZodError
            ? "Invalid request payload"
            : error instanceof Error
              ? error.message
              : String(error)
      });
  });
  registerManagedConversationRunnerRoutes(app, {
    requireRepository: () => repository,
    auth: {
      authenticateDeviceCredential: async (request: FastifyRequest) => {
        if (
          request.headers.authorization !==
          "Koed-Device runner-key:runner-secret"
        ) {
          throw Object.assign(new Error("Device credential required"), {
            statusCode: 401
          });
        }
        return {
          user: {
            id: ids.user,
            email: "alice@example.invalid",
            displayName: "Alice",
            passwordHash: null
          },
          credential: {
            id: ids.credential,
            ownerUserId: ids.user,
            enrollmentChallengeId: null,
            credentialKeyId: "runner-key",
            upstreamBackendId: "personal-authority",
            deviceInstanceId: ids.device,
            lineageId: randomUUID(),
            deviceLabel: "Alice device",
            credentialVersion: 1,
            verifierKind: "secret_hash",
            operationFamilies: options?.operationFamilies ?? [
              "managed_execution",
              "sync"
            ],
            metadata:
              options?.protocolDeploymentId === null
                ? {}
                : {
                    protocolDeploymentId:
                      options?.protocolDeploymentId ?? ids.deployment
                  },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            lastUsedAt: null,
            lastValidatedAt: null,
            expiresAt: null,
            revokedAt: null,
            revokedByUserId: null,
            revocationReason: null
          }
        };
      }
    },
    rateLimit: {
      memoryRead: async () => undefined,
      memoryWrite: async () => undefined
    },
    encryption: {},
    managedConversations: { commandWakePool: null }
  } as unknown as ApiRouteContext);
  await app.ready();
  return { app, repository };
};

const runnerHeaders = {
  authorization: "Koed-Device runner-key:runner-secret"
};

describe("managed Conversation runner routes", () => {
  it("reports exact authority source readiness for the authenticated owner", async () => {
    const readiness = vi.fn(async () => true);
    const fixture = await buildServer({
      repository: {
        isManagedConversationSourceGenerationReady: readiness
      }
    });
    const response = await fixture.app.inject({
      method: "GET",
      url: `/v1/managed-conversation-runner/source-replicas/${ids.sourceGeneration}/status`,
      headers: runnerHeaders
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ready: true });
    expect(readiness).toHaveBeenCalledWith({
      ownerUserId: ids.user,
      sourceGenerationId: ids.sourceGeneration,
      readiness: "finalized"
    });
    await fixture.app.close();
  });

  it("distinguishes active registration readiness from finalized source readiness", async () => {
    const readiness = vi.fn(async () => true);
    const fixture = await buildServer({
      repository: {
        isManagedConversationSourceGenerationReady: readiness
      }
    });
    const response = await fixture.app.inject({
      method: "GET",
      url: `/v1/managed-conversation-runner/source-replicas/${ids.sourceGeneration}/status?readiness=registered`,
      headers: runnerHeaders
    });

    expect(response.statusCode).toBe(200);
    expect(readiness).toHaveBeenCalledWith({
      ownerUserId: ids.user,
      sourceGenerationId: ids.sourceGeneration,
      readiness: "registered"
    });
    await fixture.app.close();
  });

  it("releases a deferred start only for its assigned runner generation", async () => {
    const release = vi.fn(async () => true);
    const fixture = await buildServer({
      repository: {
        getManagedConversationExecution: vi.fn(async () => ({
          id: ids.execution,
          executionGeneration: 2,
          runnerDeviceId: ids.device,
          runnerDeploymentId: ids.deployment
        })),
        releaseManagedConversationStartForRuntimeBinding: release
      }
    });
    const response = await fixture.app.inject({
      method: "POST",
      url: `/v1/managed-conversation-runner/executions/${ids.execution}/runtime-binding-ready`,
      headers: runnerHeaders,
      payload: { executionGeneration: 2 }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ready: true });
    expect(release).toHaveBeenCalledWith({
      ownerUserId: ids.user,
      executionId: ids.execution,
      executionGeneration: 2,
      deploymentId: ids.deployment,
      deviceId: ids.device
    });
    await fixture.app.close();
  });

  it("rejects runtime readiness for a stale execution generation", async () => {
    const release = vi.fn();
    const fixture = await buildServer({
      repository: {
        getManagedConversationExecution: vi.fn(async () => ({
          id: ids.execution,
          executionGeneration: 3,
          runnerDeviceId: ids.device,
          runnerDeploymentId: ids.deployment
        })),
        releaseManagedConversationStartForRuntimeBinding: release
      }
    });
    const response = await fixture.app.inject({
      method: "POST",
      url: `/v1/managed-conversation-runner/executions/${ids.execution}/runtime-binding-ready`,
      headers: runnerHeaders,
      payload: { executionGeneration: 2 }
    });

    expect(response.statusCode).toBe(409);
    expect(release).not.toHaveBeenCalled();
    await fixture.app.close();
  });

  it("binds a source generation only for the assigned runner device", async () => {
    const bind = vi.fn(async () => ({
      id: ids.execution,
      sourceGenerationId: ids.sourceGeneration
    }));
    const fixture = await buildServer({
      repository: {
        getManagedConversationExecution: vi.fn(async () => ({
          id: ids.execution,
          runnerDeviceId: ids.device,
          runnerDeploymentId: ids.deployment
        })),
        bindManagedConversationSourceGeneration: bind
      }
    });
    const response = await fixture.app.inject({
      method: "POST",
      url: `/v1/managed-conversation-runner/executions/${ids.execution}/source-generation`,
      headers: runnerHeaders,
      payload: {
        executionGeneration: 1,
        runnerId: "runner-1",
        expectedSourceGenerationId: ids.other,
        sourceGenerationId: ids.sourceGeneration
      }
    });

    expect(response.statusCode).toBe(200);
    expect(bind).toHaveBeenCalledWith(
      { userId: ids.user },
      {
        executionId: ids.execution,
        executionGeneration: 1,
        runnerId: "runner-1",
        expectedSourceGenerationId: ids.other,
        sourceGenerationId: ids.sourceGeneration
      }
    );
    await fixture.app.close();
  });

  it("lists only active executions assigned to the authenticated runner", async () => {
    const list = vi.fn(async () => [
      {
        id: ids.execution,
        ownerUserId: ids.user,
        runnerDeploymentId: ids.deployment,
        runnerDeviceId: ids.device,
        state: "running"
      }
    ]);
    const fixture = await buildServer({
      repository: { listManagedConversationExecutionsForRunner: list }
    });
    const response = await fixture.app.inject({
      method: "GET",
      url: "/v1/managed-conversation-runner/executions",
      headers: runnerHeaders
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).executions).toHaveLength(1);
    expect(list).toHaveBeenCalledWith({
      ownerUserId: ids.user,
      deploymentId: ids.deployment,
      deviceId: ids.device,
      limit: 500
    });
    await fixture.app.close();
  });

  it("acquires an idle execution lease only through its assigned runner identity", async () => {
    const acquire = vi.fn(async () => true);
    const fixture = await buildServer({
      repository: {
        getManagedConversationExecution: vi.fn(async () => ({
          id: ids.execution,
          executionGeneration: 2,
          runnerDeploymentId: ids.deployment,
          runnerDeviceId: ids.device,
          state: "running"
        })),
        acquireManagedConversationExecutionLease: acquire
      }
    });
    const response = await fixture.app.inject({
      method: "POST",
      url: `/v1/managed-conversation-runner/executions/${ids.execution}/acquire`,
      headers: runnerHeaders,
      payload: {
        executionGeneration: 2,
        runnerId: "recovered-runner",
        leaseMs: 30_000
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ acquired: true });
    expect(acquire).toHaveBeenCalledWith({
      executionId: ids.execution,
      executionGeneration: 2,
      deploymentId: ids.deployment,
      deviceId: ids.device,
      runnerId: "recovered-runner",
      leaseMs: 30_000
    });
    await fixture.app.close();
  });

  it("rejects execution lease acquisition for a stale generation", async () => {
    const acquire = vi.fn();
    const fixture = await buildServer({
      repository: {
        getManagedConversationExecution: vi.fn(async () => ({
          id: ids.execution,
          executionGeneration: 3,
          runnerDeploymentId: ids.deployment,
          runnerDeviceId: ids.device,
          state: "running"
        })),
        acquireManagedConversationExecutionLease: acquire
      }
    });
    const response = await fixture.app.inject({
      method: "POST",
      url: `/v1/managed-conversation-runner/executions/${ids.execution}/acquire`,
      headers: runnerHeaders,
      payload: {
        executionGeneration: 2,
        runnerId: "stale-runner",
        leaseMs: 30_000
      }
    });

    expect(response.statusCode).toBe(409);
    expect(acquire).not.toHaveBeenCalled();
    await fixture.app.close();
  });

  it("rejects browser/API-token callers and credentials without managed execution authority", async () => {
    const fixture = await buildServer();
    const noCredential = await fixture.app.inject({
      method: "POST",
      url: "/v1/managed-conversation-runner/commands/claim",
      payload: { runnerId: "runner", limit: 1, leaseMs: 30_000 }
    });
    const apiToken = await fixture.app.inject({
      method: "POST",
      url: "/v1/managed-conversation-runner/commands/claim",
      headers: { authorization: "Bearer personal-token" },
      payload: { runnerId: "runner", limit: 1, leaseMs: 30_000 }
    });
    await fixture.app.close();

    const wrongScope = await buildServer({ operationFamilies: ["sync"] });
    const scopedResponse = await wrongScope.app.inject({
      method: "POST",
      url: "/v1/managed-conversation-runner/commands/claim",
      headers: runnerHeaders,
      payload: { runnerId: "runner", limit: 1, leaseMs: 30_000 }
    });
    await wrongScope.app.close();

    expect(noCredential.statusCode).toBe(401);
    expect(apiToken.statusCode).toBe(401);
    expect(scopedResponse.statusCode).toBe(403);
  });

  it("requires a verified deployment identity and scopes command claims to its exact owner and device", async () => {
    const missingDeployment = await buildServer({
      protocolDeploymentId: null
    });
    const missingResponse = await missingDeployment.app.inject({
      method: "POST",
      url: "/v1/managed-conversation-runner/commands/claim",
      headers: runnerHeaders,
      payload: { runnerId: "runner", limit: 2, leaseMs: 30_000 }
    });
    await missingDeployment.app.close();

    const fixture = await buildServer();
    const response = await fixture.app.inject({
      method: "POST",
      url: "/v1/managed-conversation-runner/commands/claim",
      headers: runnerHeaders,
      payload: { runnerId: "runner", limit: 2, leaseMs: 30_000 }
    });

    expect(missingResponse.statusCode).toBe(409);
    expect(response.statusCode).toBe(200);
    expect(
      fixture.repository.claimManagedConversationCommands
    ).toHaveBeenCalledWith({
      ownerUserId: ids.user,
      runnerId: "runner",
      deviceId: ids.device,
      deploymentId: ids.deployment,
      limit: 2,
      leaseMs: 30_000
    });
    await fixture.app.close();
  });

  it("reconciles abandoned commands only for the authenticated owner, device, and deployment", async () => {
    const reconcile = vi.fn(async () => 2);
    const fixture = await buildServer({
      repository: {
        reconcileAbandonedManagedConversationCommands: reconcile
      }
    });
    const response = await fixture.app.inject({
      method: "POST",
      url: "/v1/managed-conversation-runner/commands/reconcile-abandoned",
      headers: runnerHeaders,
      payload: {}
    });
    const invalid = await fixture.app.inject({
      method: "POST",
      url: "/v1/managed-conversation-runner/commands/reconcile-abandoned",
      headers: runnerHeaders,
      payload: { ownerUserId: randomUUID() }
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ reconciled: 2 });
    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledWith({
      ownerUserId: ids.user,
      deviceId: ids.device,
      deploymentId: ids.deployment,
      limit: 32
    });
    expect(invalid.statusCode).toBe(400);
    await fixture.app.close();
  });

  it("does not expose the latest handoff to an unrelated runner device", async () => {
    const latest = {
      id: ids.handoff,
      executionId: ids.execution,
      sourceDeviceId: ids.otherDevice,
      sourceDeploymentId: ids.otherDeployment,
      targetDeviceId: randomUUID(),
      targetDeploymentId: ids.deployment
    };
    const fixture = await buildServer({
      repository: {
        getLatestManagedConversationHandoffForExecution: vi.fn(
          async () => latest
        )
      }
    });
    const response = await fixture.app.inject({
      method: "GET",
      url: `/v1/managed-conversation-runner/handoffs/latest/${ids.execution}`,
      headers: runnerHeaders
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toEqual({
      error: "Managed handoff is not assigned here"
    });
    await fixture.app.close();
  });

  it("returns the latest handoff assigned to the authenticated target device", async () => {
    const latest = {
      id: ids.handoff,
      executionId: ids.execution,
      sourceDeviceId: ids.otherDevice,
      sourceDeploymentId: ids.otherDeployment,
      targetDeviceId: ids.device,
      targetDeploymentId: ids.deployment
    };
    const fixture = await buildServer({
      repository: {
        getLatestManagedConversationHandoffForExecution: vi.fn(
          async () => latest
        )
      }
    });
    const response = await fixture.app.inject({
      method: "GET",
      url: `/v1/managed-conversation-runner/handoffs/latest/${ids.execution}`,
      headers: runnerHeaders
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ handoff: latest });
    await fixture.app.close();
  });

  it("does not let a source runner upload a handoff snapshot for another device", async () => {
    const begin = vi.fn();
    const fixture = await buildServer({
      repository: {
        getManagedConversationHandoff: vi.fn(async () => ({
          id: ids.handoff,
          sourceDeviceId: ids.otherDevice,
          sourceDeploymentId: ids.deployment,
          targetDeviceId: ids.device,
          targetDeploymentId: ids.otherDeployment
        })),
        beginDevelopmentWorkspaceSnapshot: begin
      }
    });
    const response = await fixture.app.inject({
      method: "POST",
      url: `/v1/managed-conversation-runner/handoffs/${ids.handoff}/workspace-snapshots`,
      headers: runnerHeaders,
      payload: {
        id: ids.snapshot,
        executionId: ids.execution,
        sourceGenerationId: ids.sourceGeneration,
        sourceDeploymentId: ids.deployment,
        sourceDeviceId: ids.device
      }
    });

    expect(response.statusCode).toBe(403);
    expect(begin).not.toHaveBeenCalled();
    await fixture.app.close();
  });

  it("does not expose an arbitrary workspace snapshot to a handoff target", async () => {
    const getSnapshot = vi.fn();
    const fixture = await buildServer({
      repository: {
        getManagedConversationHandoff: vi.fn(async () => ({
          id: ids.handoff,
          sourceDeviceId: ids.otherDevice,
          sourceDeploymentId: ids.otherDeployment,
          targetDeviceId: ids.device,
          targetDeploymentId: ids.deployment,
          workspaceSnapshotId: ids.snapshot
        })),
        getDevelopmentWorkspaceSnapshot: getSnapshot
      }
    });
    const response = await fixture.app.inject({
      method: "GET",
      url: `/v1/managed-conversation-runner/handoffs/${ids.handoff}/workspace-snapshots/${ids.otherSnapshot}`,
      headers: runnerHeaders
    });

    expect(response.statusCode).toBe(403);
    expect(getSnapshot).not.toHaveBeenCalled();
    await fixture.app.close();
  });

  it("lets a handoff source verify its operation-bound snapshot metadata", async () => {
    const snapshot = { id: ids.snapshot, state: "ready" };
    const getSnapshot = vi.fn(async () => snapshot);
    const fixture = await buildServer({
      repository: {
        getManagedConversationHandoff: vi.fn(async () => ({
          id: ids.handoff,
          sourceDeviceId: ids.device,
          sourceDeploymentId: ids.deployment,
          targetDeviceId: ids.otherDevice,
          targetDeploymentId: ids.otherDeployment,
          workspaceSnapshotId: null
        })),
        getDevelopmentWorkspaceSnapshot: getSnapshot
      }
    });
    const response = await fixture.app.inject({
      method: "GET",
      url: `/v1/managed-conversation-runner/handoffs/${ids.handoff}/workspace-snapshots/${ids.snapshot}`,
      headers: runnerHeaders
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ snapshot });
    expect(getSnapshot).toHaveBeenCalledWith(
      { userId: ids.user },
      {
        snapshotId: ids.snapshot,
        operationKind: "handoff",
        operationId: ids.handoff
      }
    );
    await fixture.app.close();
  });

  it("lets a fork source verify its operation-bound snapshot metadata", async () => {
    const snapshot = { id: ids.snapshot, state: "ready" };
    const getSnapshot = vi.fn(async () => snapshot);
    const fixture = await buildServer({
      repository: {
        getManagedConversationFork: vi.fn(async () => ({
          id: ids.fork,
          sourceDeviceId: ids.device,
          sourceDeploymentId: ids.deployment,
          targetDeviceId: ids.otherDevice,
          targetDeploymentId: ids.otherDeployment,
          workspaceSnapshotId: null
        })),
        getDevelopmentWorkspaceSnapshot: getSnapshot
      }
    });
    const response = await fixture.app.inject({
      method: "GET",
      url: `/v1/managed-conversation-runner/forks/${ids.fork}/workspace-snapshots/${ids.snapshot}`,
      headers: runnerHeaders
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ snapshot });
    expect(getSnapshot).toHaveBeenCalledWith(
      { userId: ids.user },
      {
        snapshotId: ids.snapshot,
        operationKind: "fork",
        operationId: ids.fork
      }
    );
    await fixture.app.close();
  });

  it("requires the independent sync operation family before source download authorization", async () => {
    const getSource = vi.fn(async () => ({
      logicalSourceId: randomUUID(),
      sourceGenerationId: ids.sourceGeneration,
      lifecycle: "finalized",
      closureHash: "a".repeat(64)
    }));
    const fixture = await buildServer({
      operationFamilies: ["managed_execution"],
      repository: {
        getManagedConversationHandoff: vi.fn(async () => ({
          id: ids.handoff,
          state: "workspace_prepared",
          sourceDeviceId: ids.otherDevice,
          sourceDeploymentId: ids.otherDeployment,
          targetDeviceId: ids.device,
          targetDeploymentId: ids.deployment,
          sourceGenerationId: ids.sourceGeneration,
          sourceClosureHash: "a".repeat(64)
        })),
        getConversationSourceArtifactByGeneration: getSource
      }
    });
    const response = await fixture.app.inject({
      method: "POST",
      url: `/v1/managed-conversation-runner/handoffs/${ids.handoff}/source-download-authorization`,
      headers: runnerHeaders,
      payload: {
        targetDeploymentId: ids.deployment,
        sourceGenerationId: ids.sourceGeneration,
        firstSegmentIndex: 0,
        recipientKey: {
          algorithm: "RSA-OAEP-SHA256",
          keyId: recipientKeyId,
          keyVersion: 1,
          publicJwk: {
            kty: "RSA",
            n: recipientPublicJwk.n,
            e: recipientPublicJwk.e,
            alg: "RSA-OAEP-256",
            key_ops: ["encrypt"],
            ext: true,
            kid: recipientKeyId,
            use: "enc"
          }
        }
      }
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toEqual({
      error: "Device credential is not allowed for source replication"
    });
    expect(getSource).not.toHaveBeenCalled();
    await fixture.app.close();
  });
});
