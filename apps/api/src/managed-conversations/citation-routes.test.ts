import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { ApiRouteContext } from "../server/context.js";
import { registerManagedConversationRoutes } from "./routes.js";

describe("managed citation list current-access boundary", () => {
  it("rechecks Personal titles and never returns retained titles after source loss or Team revocation", async () => {
    const ownerId = randomUUID();
    const executionId = randomUUID();
    const backendId = randomUUID();
    const sourceId = randomUUID();
    const questionId = randomUUID();
    const citation = {
      alias: `r${randomUUID().replaceAll("-", "")}c1`,
      providerTurnId: "turn-1",
      sourceType: "memory_node",
      sourceId,
      visibility: "personal",
      detailAvailable: true,
      title: "Retained private title",
      summary: "Retained private evidence"
    };
    const current = {
      sourceType: "memory_node",
      sourceId,
      sourceOwnerPrincipalId: ownerId,
      title: "Current authorized title"
    };
    const locator = {
      backendId,
      questionId,
      ordinal: 0,
      sourceType: "memory_node",
      sourceId,
      visibility: "personal",
      sourceOwnerPrincipalId: ownerId
    };
    const getManagedPersonalQuestionCitation = vi
      .fn()
      .mockResolvedValue(current);
    const getManagedConversationCitationLocator = vi
      .fn()
      .mockResolvedValue(locator);
    const listManagedConversationCitationsByAliases = vi
      .fn()
      .mockResolvedValue([citation]);
    const getManagedConversationExecution = vi
      .fn()
      .mockResolvedValue({ id: executionId });
    const app = Fastify();
    registerManagedConversationRoutes(app, {
      config: { deploymentProfile: "private_vps" },
      encryption: { envelopeEncryptionProvider: {} },
      auth: {
        authenticateSessionOrDeviceCredential: async () => ({ id: ownerId })
      },
      rateLimit: {
        memoryRead: async () => undefined,
        memoryWrite: async () => undefined
      },
      deploymentIdentity: {
        inspect: () => ({ deploymentId: backendId, health: "healthy" })
      },
      requireRepository: () => ({
        getManagedConversationExecution,
        listManagedConversationCitationsByAliases,
        getManagedConversationCitationLocator,
        getManagedPersonalQuestionCitation
      })
    } as unknown as ApiRouteContext);
    try {
      const read = () =>
        app.inject({
          method: "GET",
          url: `/v1/managed-conversations/${executionId}/turn-citations?aliases=${citation.alias}`
        });
      const first = await read();
      expect(first.statusCode).toBe(200);
      expect(first.json().citations).toEqual([
        { ...citation, title: current.title, summary: null }
      ]);
      expect(getManagedPersonalQuestionCitation).toHaveBeenCalledWith(
        { userId: ownerId, allowTeam: false },
        { questionId, ordinal: 0 }
      );
      for (const missing of [
        null,
        { ...current, sourceOwnerPrincipalId: randomUUID() },
        { ...current, sourceId: randomUUID() }
      ]) {
        getManagedPersonalQuestionCitation.mockResolvedValueOnce(missing);
        const denied = await read();
        expect(denied.json().citations[0]).toMatchObject({
          detailAvailable: false,
          title: "Memory source unavailable",
          summary: null
        });
        expect(denied.body).not.toContain("Retained private");
      }
      getManagedPersonalQuestionCitation.mockRejectedValueOnce(
        new Error("Source revoked")
      );
      expect((await read()).json().citations[0].detailAvailable).toBe(false);
      getManagedConversationCitationLocator.mockResolvedValueOnce({
        ...locator,
        backendId: randomUUID()
      });
      expect((await read()).json().citations[0].detailAvailable).toBe(false);
      getManagedPersonalQuestionCitation.mockClear();
      listManagedConversationCitationsByAliases.mockResolvedValueOnce([
        { ...citation, visibility: "team" }
      ]);
      const team = await read();
      expect(team.json().citations[0]).toMatchObject({
        detailAvailable: false,
        title: "Team memory",
        summary: null
      });
      expect(team.body).not.toContain("Retained private");
      expect(getManagedPersonalQuestionCitation).not.toHaveBeenCalled();
      getManagedConversationExecution.mockResolvedValueOnce(null);
      expect((await read()).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
