import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerPersonalSourceContextRoutes } from "./personal-source-context-routes.js";
import type { ApiRouteContext } from "../server/context.js";

describe("Conversation organization route", () => {
  it("uses authenticated ownership and rejects caller authority before the repository", async () => {
    const sessionId = "00000000-0000-4000-8000-000000000001",
      userId = "00000000-0000-4000-8000-000000000002";
    const axis = {
      revision: 1,
      original: { state: "unresolved", reason: "historical_unresolved" },
      correction: { state: "original" }
    };
    const edit = {
      expectedContext: {
        sessionId,
        logicalSessionId: sessionId,
        git: axis,
        folder: axis
      },
      reviewedProjects: [],
      memberships: [],
      corrections: [{ axis: "git", action: "reset", expectedVersion: 1 }]
    };
    const organize = vi.fn(async () => ({ saved: true })),
      write = vi.fn(async () => {});
    const app = Fastify();
    registerPersonalSourceContextRoutes(app, {
      requireRepository: () => ({ organizePersonalConversation: organize }),
      auth: { authenticate: async () => ({ id: userId }) },
      rateLimit: { memoryRead: async () => {}, memoryWrite: write }
    } as unknown as ApiRouteContext);
    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/personal/sessions/${sessionId}/organization`,
        payload: edit
      });
      expect(response.statusCode).toBe(200);
      expect(organize).toHaveBeenCalledWith({ userId }, sessionId, edit);
      const denied = await app.inject({
        method: "POST",
        url: `/v1/personal/sessions/${sessionId}/organization`,
        payload: { ...edit, userId: "another-owner" }
      });
      expect(denied.statusCode).toBeGreaterThanOrEqual(400);
      expect(organize).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });
});
