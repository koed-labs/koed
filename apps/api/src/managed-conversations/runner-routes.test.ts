import { generateKeyPairSync, randomUUID } from "node:crypto";

import {
  calculateConversationSourceClosureDigest,
  calculateConversationSourceRootDigest,
  CONVERSATION_SOURCE_REPLICATION_PROTOCOL,
  generateConversationSourceReplicationOriginKeyPair,
  signConversationSourceClosureManifest,
  type ConversationSourceClosureManifest
} from "@koed/shared";
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
  command: randomUUID(),
  handoff: randomUUID(),
  fork: randomUUID(),
  snapshot: randomUUID(),
  otherSnapshot: randomUUID(),
  other: randomUUID(),
  sourceGeneration: randomUUID()
};
const recipientKeyId = randomUUID();
const recipientPublicJwk = generateKeyPairSync("rsa", {
  modulusLength: 3072
}).publicKey.export({ format: "jwk" });

const buildServer = async (options?: {
  operationFamilies?: string[];
  protocolDeploymentId?: string | null;
  repository?: Record<string, unknown>;
}) => {
  const repository = {
    claimManagedConversationCommands: vi.fn(async () => []),
    claimManagedConversationControlCommands: vi.fn(async () => []),
    claimManagedConversationFileOperations: vi.fn(async () => []),
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
              "managed_file_read",
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
  it("lists and records checkpoints only for the assigned execution runner", async () => {
    const digest = "a".repeat(64);
    const objectId = "b".repeat(40);
    const checkpoint = {
      id: randomUUID(),
      executionId: ids.execution,
      executionGeneration: 2,
      commandId: ids.command,
      providerTurnId: null,
      sourceGenerationId: ids.sourceGeneration,
      sequence: 0,
      checkpointKind: "baseline",
      checkpointStatus: "ready",
      failureCode: null,
      repositoryIdentityHash: digest,
      worktreeIdentityHash: digest,
      vcsDriver: "git",
      checkpointRef: `refs/koed/checkpoints/${ids.execution}/2/0/baseline`,
      commitObjectId: objectId,
      capturedAt: new Date().toISOString()
    } as const;
    const list = vi.fn(async () => [{ ...checkpoint, ownerUserId: ids.user }]);
    const record = vi.fn(async () => ({
      ...checkpoint,
      ownerUserId: ids.user,
      createdAt: new Date().toISOString()
    }));
    const fixture = await buildServer({
      repository: {
        getManagedConversationExecution: vi.fn(async () => ({
          id: ids.execution,
          executionGeneration: 2,
          runnerDeviceId: ids.device,
          runnerDeploymentId: ids.deployment
        })),
        listManagedConversationExecutionCheckpoints: list,
        recordManagedConversationExecutionCheckpoint: record
      }
    });

    const listed = await fixture.app.inject({
      method: "GET",
      url: `/v1/managed-conversation-runner/executions/${ids.execution}/checkpoints?executionGeneration=2`,
      headers: runnerHeaders
    });
    expect(listed.statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith(
      { userId: ids.user },
      { executionId: ids.execution, executionGeneration: 2 }
    );

    const recorded = await fixture.app.inject({
      method: "POST",
      url: `/v1/managed-conversation-runner/executions/${ids.execution}/checkpoints`,
      headers: runnerHeaders,
      payload: { checkpoint, diffs: [] }
    });
    expect(recorded.statusCode).toBe(200);
    expect(record).toHaveBeenCalledWith(
      { userId: ids.user },
      { checkpoint, diffs: [] }
    );

    await fixture.app.close();
  });

  it("rejects checkpoint access from a device not assigned to the execution", async () => {
    const fixture = await buildServer({
      repository: {
        getManagedConversationExecution: vi.fn(async () => ({
          id: ids.execution,
          executionGeneration: 1,
          runnerDeviceId: ids.otherDevice,
          runnerDeploymentId: ids.deployment
        }))
      }
    });

    const response = await fixture.app.inject({
      method: "GET",
      url: `/v1/managed-conversation-runner/executions/${ids.execution}/checkpoints?executionGeneration=1`,
      headers: runnerHeaders
    });
    expect(response.statusCode).toBe(403);
    await fixture.app.close();
  });

  it("records checkpoint-only recovery only for the assigned command runner", async () => {
    const mark = vi.fn(async () => true);
    const fixture = await buildServer({
      repository: {
        getManagedConversationCommand: vi.fn(async () => ({
          id: ids.command,
          executionId: ids.execution,
          targetDeviceId: null,
          targetDeploymentId: null
        })),
        getManagedConversationExecution: vi.fn(async () => ({
          id: ids.execution,
          runnerDeviceId: ids.device,
          runnerDeploymentId: ids.deployment
        })),
        markManagedConversationCheckpointPending: mark
      }
    });
    const leaseToken = randomUUID();
    const response = await fixture.app.inject({
      method: "POST",
      url: `/v1/managed-conversation-runner/commands/${ids.command}/checkpoint-pending`,
      headers: runnerHeaders,
      payload: {
        leaseToken,
        sourceGenerationId: ids.sourceGeneration,
        providerTurnId: "provider-turn-1"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ marked: true });
    expect(mark).toHaveBeenCalledWith({
      commandId: ids.command,
      leaseToken,
      sourceGenerationId: ids.sourceGeneration,
      providerTurnId: "provider-turn-1"
    });

    const malformed = await fixture.app.inject({
      method: "POST",
      url: `/v1/managed-conversation-runner/commands/${ids.command}/checkpoint-pending`,
      headers: runnerHeaders,
      payload: {
        leaseToken,
        sourceGenerationId: ids.sourceGeneration,
        providerTurnId: "provider-turn-1",
        ref: "refs/heads/main"
      }
    });
    expect(malformed.statusCode).toBe(400);
    expect(mark).toHaveBeenCalledTimes(1);
    await fixture.app.close();
  });

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

  it("fails a deferred start with a bounded workspace error for its assigned runner", async () => {
    const fail = vi.fn(async () => true);
    const fixture = await buildServer({
      repository: {
        getManagedConversationExecution: vi.fn(async () => ({
          id: ids.execution,
          executionGeneration: 2,
          runnerDeviceId: ids.device,
          runnerDeploymentId: ids.deployment
        })),
        failManagedConversationStartForRuntimeBinding: fail
      }
    });
    const response = await fixture.app.inject({
      method: "POST",
      url: `/v1/managed-conversation-runner/executions/${ids.execution}/runtime-binding-failed`,
      headers: runnerHeaders,
      payload: {
        executionGeneration: 2,
        errorCode: "ExecutionWorkspaceSourceDirtyError"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ failed: true });
    expect(fail).toHaveBeenCalledWith({
      ownerUserId: ids.user,
      executionId: ids.execution,
      executionGeneration: 2,
      deploymentId: ids.deployment,
      deviceId: ids.device,
      errorCode: "ExecutionWorkspaceSourceDirtyError"
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

  it("scopes the concurrent control lane to the authenticated runner", async () => {
    const fixture = await buildServer();
    const response = await fixture.app.inject({
      method: "POST",
      url: "/v1/managed-conversation-runner/commands/claim-controls",
      headers: runnerHeaders,
      payload: { runnerId: "control-runner", limit: 3, leaseMs: 30_000 }
    });

    expect(response.statusCode).toBe(200);
    expect(
      fixture.repository.claimManagedConversationControlCommands
    ).toHaveBeenCalledWith({
      ownerUserId: ids.user,
      runnerId: "control-runner",
      deviceId: ids.device,
      deploymentId: ids.deployment,
      limit: 3,
      leaseMs: 30_000
    });
    await fixture.app.close();
  });

  it("claims and completes rooted file operations only for the assigned runner", async () => {
    const complete = vi.fn(async () => true);
    const checkpointId = randomUUID();
    const fixture = await buildServer({
      repository: {
        getManagedConversationCommand: vi.fn(async () => ({
          id: ids.command,
          executionId: ids.execution,
          commandKind: "file_read"
        })),
        getManagedConversationExecution: vi.fn(async () => ({
          id: ids.execution,
          runnerDeviceId: ids.device,
          runnerDeploymentId: ids.deployment
        })),
        completeManagedConversationFileOperation: complete
      }
    });
    const claimed = await fixture.app.inject({
      method: "POST",
      url: "/v1/managed-conversation-runner/commands/claim-files",
      headers: runnerHeaders,
      payload: { runnerId: "file-runner", limit: 4, leaseMs: 30_000 }
    });
    const completed = await fixture.app.inject({
      method: "POST",
      url: `/v1/managed-conversation-runner/commands/${ids.command}/file-complete`,
      headers: runnerHeaders,
      payload: {
        leaseToken: randomUUID(),
        result: {
          protocolVersion: 1,
          checkpointId,
          checkpointSequence: 1,
          revision: {
            checkpointId,
            revisionDigest: "a".repeat(64)
          },
          kind: "read",
          path: "src/example.ts",
          content: "export {};\n",
          contentDigest: "b".repeat(64),
          totalBytes: 11,
          offset: 0,
          nextOffset: null,
          lineCount: 2
        }
      }
    });
    await fixture.app.close();

    expect(claimed.statusCode).toBe(200);
    expect(
      fixture.repository.claimManagedConversationFileOperations
    ).toHaveBeenCalledWith({
      ownerUserId: ids.user,
      runnerId: "file-runner",
      deviceId: ids.device,
      deploymentId: ids.deployment,
      limit: 4,
      leaseMs: 30_000
    });
    expect(completed.statusCode).toBe(200);
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: ids.command,
        result: expect.objectContaining({ kind: "read" })
      })
    );
  });

  it("requires the managed file-read family independently of managed execution", async () => {
    const fixture = await buildServer({
      operationFamilies: ["managed_execution"]
    });
    const claimed = await fixture.app.inject({
      method: "POST",
      url: "/v1/managed-conversation-runner/commands/claim-files",
      headers: runnerHeaders,
      payload: { runnerId: "file-runner", limit: 1, leaseMs: 30_000 }
    });
    await fixture.app.close();

    expect(claimed.statusCode).toBe(403);
    expect(claimed.json()).toEqual({
      error: "Device credential is not allowed for managed file inspection"
    });
    expect(
      fixture.repository.claimManagedConversationFileOperations
    ).not.toHaveBeenCalled();
  });

  it("fences runtime items to the assigned device and exact generation", async () => {
    const put = vi.fn(async (_actor, input) => ({ id: ids.other, ...input }));
    const resolve = vi.fn(async () => true);
    const execution = {
      id: ids.execution,
      executionGeneration: 2,
      runnerDeviceId: ids.device,
      runnerDeploymentId: ids.deployment
    };
    const fixture = await buildServer({
      repository: {
        getManagedConversationExecution: vi.fn(async () => execution),
        putManagedConversationRuntimeItem: put,
        getManagedConversationRuntimeItem: vi.fn(async () => ({
          id: ids.other,
          executionId: ids.execution,
          executionGeneration: 1
        })),
        resolveManagedConversationRuntimeItem: resolve
      }
    });
    const accepted = await fixture.app.inject({
      method: "POST",
      url: "/v1/managed-conversation-runner/runtime-items",
      headers: runnerHeaders,
      payload: {
        executionId: ids.execution,
        executionGeneration: 2,
        providerRequestId: "provider:request-1",
        itemKind: "command_approval",
        payload: { command: "printf safe" }
      }
    });
    const stale = await fixture.app.inject({
      method: "POST",
      url: "/v1/managed-conversation-runner/runtime-items",
      headers: runnerHeaders,
      payload: {
        executionId: ids.execution,
        executionGeneration: 1,
        providerRequestId: "provider:request-2",
        itemKind: "command_approval",
        payload: { command: "printf stale" }
      }
    });
    const staleRead = await fixture.app.inject({
      method: "GET",
      url: `/v1/managed-conversation-runner/runtime-items/${ids.other}`,
      headers: runnerHeaders
    });
    const staleResolve = await fixture.app.inject({
      method: "POST",
      url: `/v1/managed-conversation-runner/runtime-items/${ids.other}/resolve`,
      headers: runnerHeaders,
      payload: { executionGeneration: 1, state: "resolved" }
    });
    execution.runnerDeviceId = ids.otherDevice;
    const wrongDevice = await fixture.app.inject({
      method: "POST",
      url: "/v1/managed-conversation-runner/runtime-items",
      headers: runnerHeaders,
      payload: {
        executionId: ids.execution,
        executionGeneration: 2,
        providerRequestId: "provider:request-3",
        itemKind: "command_approval",
        payload: { command: "printf wrong-device" }
      }
    });

    expect(accepted.statusCode).toBe(200);
    expect(stale.statusCode).toBe(409);
    expect(staleRead.statusCode).toBe(409);
    expect(staleResolve.statusCode).toBe(409);
    expect(wrongDevice.statusCode).toBe(403);
    expect(put).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
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

  it("persists the initiating handoff on a successful source download authorization", async () => {
    const logicalSourceId = randomUUID();
    const sessionId = randomUUID();
    const keys = generateConversationSourceReplicationOriginKeyPair();
    const chainHeadDigest = "c".repeat(64);
    const sourceCreatedAt = "2026-07-30T10:00:00.000Z";
    const closureManifest: ConversationSourceClosureManifest = {
      protocol: CONVERSATION_SOURCE_REPLICATION_PROTOCOL,
      sourceComponentSchemaVersion: 1,
      sourceComponentId: "main",
      sourceComponentRole: "primary",
      parentSourceComponentId: null,
      contentFraming: "jsonl",
      logicalSourceId,
      sourceGenerationId: ids.sourceGeneration,
      originKeyId: keys.originKeyId,
      segmentCount: 1,
      endByteCursor: 64,
      endItemCursor: 1,
      chainHeadDigest,
      sourceRootDigest: calculateConversationSourceRootDigest([
        chainHeadDigest
      ]),
      sourceCreatedAt,
      closedAt: "2026-07-30T10:05:00.000Z",
      priorGenerationClosure: null
    };
    const signedClosure = signConversationSourceClosureManifest(
      closureManifest,
      keys.privateKey
    );
    const closureHash = calculateConversationSourceClosureDigest(signedClosure);
    const artifact = {
      id: randomUUID(),
      ownerUserId: ids.user,
      sessionId,
      logicalSourceId,
      sourceGenerationId: ids.sourceGeneration,
      replicaRole: "hosted_personal",
      sourceComponentId: "main",
      sourceComponentRole: "primary",
      parentSourceComponentId: null,
      contentFraming: "jsonl",
      lifecycle: "finalized",
      sourceKind: "codex",
      sourceRuntime: "codex",
      artifactFormat: "codex_rollout_jsonl",
      artifactFormatVersion: 1,
      sourceAdapterVersion: "codex-transcript-v1",
      externalSessionId: "codex-session-1",
      sourceFingerprint: "d".repeat(64),
      sourceCreatedAt,
      priorGenerationClosure: null,
      closureHash,
      closureManifest: signedClosure.manifest,
      closureSignature: signedClosure.signature,
      originKeyId: keys.originKeyId,
      originPublicKey: keys.publicKeyBase64url,
      originKeyStatus: "active",
      redactedSourceLabel: "Codex session 1",
      originDeploymentId: ids.otherDeployment,
      originDeviceId: ids.otherDevice,
      journalStartOffset: 0,
      journalStartLine: 0,
      liveStartOffset: 0,
      liveStartLine: 0
    };
    const createAuthorization = vi.fn(async () => ({
      id: randomUUID(),
      firstSegmentIndex: 0,
      lastSegmentIndex: 0,
      expiresAt: "2026-07-30T10:30:00.000Z"
    }));
    const fixture = await buildServer({
      repository: {
        getManagedConversationHandoff: vi.fn(async () => ({
          id: ids.handoff,
          state: "workspace_prepared",
          sourceDeviceId: ids.otherDevice,
          sourceDeploymentId: ids.otherDeployment,
          targetDeviceId: ids.device,
          targetDeploymentId: ids.deployment,
          sourceGenerationId: ids.sourceGeneration,
          sourceClosureHash: closureHash
        })),
        getConversationSourceArtifactByGeneration: vi.fn(async () => artifact),
        getCapturedSession: vi.fn(async () => ({
          logicalSessionId: randomUUID(),
          forkedFromExternalThreadId: null,
          project: null
        })),
        createConversationSourceDownloadAuthorization: createAuthorization
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

    expect(response.statusCode, response.body).toBe(200);
    expect(createAuthorization).toHaveBeenCalledWith(
      { userId: ids.user },
      expect.objectContaining({
        deviceCredentialId: ids.credential,
        artifactId: artifact.id,
        initiatingOperation: { kind: "handoff", id: ids.handoff },
        firstSegmentIndex: 0
      })
    );
    await fixture.app.close();
  });
});
