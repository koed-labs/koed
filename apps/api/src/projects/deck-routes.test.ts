import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import type { ApiRouteContext } from "../server/context.js";
import type { createFlashcardDeckRepository } from "@koed/db";
import { registerDeckRoutes } from "./deck-routes.js";

const userId = randomUUID(),
  projectId = randomUUID(),
  deckId = randomUUID(),
  cardId = randomUUID();
const date = new Date().toISOString();
const deck = {
  id: deckId,
  projectId,
  title: "Chapter 7",
  scope: "Midterm",
  madeFrom: "Course pack",
  createdByAgentId: null,
  uses: 0,
  version: 1,
  createdAt: date,
  updatedAt: date,
  cards: [
    {
      id: cardId,
      deckId,
      question: "Q",
      answer: "A",
      sourceRef: "Course pack",
      topicLabel: "Topic",
      version: 1,
      createdAt: date,
      updatedAt: date
    }
  ]
};
const fixture = async () => {
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) =>
    reply
      .code(
        error instanceof z.ZodError
          ? 400
          : ((error as { statusCode?: number }).statusCode ?? 500)
      )
      .send({
        message: error instanceof Error ? error.message : "Unexpected error"
      })
  );
  const createPersonal = vi.fn(async () => deck),
    createTeam = vi.fn(async () => deck),
    getTeam = vi.fn(async () => deck),
    putProgress = vi.fn(async () => ({
      cardId,
      box: 1,
      nextAt: null,
      misses: 0
    }));
  const auth = vi.fn(
    async (
      request: { headers: { authorization?: string } },
      _family: string,
      options?: { apiTokenError?: string }
    ) => {
      if (request.headers.authorization?.startsWith("Bearer "))
        throw Object.assign(new Error(options?.apiTokenError ?? "Denied"), {
          statusCode: 403
        });
      return { id: userId };
    }
  );
  registerDeckRoutes(app, {
    repository: {
      createPersonal,
      createTeam,
      getTeam,
      putProgress
    } as unknown as ReturnType<typeof createFlashcardDeckRepository>,
    deploymentProfile: "developer",
    auth: {
      authenticateSessionOrDeviceCredential: auth
    } as unknown as ApiRouteContext["auth"],
    readRateLimit: async () => undefined,
    writeRateLimit: async () => undefined
  });
  await app.ready();
  return { app, createPersonal, createTeam, getTeam, putProgress, auth };
};
describe("Flashcard Deck routes", () => {
  it("binds Personal creation to authenticated owner and validates content", async () => {
    const f = await fixture();
    try {
      const payload = {
        idempotencyKey: randomUUID(),
        title: "Chapter 7",
        scope: "Midterm",
        madeFrom: "Course pack",
        cards: [{ question: "Q", answer: "A" }]
      };
      const response = await f.app.inject({
        method: "POST",
        url: `/v1/projects/${projectId}/decks`,
        payload
      });
      expect(response.statusCode).toBe(201);
      expect(f.createPersonal).toHaveBeenCalledWith(userId, projectId, payload);
      expect(
        (
          await f.app.inject({
            method: "POST",
            url: `/v1/projects/${projectId}/decks`,
            payload: { ...payload, cards: [{ question: "", answer: "A" }] }
          })
        ).statusCode
      ).toBe(400);
    } finally {
      await f.app.close();
    }
  });
  it("rejects Personal API Tokens on Team content and never accepts a user selector", async () => {
    const f = await fixture();
    try {
      expect(
        (
          await f.app.inject({
            method: "GET",
            url: `/v1/workspace-projects/${projectId}/decks/${deckId}`,
            headers: { authorization: "Bearer token" }
          })
        ).statusCode
      ).toBe(403);
      expect(f.getTeam).not.toHaveBeenCalled();
      const result = await f.app.inject({
        method: "GET",
        url: `/v1/workspace-projects/${projectId}/decks/${deckId}`
      });
      expect(result.statusCode).toBe(200);
      expect(f.getTeam).toHaveBeenCalledWith(userId, projectId, deckId);
      const progress = await f.app.inject({
        method: "PUT",
        url: `/v1/projects/${projectId}/decks/${deckId}/cards/${cardId}/progress`,
        payload: { box: 1, nextAt: null, misses: 0, userId: randomUUID() }
      });
      expect(progress.statusCode).toBe(400);
      expect(f.putProgress).not.toHaveBeenCalled();
    } finally {
      await f.app.close();
    }
  });
  it("does not permit unverified Agent provenance on Team creation", async () => {
    const f = await fixture();
    try {
      const response = await f.app.inject({
        method: "POST",
        url: `/v1/workspace-projects/${projectId}/decks`,
        payload: {
          idempotencyKey: randomUUID(),
          title: "Team",
          scope: "",
          madeFrom: "",
          createdByAgentId: randomUUID(),
          cards: [{ question: "Q", answer: "A" }]
        }
      });
      expect(response.statusCode).toBe(400);
      expect(f.createTeam).not.toHaveBeenCalled();
    } finally {
      await f.app.close();
    }
  });
});
