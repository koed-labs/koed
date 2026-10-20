import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { ProjectCapabilityError } from "@koed/db";
import { registerProjectSourceRoutes } from "./source-routes.js";

const owner = randomUUID();
const projectId = randomUUID();
const sourceId = randomUUID();
const source = {
  id: sourceId,
  projectId,
  kind: "skill" as const,
  name: "review",
  uri: null,
  currentRevisionId: null,
  status: "ready" as const,
  failureReason: null,
  addedBy: owner,
  uses: 0,
  deletedAt: null,
  createdAt: "2026-10-20T00:00:00.000Z"
};
const fixture = () => {
  const app = Fastify();
  const repository = {
    list: vi.fn(async () => [source]),
    create: vi.fn(async () => source),
    remove: vi.fn(async () => ({
      ...source,
      deletedAt: "2026-10-20T00:00:00.000Z"
    })),
    retry: vi.fn(async () => {
      throw new ProjectCapabilityError(
        "Project Source retry is unavailable until ingestion is enabled"
      );
    })
  };
  registerProjectSourceRoutes(app, {
    repository: repository as never,
    deploymentProfile: "developer",
    auth: {
      authenticateSessionOrDeviceCredential: vi.fn(async () => ({ id: owner }))
    } as never,
    readRateLimit: async () => undefined,
    writeRateLimit: async () => undefined
  });
  return { app, repository };
};

describe("Project Source routes", () => {
  it("authenticates owner reads and rejects caller-controlled status and usage", async () => {
    const { app, repository } = fixture();
    try {
      const read = await app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/sources`
      });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toEqual({ sources: [source] });
      expect(repository.list).toHaveBeenCalledWith(owner, projectId);
      const invalid = await app.inject({
        method: "POST",
        url: `/v1/projects/${projectId}/sources`,
        payload: {
          kind: "skill",
          name: "review",
          status: "ready",
          uses: 100
        }
      });
      expect(invalid.statusCode).toBe(400);
      expect(repository.create).not.toHaveBeenCalled();
      const created = await app.inject({
        method: "POST",
        url: `/v1/projects/${projectId}/sources`,
        payload: { kind: "skill", name: "review" }
      });
      expect(created.statusCode).toBe(201);
      expect(repository.create).toHaveBeenCalledWith(owner, projectId, {
        kind: "skill",
        name: "review"
      });
    } finally {
      await app.close();
    }
  });

  it("removes exact sources and reports retry unavailable without mutating", async () => {
    const { app, repository } = fixture();
    try {
      const removed = await app.inject({
        method: "DELETE",
        url: `/v1/projects/${projectId}/sources/${sourceId}`
      });
      expect(removed.statusCode).toBe(200);
      expect(repository.remove).toHaveBeenCalledWith(
        owner,
        projectId,
        sourceId
      );
      const retry = await app.inject({
        method: "POST",
        url: `/v1/projects/${projectId}/sources/${sourceId}/retry`
      });
      expect(retry.statusCode).toBe(503);
      expect(repository.retry).toHaveBeenCalledWith(owner, projectId, sourceId);
    } finally {
      await app.close();
    }
  });
});
