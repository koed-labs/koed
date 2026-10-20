import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerProjectActivityRoutes } from "./activity-routes.js";

describe("Project activity HTTP authority", () => {
  it("uses owner-scoped session/device authority, denies API Tokens, and never appends from HTTP", async () => {
    const app = Fastify();
    const owner = randomUUID();
    const project = randomUUID();
    const repository = {
      list: vi.fn(async () => ({
        items: [],
        hasMore: false,
        nextCursor: null
      })),
      seen: vi.fn(async () => ({ cursor: "cursor", at: null })),
      acknowledge: vi.fn(async () => ({
        cursor: "cursor",
        at: new Date().toISOString()
      }))
    };
    const authenticateSessionOrDeviceCredential = vi.fn(
      async (
        request: { headers: { authorization?: string } },
        family: string
      ) => {
        if (request.headers.authorization?.startsWith("Bearer "))
          throw Object.assign(
            new Error("API Tokens cannot authorize Project operations"),
            { statusCode: 403 }
          );
        expect([
          "personal_collaboration_read",
          "personal_collaboration_write"
        ]).toContain(family);
        return { id: owner };
      }
    );
    registerProjectActivityRoutes(app, {
      repository: repository as never,
      deploymentProfile: "developer",
      auth: { authenticateSessionOrDeviceCredential } as never,
      readRateLimit: async () => undefined,
      writeRateLimit: async () => undefined
    });
    try {
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/v1/projects/${project}/activity?limit=2`
          })
        ).statusCode
      ).toBe(200);
      expect(repository.list).toHaveBeenCalledWith(owner, project, {
        limit: 2
      });
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/v1/projects/${project}/activity/seen`
          })
        ).statusCode
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: "PUT",
            url: `/v1/projects/${project}/activity/seen`,
            payload: { cursor: "cursor" }
          })
        ).statusCode
      ).toBe(200);
      expect(repository.acknowledge).toHaveBeenCalledWith(
        owner,
        project,
        "cursor"
      );
      expect(
        (
          await app.inject({
            method: "PUT",
            url: `/v1/projects/${project}/activity/seen`,
            headers: { authorization: "Bearer token" },
            payload: { cursor: "cursor" }
          })
        ).statusCode
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/v1/projects/${project}/activity`,
            payload: { kind: "work_item_created" }
          })
        ).statusCode
      ).toBe(404);
    } finally {
      await app.close();
    }
  });
});
