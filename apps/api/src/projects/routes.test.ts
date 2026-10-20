import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  deleteDesktopLocalCredential,
  storeDesktopLocalCredential
} from "@koed/shared";
import type { Project } from "@koed/shared/project-contract";
import { registerProjectRoutes } from "./routes.js";
import { ProjectNativeReviewDeclined } from "./delete-coordinator.js";

const owner = randomUUID();
const projectId = randomUUID();
const now = "2026-10-20T00:00:00.000Z";
const project: Project = {
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
const fixture = (deploymentProfile = "local_personal", koedHome?: string) => {
  const app = Fastify();
  const repository = {
    list: vi.fn(async () => ({ projects: [project], nextCursor: null })),
    create: vi.fn(async () => project),
    patch: vi.fn(async () => project),
    hq: vi.fn(async () => ({
      project,
      sections: Object.fromEntries(
        ["conversations", "workItems", "sources", "decks", "scheduledJobs"].map(
          (key) => [key, { availability: "not_implemented" }]
        )
      )
    }))
  };
  const authenticate = vi.fn(
    async (
      request: { headers: { authorization?: string } },
      family: string
    ) => {
      if (
        request.headers.authorization?.startsWith("Bearer ") ||
        request.headers.authorization?.startsWith("Koed-Desktop ")
      )
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
    koedHome,
    auth: { authenticateSessionOrDeviceCredential: authenticate } as never,
    readRateLimit: async () => undefined,
    writeRateLimit: async () => undefined
  });
  return { app, repository, authenticate };
};

describe("Personal Project routes", () => {
  it("accepts only the current owner Desktop read credential on loopback for list and HQ", async () => {
    const home = mkdtempSync(join(tmpdir(), "koed-project-read-"));
    const credential = storeDesktopLocalCredential(home, {
      ownerUserId: owner,
      operationFamilies: ["personal_collaboration_read"]
    });
    const { app, repository, authenticate } = fixture("local_personal", home);
    try {
      const headers = { authorization: credential.authorization };
      const list = await app.inject({
        method: "GET",
        url: "/v1/projects",
        headers,
        remoteAddress: "127.0.0.1"
      });
      const hq = await app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/hq`,
        headers,
        remoteAddress: "::1"
      });
      expect(list.statusCode).toBe(200);
      expect(hq.statusCode).toBe(200);
      expect(repository.list).toHaveBeenCalledWith(owner, expect.anything());
      expect(repository.hq).toHaveBeenCalledWith(owner, projectId);
      expect(authenticate).not.toHaveBeenCalled();
      const create = await app.inject({
        method: "POST",
        url: "/v1/projects",
        headers,
        payload: { name: "Denied", idempotencyKey: "desktop-read" }
      });
      const patch = await app.inject({
        method: "PATCH",
        url: `/v1/projects/${projectId}`,
        headers,
        payload: { name: "Denied" }
      });
      expect(create.statusCode).toBe(401);
      expect(patch.statusCode).toBe(401);
      expect(repository.create).not.toHaveBeenCalled();
      expect(repository.patch).not.toHaveBeenCalled();
      const remote = await app.inject({
        method: "GET",
        url: "/v1/projects",
        remoteAddress: "192.0.2.10",
        headers: { ...headers, "x-forwarded-for": "127.0.0.1" }
      });
      expect(remote.statusCode).toBe(403);
      deleteDesktopLocalCredential(home);
      const revoked = await app.inject({
        method: "GET",
        url: "/v1/projects",
        headers
      });
      expect(revoked.statusCode).toBe(401);
      const wrongScopeCredential = storeDesktopLocalCredential(home, {
        ownerUserId: owner,
        operationFamilies: ["personal_collaboration_write"]
      });
      const wrongFamily = await app.inject({
        method: "GET",
        url: "/v1/projects",
        headers: { authorization: wrongScopeCredential.authorization }
      });
      expect(wrongFamily.statusCode).toBe(401);
      const remoteProfile = fixture("team_self_hosted", home);
      try {
        const wrongProfile = await remoteProfile.app.inject({
          method: "GET",
          url: "/v1/projects",
          headers: { authorization: wrongScopeCredential.authorization }
        });
        expect(wrongProfile.statusCode).toBe(403);
      } finally {
        await remoteProfile.app.close();
      }
      const token = await app.inject({
        method: "GET",
        url: "/v1/projects",
        headers: { authorization: "Bearer personal-token" }
      });
      expect(token.statusCode).toBe(403);
    } finally {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
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
  it("reports the selected historical batch and rejects an unknown batch", async () => {
    const app = Fastify();
    const cancelledBatch = randomUUID();
    const completedBatch = randomUUID();
    const source = {
      sessionId: randomUUID(),
      logicalMemoryId: randomUUID(),
      backends: [{ backendId: "team-a", relationshipIds: [] }]
    };
    const baseOperation = {
      projectId,
      ownerUserId: owner,
      executions: [],
      backendAcks: [],
      grantFreezeAcks: [],
      runtimeAcks: [],
      sourceManifestHash: "a".repeat(64),
      executionSetHash: "b".repeat(64)
    };
    const cancelled = {
      ...baseOperation,
      batchId: cancelledBatch,
      state: "cancelled",
      sources: [source]
    };
    const completed = {
      ...baseOperation,
      batchId: completedBatch,
      state: "complete",
      sources: []
    };
    const repository = {
      get: vi.fn(async () => ({
        ...project,
        lifecycle: "deleted",
        deletionPhase: "complete",
        deleteBatchId: completedBatch,
        deletedAt: now
      })),
      getDeleteOperation: vi.fn(async () => completed),
      getDeleteOperationByBatch: vi.fn(async (...args: string[]) => {
        const batchId = args[2];
        return batchId === cancelledBatch
          ? cancelled
          : batchId === completedBatch
            ? completed
            : null;
      }),
      listPendingReleaseOperations: vi.fn(async () => [])
    };
    registerProjectRoutes(app, {
      repository: repository as never,
      managedRepository: null,
      sourceCoordinator: null,
      deploymentProfile: "local_personal",
      auth: {
        authenticateSessionOrDeviceCredential: async () => ({ id: owner })
      } as never,
      readRateLimit: async () => undefined,
      writeRateLimit: async () => undefined
    });
    try {
      const status = async (batchId: string) =>
        app.inject({
          method: "GET",
          url: `/v1/projects/${projectId}/delete-status?batchId=${batchId}`
        });
      const old = await status(cancelledBatch);
      expect(old.statusCode).toBe(200);
      expect(old.json()).toMatchObject({
        operation: { batchId: cancelledBatch, state: "cancelled" },
        complete: false,
        retryable: false,
        pendingFreezeCount: 1,
        cancellationPending: true,
        project: { lifecycle: "deleted", deleteBatchId: completedBatch }
      });
      const current = await status(completedBatch);
      expect(current.statusCode).toBe(200);
      expect(current.json()).toMatchObject({
        operation: { batchId: completedBatch, state: "complete" },
        complete: true,
        pendingFreezeCount: 0
      });
      expect((await status(randomUUID())).statusCode).toBe(404);
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

describe("Desktop Personal Project lifecycle authorization", () => {
  it("uses the existing owner write credential for create, preview, delete, progress, status, cancel and restore", async () => {
    const home = mkdtempSync(join(tmpdir(), "koed-project-write-"));
    const app = Fastify();
    const batchId = randomUUID();
    let current: Project = { ...project };
    let operation: Record<string, unknown> | null = null;
    const operationFor = (id: string, state: string) => ({
      batchId: id,
      projectId,
      ownerUserId: owner,
      sources: [],
      executions: [],
      backendAcks: [],
      grantFreezeAcks: [],
      runtimeAcks: [],
      state,
      sourceManifestHash: "a".repeat(64),
      executionSetHash: "b".repeat(64)
    });
    const repository = {
      list: vi.fn(async () => ({ projects: [current], nextCursor: null })),
      create: vi.fn(async () => current),
      deletePreview: vi.fn(async () => ({
        project: current,
        executionSetHash: "b".repeat(64),
        activeExecutions: []
      })),
      listPendingReleaseOperations: vi.fn(async () => []),
      beginDelete: vi.fn(
        async (_owner: string, _id: string, value: { batchId: string }) => {
          operation = operationFor(value.batchId, "preparing");
          current = {
            ...current,
            version: current.version + 1,
            deletionPhase: "preparing",
            deleteBatchId: value.batchId
          };
          return current;
        }
      ),
      getDeleteOperation: vi.fn(async () => operation),
      getDeleteOperationByBatch: vi.fn(
        async (_owner: string, _id: string, id: string) =>
          operation?.batchId === id ? operation : null
      ),
      get: vi.fn(async () => current),
      markDeleteReady: vi.fn(async () => undefined),
      completeDelete: vi.fn(async () => {
        operation = operationFor(batchId, "complete");
        current = {
          ...current,
          version: current.version + 1,
          lifecycle: "deleted",
          deletionPhase: "complete",
          deletedAt: now
        };
        return current;
      }),
      cancelDelete: vi.fn(async () => {
        operation = operationFor(batchId, "cancelled");
        current = {
          ...current,
          version: current.version + 1,
          lifecycle: "active",
          deletionPhase: null,
          deleteBatchId: null,
          deletedAt: null
        };
        return current;
      }),
      restore: vi.fn(async () => {
        operation = operationFor(batchId, "restored");
        current = {
          ...current,
          version: current.version + 1,
          lifecycle: "active",
          deletionPhase: null,
          deleteBatchId: null,
          deletedAt: null
        };
        return current;
      })
    };
    const fallback = vi.fn(async () => ({ id: owner }));
    registerProjectRoutes(app, {
      repository: repository as never,
      managedRepository: {
        getManagedConversationExecution: vi.fn(),
        enqueueManagedConversationControl: vi.fn()
      } as never,
      sourceCoordinator: null,
      deploymentProfile: "local_personal",
      koedHome: home,
      auth: { authenticateSessionOrDeviceCredential: fallback } as never,
      readRateLimit: async () => undefined,
      writeRateLimit: async () => undefined
    });
    try {
      const readOnly = storeDesktopLocalCredential(home, {
        ownerUserId: owner,
        operationFamilies: ["personal_collaboration_read"]
      });
      const createPayload = { name: "Atlas", idempotencyKey: "desktop-create" };
      const denied = await app.inject({
        method: "POST",
        url: "/v1/projects",
        headers: { authorization: readOnly.authorization },
        payload: createPayload
      });
      expect(denied.statusCode).toBe(401);
      expect(repository.create).not.toHaveBeenCalled();
      deleteDesktopLocalCredential(home);
      const desktop = storeDesktopLocalCredential(home, {
        ownerUserId: owner,
        operationFamilies: [
          "personal_collaboration_read",
          "personal_collaboration_write"
        ]
      });
      const headers = { authorization: desktop.authorization };
      const create = await app.inject({
        method: "POST",
        url: "/v1/projects",
        headers,
        payload: createPayload
      });
      expect(create.statusCode, create.body).toBe(201);
      const preview = await app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/delete-preview`,
        headers
      });
      expect(preview.statusCode, preview.body).toBe(200);
      const begin = await app.inject({
        method: "DELETE",
        url: `/v1/projects/${projectId}`,
        headers,
        payload: { version: 1, batchId, executionSetHash: "b".repeat(64) }
      });
      expect(begin.statusCode, begin.body).toBe(202);
      expect(begin.json()).toMatchObject({
        operation: { batchId },
        complete: true,
        project: { lifecycle: "deleted" }
      });
      const status = await app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/delete-status?batchId=${batchId}`,
        headers
      });
      expect(status.statusCode, status.body).toBe(200);
      const restore = await app.inject({
        method: "POST",
        url: `/v1/projects/${projectId}/restore`,
        headers,
        payload: { version: current.version, batchId }
      });
      expect(restore.statusCode, restore.body).toBe(200);
      expect(restore.json()).toMatchObject({ lifecycle: "active" });
      const reconcile = await app.inject({
        method: "POST",
        url: `/v1/projects/${projectId}/restore-reconcile`,
        headers
      });
      expect(reconcile.statusCode, reconcile.body).toBe(200);
      expect(reconcile.json()).toMatchObject({ released: true });
      const releaseReads =
        repository.listPendingReleaseOperations.mock.calls.length;
      current = {
        ...current,
        deletionPhase: "preparing",
        deleteBatchId: randomUUID()
      };
      const staleRestore = await app.inject({
        method: "POST",
        url: `/v1/projects/${projectId}/restore-reconcile`,
        headers,
        payload: { batchId }
      });
      expect(staleRestore.statusCode).toBe(409);
      expect(repository.listPendingReleaseOperations).toHaveBeenCalledTimes(
        releaseReads
      );
      current = { ...current, deletionPhase: null, deleteBatchId: null };
      await repository.beginDelete(owner, projectId, { batchId });
      const progress = await app.inject({
        method: "POST",
        url: `/v1/projects/${projectId}/delete-progress`,
        headers
      });
      expect(progress.statusCode, progress.body).toBe(200);
      await repository.beginDelete(owner, projectId, { batchId });
      const cancel = await app.inject({
        method: "POST",
        url: `/v1/projects/${projectId}/delete-cancel`,
        headers,
        payload: { batchId }
      });
      expect(cancel.statusCode, cancel.body).toBe(200);
      expect(cancel.json()).toMatchObject({
        operation: { state: "cancelled" },
        cancellationPending: false
      });
      expect(fallback).not.toHaveBeenCalled();
      for (const [method, url, payload] of [
        [
          "GET",
          `/v1/projects/${projectId}/delete-status?batchId=${batchId}`,
          undefined
        ],
        ["POST", "/v1/projects", createPayload],
        [
          "DELETE",
          `/v1/projects/${projectId}`,
          { version: 1, batchId, executionSetHash: "b".repeat(64) }
        ]
      ] as const) {
        const remote = await app.inject({
          method,
          url,
          payload,
          headers,
          remoteAddress: "192.0.2.1"
        });
        expect(remote.statusCode).toBe(403);
      }
      const forged = await app.inject({
        method: "POST",
        url: "/v1/projects",
        headers: { authorization: `${desktop.authorization}forged` },
        payload: createPayload
      });
      expect(forged.statusCode).toBe(401);
      deleteDesktopLocalCredential(home);
      const revoked = await app.inject({
        method: "POST",
        url: "/v1/projects",
        headers,
        payload: createPayload
      });
      expect(revoked.statusCode).toBe(401);
      expect(repository.create).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("Project batch correlation", () => {
  it("rejects progress for a different current batch before runtime or grant work", async () => {
    const app = Fastify();
    const currentBatch = randomUUID();
    const requestedBatch = randomUUID();
    const managed = {
      getManagedConversationExecution: vi.fn(),
      enqueueManagedConversationControl: vi.fn()
    };
    const coordinator = { advance: vi.fn(), cancel: vi.fn() };
    const repository = {
      getDeleteOperation: vi.fn(async () => ({
        batchId: currentBatch,
        state: "preparing",
        sources: [],
        executions: [],
        backendAcks: [],
        grantFreezeAcks: [],
        runtimeAcks: []
      })),
      get: vi.fn(),
      markDeleteReady: vi.fn(),
      completeDelete: vi.fn()
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
        method: "POST",
        url: `/v1/projects/${projectId}/delete-progress`,
        payload: { batchId: requestedBatch }
      });
      expect(response.statusCode).toBe(409);
      expect(repository.get).not.toHaveBeenCalled();
      expect(managed.getManagedConversationExecution).not.toHaveBeenCalled();
      expect(managed.enqueueManagedConversationControl).not.toHaveBeenCalled();
      expect(coordinator.advance).not.toHaveBeenCalled();
      expect(repository.completeDelete).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
