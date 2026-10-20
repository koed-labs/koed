import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerProjectRoutes } from "./routes.js";
import { ProjectNativeReviewDeclined } from "./delete-coordinator.js";

const owner = randomUUID();
const projectId = randomUUID();
const now = "2026-10-20T00:00:00.000Z";
const project = {
  id: projectId,
  name: "Atlas",
  key: "ATLAS",
  folderPath: null,
  lifecycle: "active",
  deletionPhase: null,
  deleteBatchId: null,
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
  version: 1
};
const fixture = (deploymentProfile = "local_personal") => {
  const app = Fastify();
  const repository = {
    list: vi.fn(async () => ({ projects: [project], nextCursor: null })),
    create: vi.fn(async () => project),
    patch: vi.fn(async () => project)
  };
  const authenticate = vi.fn(
    async (
      request: { headers: { authorization?: string } },
      family: string
    ) => {
      if (request.headers.authorization?.startsWith("Bearer "))
        throw Object.assign(
          new Error("API Tokens cannot authorize Project operations"),
          { statusCode: 403 }
        );
      if (
        ![
          "personal_collaboration_read",
          "personal_collaboration_write"
        ].includes(family)
      )
        throw new Error("Wrong operation family");
      return { id: owner };
    }
  );
  registerProjectRoutes(app, {
    repository: repository as never,
    managedRepository: null,
    sourceCoordinator: null,
    deploymentProfile,
    auth: { authenticateSessionOrDeviceCredential: authenticate } as never,
    readRateLimit: async () => undefined,
    writeRateLimit: async () => undefined
  });
  return { app, repository, authenticate };
};

