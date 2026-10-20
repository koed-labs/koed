import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiRouteContext } from "../server/context.js";
import { registerQuestionRoutes } from "./questions-routes.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("managed Personal citation detail route", () => {
  it("returns only the repository's current owner-scoped source detail", async () => {
    const ownerId = randomUUID();
    const questionId = randomUUID();
    const sourceId = randomUUID();
    const deploymentId = randomUUID();
    const current = {
      questionId,
      ordinal: 0,
      citation: { sourceType: "memory_node", sourceId, title: "Old title" },
      sourceType: "memory_node",
      sourceId,
      sourceOwnerPrincipalId: ownerId,
      title: "Current title",
      summary: "Current summary",
      kind: null,
      provenance: "Your memory summary",
      replaces: null,
      messageLink: null
    };
    const getManagedPersonalQuestionCitation = vi
      .fn()
      .mockResolvedValue(current);
    const app = Fastify();
    apps.push(app);
    registerQuestionRoutes(app, {
      requireRepository: () => ({ getManagedPersonalQuestionCitation }),
      auth: { authenticateApiToken: async () => ({ id: ownerId }) },
      deploymentIdentity: {
        inspect: () => ({ health: "healthy", deploymentId })
      },
      rateLimit: { memoryRead: async () => {}, memoryWrite: async () => {} }
    } as unknown as ApiRouteContext);
    const url = `/v1/memory/questions/${questionId}/managed-citations/0`;
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      detail: { ...current, sourceDeploymentId: deploymentId }
    });
    expect(getManagedPersonalQuestionCitation).toHaveBeenCalledWith(
      { userId: ownerId, allowTeam: false },
      { questionId, ordinal: 0 }
    );
    getManagedPersonalQuestionCitation.mockResolvedValueOnce(null);
    const forgotten = await app.inject({ method: "GET", url });
    expect(forgotten.statusCode).toBe(404);
    expect(forgotten.body).not.toContain("Old title");
  });

  it("links only the currently owner-visible source message graph event", async () => {
    const ownerId = randomUUID();
    const questionId = randomUUID();
    const messageId = randomUUID();
    const sessionId = randomUUID();
    const deploymentId = randomUUID();
    const detail = {
      questionId,
      ordinal: 1,
      citation: { sourceType: "message", sourceId: messageId },
      sourceType: "message",
      sourceId: messageId,
      sourceOwnerPrincipalId: ownerId,
      title: "Current message",
      summary: "Current message summary",
      kind: null,
      provenance: "Your message",
      replaces: null,
      messageLink: null
    };
    const event = {
      id: messageId,
      sessionId,
      projectId: "captured-project",
      threadId: "captured-thread",
      visibility: "personal",
      invalidatedAt: null,
      metadata: { sourceTable: "messages" }
    };
    const getLcmGraphEvent = vi.fn().mockResolvedValue(event);
    const app = Fastify();
    apps.push(app);
    registerQuestionRoutes(app, {
      requireRepository: () => ({
        getManagedPersonalQuestionCitation: async () => detail,
        getLcmGraphEvent
      }),
      auth: { authenticateApiToken: async () => ({ id: ownerId }) },
      deploymentIdentity: {
        inspect: () => ({ health: "healthy", deploymentId })
      },
      rateLimit: { memoryRead: async () => {}, memoryWrite: async () => {} }
    } as unknown as ApiRouteContext);
    const url = `/v1/memory/questions/${questionId}/managed-citations/1`;
    expect(
      (await app.inject({ method: "GET", url })).json().detail
    ).toMatchObject({
      messageTarget: {
        messageId,
        sessionId,
        projectId: "captured-project",
        threadId: "captured-thread"
      }
    });
    expect(getLcmGraphEvent).toHaveBeenCalledWith(
      { userId: ownerId },
      messageId,
      { includeContent: false, includeRaw: false }
    );
    for (const changed of [
      { id: randomUUID() },
      { visibility: "team" },
      { invalidatedAt: new Date().toISOString() },
      { metadata: { sourceTable: "tool_events" } },
      { sessionId: null },
      { projectId: null },
      { threadId: null }
    ]) {
      getLcmGraphEvent.mockResolvedValueOnce({ ...event, ...changed });
      expect(
        (await app.inject({ method: "GET", url })).json().detail
      ).not.toHaveProperty("messageTarget");
    }
    getLcmGraphEvent.mockResolvedValueOnce(null);
    expect(
      (await app.inject({ method: "GET", url })).json().detail
    ).not.toHaveProperty("messageTarget");
  });
});
