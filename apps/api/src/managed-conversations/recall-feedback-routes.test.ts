import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import Fastify from "fastify";
import { personalMemoryAttributionFooter } from "@koed/shared";
import { describe, expect, it, vi } from "vitest";
import type { ApiRouteContext } from "../server/context.js";
import { registerManagedConversationRoutes } from "./routes.js";

const userId = randomUUID();
const executionId = randomUUID();
const commandId = randomUUID();
const nonce = randomUUID();
const timestamp = "2026-10-01T00:00:00.000Z";

const makeApp = (overrides: Record<string, unknown> = {}) => {
  const attribution = personalMemoryAttributionFooter({
    commandId,
    nonce,
    attribution: { used: true, citationNodeIds: ["node-1"] }
  });
  const repository = {
    getManagedConversationExecution: vi.fn(async () => ({
      id: executionId,
      ownerUserId: userId
    })),
    getManagedConversationCommand: vi.fn(async (_actor: unknown, id: string) =>
      id !== commandId
        ? null
        : {
            id: commandId,
            ownerUserId: userId,
            executionId,
            commandKind: "prompt",
            state: "completed",
            payload: {
              personalMemoryContext: {
                schemaVersion: 1,
                status: "available",
                attributionNonce: nonce,
                searchDomain: "global",
                projectId: null,
                evidence: [
                  {
                    nodeId: "node-1",
                    summaryText: "private summary stays outside feedback",
                    citation: {},
                    visibility: "personal"
                  }
                ]
              }
            }
          }
    ),
    getManagedConversationPromptHistoryAnswer: vi.fn(async () => ({
      commandId,
      assistantOutput: { text: `Answer\n${attribution}`, truncated: false },
      personalMemoryContext: {
        schemaVersion: 1,
        status: "available",
        attributionNonce: nonce,
        searchDomain: "global",
        projectId: null,
        evidence: [
          {
            nodeId: "node-1",
            summaryText: "private summary stays outside feedback",
            citation: {},
            visibility: "personal"
          }
        ]
      }
    })),
    getRecallFeedback: vi.fn(async () => null),
    putRecallFeedback: vi.fn(async () => ({
      rating: "down" as const,
      comment: "Please cite the source",
      updatedAt: timestamp
    })),
    ...overrides
  };
  const upstreamPath = resolve(
    mkdtempSync(resolve(tmpdir(), "koed-recall-feedback-route-")),
    "upstream.json"
  );
  writeFileSync(
    upstreamPath,
    JSON.stringify({
      schemaVersion: 2,
      updatedAt: timestamp,
      activeBackendId: null,
      backends: []
    })
  );
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const typed = error as Error & { statusCode?: number };
    reply
      .status(typed.statusCode ?? ("issues" in typed ? 400 : 500))
      .send({ error: typed.message });
  });
  registerManagedConversationRoutes(app, {
    config: { deploymentProfile: "local_personal" },
    encryption: { envelopeEncryptionProvider: {} },
    auth: { authenticate: async () => ({ id: userId }) },
    rateLimit: {
      memoryRead: async () => undefined,
      memoryWrite: async () => undefined
    },
    localEdge: {
      upstreamBackendsPath: upstreamPath,
      remoteOperationsAllowed: () => true,
      resolveUpstreamAuthorization: () => null,
      fetch: vi.fn()
    },
    requireRepository: () => repository
  } as unknown as ApiRouteContext);
  return { app, repository };
};

describe("managed recalled-answer feedback routes", () => {
  it("reads authorized answer feedback even when no feedback exists yet", async () => {
    const { app, repository } = makeApp();
    await app.ready();
    const response = await app.inject({
      method: "GET",
      url: `/v1/managed-conversations/${executionId}/recall-feedback/${encodeURIComponent(`provider:${commandId}`)}`
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ feedback: null });
    expect(repository.getRecallFeedback).toHaveBeenCalledWith(
      { userId },
      { executionId, answerKind: "provider", answerId: commandId }
    );
  });

  it("accepts only QA fields and returns no answer evidence or copied source text", async () => {
    const { app, repository } = makeApp();
    await app.ready();
    const response = await app.inject({
      method: "PUT",
      url: `/v1/managed-conversations/${executionId}/recall-feedback/${encodeURIComponent(`provider:${commandId}`)}`,
      payload: { rating: "down", comment: "Please cite the source" }
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      feedback: {
        rating: "down",
        comment: "Please cite the source",
        updatedAt: timestamp
      }
    });
    expect(response.body).not.toContain("private summary");
    expect(repository.putRecallFeedback).toHaveBeenCalledWith(
      { userId },
      expect.objectContaining({
        executionId,
        answerKind: "provider",
        answerId: commandId,
        rating: "down",
        comment: "Please cite the source",
        sourceReferences: [
          expect.objectContaining({ nodeId: "node-1", visibility: "personal" })
        ]
      })
    );
  });

  it("fails closed when the execution is not owner-visible", async () => {
    const { app, repository } = makeApp({
      getManagedConversationExecution: vi.fn(async () => null)
    });
    await app.ready();
    const response = await app.inject({
      method: "GET",
      url: `/v1/managed-conversations/${executionId}/recall-feedback/${encodeURIComponent(`provider:${commandId}`)}`
    });
    await app.close();

    expect(response.statusCode).toBe(404);
    expect(repository.getManagedConversationCommand).not.toHaveBeenCalled();
  });

  it("rejects incomplete, extra, and malformed target writes", async () => {
    const { app, repository } = makeApp();
    await app.ready();
    const baseUrl = `/v1/managed-conversations/${executionId}/recall-feedback/${encodeURIComponent(`provider:${commandId}`)}`;
    const empty = await app.inject({
      method: "PUT",
      url: baseUrl,
      payload: {}
    });
    const extra = await app.inject({
      method: "PUT",
      url: baseUrl,
      payload: { rating: "up", sourceText: "do not accept" }
    });
    const target = await app.inject({
      method: "PUT",
      url: `/v1/managed-conversations/${executionId}/recall-feedback/${encodeURIComponent(`provider:${randomUUID()}`)}`,
      payload: { rating: "up" }
    });
    await app.close();

    expect(empty.statusCode).toBe(400);
    expect(extra.statusCode).toBe(400);
    expect(target.statusCode).toBe(404);
    expect(repository.putRecallFeedback).not.toHaveBeenCalled();
  });
});