describe("Personal Project routes", () => {
  it("binds list and create to the authenticated local owner and operation family", async () => {
    const { app, repository, authenticate } = fixture();
    try {
      const list = await app.inject({ method: "GET", url: "/v1/projects" });
      expect(list.statusCode).toBe(200);
      expect(repository.list).toHaveBeenCalledWith(owner, {
        limit: 50,
        includeDeleted: false
      });
      const created = await app.inject({
        method: "POST",
        url: "/v1/projects",
        payload: { name: "Atlas", idempotencyKey: "create" }
      });
      expect(created.statusCode).toBe(201);
      expect(repository.create).toHaveBeenCalledWith(owner, {
        name: "Atlas",
        idempotencyKey: "create"
      });
      expect(authenticate.mock.calls.map((call) => call[1])).toEqual([
        "personal_collaboration_read",
        "personal_collaboration_write"
      ]);
      const token = await app.inject({
        method: "POST",
        url: "/v1/projects",
        headers: { authorization: "Bearer token" },
        payload: { name: "Atlas", idempotencyKey: "token" }
      });
      expect(token.statusCode).toBe(403);
      expect(repository.create).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
  it("rejects a remote Team deployment before creating local Project identity", async () => {
    const { app, repository } = fixture("team_self_hosted");
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/projects",
        payload: { name: "Atlas", idempotencyKey: "remote" }
      });
      expect(response.statusCode).toBe(403);
      expect(repository.create).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("keeps an uncertain freeze and nonterminal execution pending", async () => {
    const app = Fastify(),
      batchId = randomUUID(),
      executionId = randomUUID();
    const pending = {
      ...project,
      version: 2,
      deletionPhase: "preparing",
      deleteBatchId: batchId
    };
    const operation = {
      batchId,
      projectId,
      ownerUserId: owner,
      sources: [
        {
          sessionId: randomUUID(),
          logicalMemoryId: randomUUID(),
          backends: [{ backendId: "team-a", relationshipIds: [] }]
        }
      ],
      executions: [
        {
          id: executionId,
          executionGeneration: 1,
          state: "running",
          stateVersion: 1
        }
      ],
      backendAcks: [],
      grantFreezeAcks: [],
      runtimeAcks: [],
      state: "preparing",
      sourceManifestHash: "a".repeat(64),
      executionSetHash: "b".repeat(64)
    };
    const repository = {
      listPendingReleaseOperations: vi.fn(async () => []),
      beginDelete: vi.fn(async () => pending),
      getDeleteOperation: vi.fn(async () => operation),
      get: vi.fn(async () => pending),
      markDeleteReady: vi.fn(),
      completeDelete: vi.fn()
    };
    const managed = {
      getManagedConversationExecution: vi.fn(async () => ({
        id: executionId,
        executionGeneration: 1,
        state: "running",
        stateVersion: 1
      })),
      enqueueManagedConversationControl: vi.fn(async () => undefined)
    };
    const coordinator = {
      advance: vi.fn(async () => {
        throw new Error("backend offline");
      }),
      cancel: vi.fn()
    };
    registerProjectRoutes(app, {
      repository: repository as never,
      managedRepository: managed as never,
      sourceCoordinator: coordinator as never,
      deploymentProfile: "local_personal",
      auth: {
        authenticateSessionOrDeviceCredential: async () => ({ id: owner })
      } as never,
      readRateLimit: async () => undefined,
      writeRateLimit: async () => undefined
    });
    try {
      const response = await app.inject({
        method: "DELETE",
        url: `/v1/projects/${projectId}`,
        payload: {
          version: 1,
          batchId,
          executionSetHash: operation.executionSetHash
        }
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({
        complete: false,
        pendingFreezeCount: 1,
        pendingExecutionCount: 1
      });
      expect(managed.enqueueManagedConversationControl).toHaveBeenCalledWith(
        { userId: owner },
        expect.objectContaining({
          executionId,
          executionGeneration: 1,
          commandKind: "stop"
        })
      );
      expect(repository.markDeleteReady).not.toHaveBeenCalled();
      expect(repository.completeDelete).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("cancels the local pending guard after Native denial and exposes remote release uncertainty", async () => {
    const app = Fastify(),
      batchId = randomUUID();
    const pending = {
      ...project,
      version: 2,
      deletionPhase: "preparing",
      deleteBatchId: batchId
    };
    const operation = {
      batchId,
      projectId,
      ownerUserId: owner,
      sources: [
        {
          sessionId: randomUUID(),
          logicalMemoryId: randomUUID(),
          backends: [{ backendId: "team-a", relationshipIds: [] }]
        }
      ],
      executions: [],
      backendAcks: [],
      grantFreezeAcks: [],
      runtimeAcks: [],
      state: "preparing",
      sourceManifestHash: "a".repeat(64),
      executionSetHash: "b".repeat(64)
    };
    const repository = {
      getDeleteOperation: vi.fn(async () => operation),
      getDeleteOperationByBatch: vi.fn(async () => ({
        ...operation,
        state: "cancelled"
      })),
      get: vi.fn(async () => pending),
      cancelDelete: vi.fn(async () => project),
      markDeleteReady: vi.fn(),
      completeDelete: vi.fn()
    };
    const coordinator = {
      advance: vi.fn(async () => {
        throw new ProjectNativeReviewDeclined();
      }),
      cancel: vi.fn(async () => false)
    };
    registerProjectRoutes(app, {
      repository: repository as never,
      managedRepository: {
        getManagedConversationExecution: vi.fn(),
        enqueueManagedConversationControl: vi.fn()
      } as never,
      sourceCoordinator: coordinator as never,
      deploymentProfile: "local_personal",
      auth: {
        authenticateSessionOrDeviceCredential: async () => ({ id: owner })
      } as never,
      readRateLimit: async () => undefined,
      writeRateLimit: async () => undefined
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/projects/${projectId}/delete-progress`
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        complete: false,
        retryable: false,
        cancellationPending: true,
        project: { deletionPhase: null }
      });
      expect(repository.cancelDelete).toHaveBeenCalledWith(
        owner,
        projectId,
        batchId
      );
      expect(repository.completeDelete).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("recovers an offline cancelled hold after reload before another delete", async () => {
    const app = Fastify();
    const oldBatch = randomUUID();
    const newBatch = randomUUID();
    const source = {
      sessionId: randomUUID(),
      logicalMemoryId: randomUUID(),
      backends: [{ backendId: "team-a", relationshipIds: [] }]
    };
    const oldOperation = {
      batchId: oldBatch,
      projectId,
      ownerUserId: owner,
      sources: [source],
      executions: [],
      backendAcks: [],
      grantFreezeAcks: [],
      runtimeAcks: [],
      state: "cancelled",
      sourceManifestHash: "a".repeat(64),
      executionSetHash: "b".repeat(64)
    };
    let released = false;
    let newDeleteStarted = false;
    let online = false;
    const repository = {
      get: vi.fn(async () =>
        newDeleteStarted
          ? {
              ...project,
              version: 2,
              deletionPhase: "preparing",
              deleteBatchId: newBatch
            }
          : project
      ),
      getDeleteOperation: vi.fn(async () =>
        newDeleteStarted
          ? { ...oldOperation, batchId: newBatch, state: "preparing" }
          : null
      ),
      listPendingReleaseOperations: vi.fn(async () =>
        released ? [] : [oldOperation]
      ),
      finishRestoreRelease: vi.fn(async () => undefined),
      beginDelete: vi.fn(async () => {
        newDeleteStarted = true;
      }),
      markDeleteReady: vi.fn(),
      completeDelete: vi.fn()
    };
    const coordinator = {
      cancel: vi.fn(async () => {
        if (!online) return false;
        released = true;
        return true;
      }),
      advance: vi.fn(async () => {
        throw new Error("new batch source still offline");
      })
    };
    registerProjectRoutes(app, {
      repository: repository as never,
      managedRepository: {
        getManagedConversationExecution: vi.fn(),
        enqueueManagedConversationControl: vi.fn()
      } as never,
      sourceCoordinator: coordinator as never,
      deploymentProfile: "local_personal",
      auth: {
        authenticateSessionOrDeviceCredential: async () => ({ id: owner })
      } as never,
      readRateLimit: async () => undefined,
      writeRateLimit: async () => undefined
    });
    try {
      const status = await app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/delete-status`
      });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({
        complete: false,
        cancellationPending: true,
        pendingFreezeCount: 1
      });
      const deleteRequest = {
        method: "DELETE" as const,
        url: `/v1/projects/${projectId}`,
        payload: {
          version: 1,
          batchId: newBatch,
          executionSetHash: "b".repeat(64)
        }
      };
      const offline = await app.inject(deleteRequest);
      expect(offline.statusCode).toBe(409);
      expect(repository.beginDelete).not.toHaveBeenCalled();
      online = true;
      const retried = await app.inject(deleteRequest);
      expect(retried.statusCode).toBe(202);
      expect(repository.finishRestoreRelease).toHaveBeenCalledWith(
        owner,
        projectId,
        oldBatch
      );
      expect(repository.beginDelete).toHaveBeenCalledWith(
        owner,
        projectId,
        deleteRequest.payload
      );
      expect(coordinator.cancel).toHaveBeenCalledTimes(2);
      expect(repository.completeDelete).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("completes only after the confirmed execution is terminal and source set is sealed", async () => {
    const app = Fastify(),
      batchId = randomUUID(),
      executionId = randomUUID();
    const pending = {
      ...project,
      version: 2,
      deletionPhase: "preparing",
      deleteBatchId: batchId
    };
    const deleted = {
      ...pending,
      version: 4,
      lifecycle: "deleted",
      deletionPhase: "complete",
      deletedAt: now
    };
    const operation = {
      batchId,
      projectId,
      ownerUserId: owner,
      sources: [],
      executions: [
        {
          id: executionId,
          executionGeneration: 1,
          state: "running",
          stateVersion: 1
        }
      ],
      backendAcks: [],
      grantFreezeAcks: [],
      runtimeAcks: [] as Array<unknown>,
      state: "preparing",
      sourceManifestHash: "a".repeat(64),
      executionSetHash: "b".repeat(64)
    };
    const repository = {
      getDeleteOperation: vi.fn(async () => operation),
      get: vi.fn(async () => pending),
      recordRuntimeAck: vi.fn(
        async (_owner: string, _id: string, _batch: string, ack: unknown) => {
          operation.runtimeAcks.push(ack);
        }
      ),
      markDeleteReady: vi.fn(async () => undefined),
      completeDelete: vi.fn(async () => deleted)
    };
    const managed = {
      getManagedConversationExecution: vi.fn(async () => ({
        id: executionId,
        executionGeneration: 1,
        state: "stopped",
        stateVersion: 3
      })),
      enqueueManagedConversationControl: vi.fn()
    };
    registerProjectRoutes(app, {
      repository: repository as never,
      managedRepository: managed as never,
      sourceCoordinator: null,
      deploymentProfile: "local_personal",
      auth: {
        authenticateSessionOrDeviceCredential: async () => ({ id: owner })
      } as never,
      readRateLimit: async () => undefined,
      writeRateLimit: async () => undefined
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/projects/${projectId}/delete-progress`
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        complete: true,
        pendingExecutionCount: 0,
        project: { lifecycle: "deleted", deleteBatchId: batchId }
      });
      expect(repository.markDeleteReady).toHaveBeenCalledWith(
        owner,
        projectId,
        batchId
      );
      expect(repository.completeDelete).toHaveBeenCalledWith(
        owner,
        projectId,
        batchId
      );
      expect(managed.enqueueManagedConversationControl).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
