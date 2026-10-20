import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  WorkItemConflictError,
  WorkItemCursorError,
  WorkItemGoneError,
  WorkItemTransitionError
} from "@koed/db";
import type { WorkItem } from "@koed/shared";
import { registerWorkItemRoutes } from "./routes.js";

const owner = randomUUID(),
  project = randomUUID(),
  id = randomUUID();
const now = "2026-10-20T00:00:00.000Z";
const item: WorkItem = {
  id,
  projectId: project,
  kind: "todo",
  key: null,
  title: "Call",
  goal: "Call Sam",
  origin: "manual",
  originRef: null,
  idempotencyKey: null,
  status: "todo",
  blockedReason: null,
  assigneeAgentId: null,
  executionId: null,
  dispatchKey: null,
  prProvider: null,
  prNumber: null,
  prUrl: null,
  prState: null,
  dueOn: null,
  doneAt: null,
  doneBy: null,
  createdBy: owner,
  createdAt: now,
  updatedAt: now,
  version: 1
};

const fixture = () => {
  const app = Fastify();
  const repository = {
    list: vi.fn(async () => ({
      items: [item],
      hasMore: false,
      nextCursor: null as string | null
    })),
    create: vi.fn(async () => item),
    patch: vi.fn(async () => item),
    deleteTodo: vi.fn(async () => undefined)
  };
  const authenticate = vi.fn(
    async (
      request: { headers: { authorization?: string } },
      family: string
    ) => {
      if (request.headers.authorization?.startsWith("Bearer "))
        throw Object.assign(
          new Error("API Tokens cannot authorize Work Item operations"),
          { statusCode: 403 }
        );
      if (
        family !== "personal_collaboration_read" &&
        family !== "personal_collaboration_write"
      )
        throw new Error("Wrong operation family");
      return { id: owner };
    }
  );
  registerWorkItemRoutes(app, {
    repository: repository as never,
    auth: { authenticateSessionOrDeviceCredential: authenticate } as never,
    readRateLimit: async () => undefined,
    writeRateLimit: async () => undefined
  });
  return { app, repository, authenticate };
};

describe("Work Item routes", () => {
  it("uses scoped auth and passes the authenticated owner to list/create", async () => {
    const { app, repository, authenticate } = fixture();
    try {
      const list = await app.inject({
        method: "GET",
        url: `/v1/projects/${project}/work-items`
      });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual({
        items: [item],
        hasMore: false,
        nextCursor: null
      });
      expect(repository.list).toHaveBeenCalledWith(owner, project, {
        limit: 100
      });
      const create = await app.inject({
        method: "POST",
        url: `/v1/projects/${project}/work-items`,
        payload: {
          kind: "todo",
          title: "Call",
          goal: "Call Sam",
          origin: "manual"
        }
      });
      expect(create.statusCode).toBe(201);
      expect(repository.create).toHaveBeenCalledWith(
        owner,
        project,
        expect.objectContaining({ kind: "todo" })
      );
      expect(authenticate).toHaveBeenCalledWith(
        expect.anything(),
        "personal_collaboration_write",
        expect.anything()
      );
    } finally {
      await app.close();
    }
  });
  it("validates page queries, forwards a cursor, and rejects a foreign cursor", async () => {
    const { app, repository } = fixture();
    try {
      for (const query of [
        "limit=0",
        "limit=1001",
        "limit=1.5",
        "limit=oops",
        "cursor="
      ]) {
        const response = await app.inject({
          method: "GET",
          url: `/v1/projects/${project}/work-items?${query}`
        });
        expect(response.statusCode).toBe(400);
      }
      expect(repository.list).not.toHaveBeenCalled();
      repository.list.mockResolvedValueOnce({
        items: [item],
        hasMore: true,
        nextCursor: "next"
      });
      const page = await app.inject({
        method: "GET",
        url: `/v1/projects/${project}/work-items?limit=1&cursor=opaque`
      });
      expect(page.statusCode).toBe(200);
      expect(page.json()).toMatchObject({ hasMore: true, nextCursor: "next" });
      expect(repository.list).toHaveBeenCalledWith(owner, project, {
        limit: 1,
        cursor: "opaque"
      });
      repository.list.mockRejectedValueOnce(
        new WorkItemCursorError("Foreign cursor")
      );
      const foreign = await app.inject({
        method: "GET",
        url: `/v1/projects/${project}/work-items?cursor=foreign`
      });
      expect(foreign.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
  it("rejects Personal API Tokens and never calls storage", async () => {
    const { app, repository } = fixture();
    try {
      const response = await app.inject({
        method: "GET",
        url: `/v1/projects/${project}/work-items`,
        headers: { authorization: "Bearer personal-token" }
      });
      expect(response.statusCode).toBe(403);
      expect(repository.list).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("does not let a browser claim a document or runtime origin", async () => {
    const { app, repository } = fixture();
    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/projects/${project}/work-items`,
        payload: {
          kind: "todo",
          title: "Call",
          goal: "Call Sam",
          origin: "plan",
          originRef: randomUUID()
        }
      });
      expect(response.statusCode).toBe(400);
      expect(repository.create).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("returns Gone for an exact replay after deletion", async () => {
    const { app, repository } = fixture();
    repository.create.mockRejectedValueOnce(
      new WorkItemGoneError("Work Item was deleted")
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/projects/${project}/work-items`,
        payload: {
          kind: "todo",
          title: "Call",
          goal: "Call Sam",
          origin: "manual",
          idempotencyKey: "deleted-key"
        }
      });
      expect(response.statusCode).toBe(410);
    } finally {
      await app.close();
    }
  });
  it("returns current record on optimistic conflict and blocks ticket deletion", async () => {
    const { app, repository } = fixture();
    repository.patch.mockRejectedValueOnce(
      new WorkItemConflictError("Version conflict", item)
    );
    repository.deleteTodo.mockRejectedValueOnce(
      new WorkItemTransitionError("Only to-dos can be deleted")
    );
    try {
      const patch = await app.inject({
        method: "PATCH",
        url: `/v1/work-items/${id}`,
        payload: { version: 1, action: "mark_done" }
      });
      expect(patch.statusCode).toBe(409);
      expect(patch.json().current).toMatchObject({ id, version: 1 });
      const deletion = await app.inject({
        method: "DELETE",
        url: `/v1/work-items/${id}`
      });
      expect(deletion.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });
});
