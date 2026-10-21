import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ApiRouteContext } from "../server/context.js";
import {
  createDeckSchema,
  createTeamDeckSchema,
  deckCardContentSchema,
  patchDeckSchema,
  patchDeckCardSchema,
  deckListSchema,
  deckSchema,
  deckProgressListSchema,
  putDeckProgressSchema,
  deckProgressSchema
} from "@koed/shared";
import {
  DeckUnavailableError,
  DeckConflictError,
  type createFlashcardDeckRepository
} from "@koed/db";
import { authenticateProjectOperation } from "./desktop-read-auth.js";

type Repository = ReturnType<typeof createFlashcardDeckRepository>;
const projectParam = z.object({ projectId: z.uuid() }).strict();
const deckParam = z.object({ projectId: z.uuid(), deckId: z.uuid() }).strict();
const cardParam = z
  .object({ projectId: z.uuid(), deckId: z.uuid(), cardId: z.uuid() })
  .strict();
export const registerDeckRoutes = (
  app: FastifyInstance,
  input: {
    repository: Repository | null;
    deploymentProfile: string;
    koedHome?: string;
    auth: ApiRouteContext["auth"];
    readRateLimit: ApiRouteContext["rateLimit"]["memoryRead"];
    writeRateLimit: ApiRouteContext["rateLimit"]["memoryWrite"];
  }
) => {
  const repo = () => {
    if (!input.repository)
      throw Object.assign(new Error("Decks unavailable"), { statusCode: 503 });
    return input.repository;
  };
  const handle = (e: unknown) => {
    if (e instanceof DeckUnavailableError)
      throw Object.assign(e, { statusCode: 404 });
    if (e instanceof DeckConflictError)
      throw Object.assign(e, { statusCode: 409 });
    throw e;
  };
  const personal = async (r: FastifyRequest, w: boolean) => {
    if (
      input.deploymentProfile !== "local_personal" &&
      input.deploymentProfile !== "developer"
    )
      throw Object.assign(
        new Error("Personal Decks require local deployment"),
        { statusCode: 403 }
      );
    return authenticateProjectOperation(r, input, w);
  };
  const team = async (r: FastifyRequest, w: boolean) =>
    input.auth.authenticateSessionOrDeviceCredential(
      r,
      w ? "team_workspace_write" : "team_workspace_read",
      { apiTokenError: "Personal API Tokens cannot access Workspace Projects" }
    );
  app.get(
    "/v1/projects/:projectId/decks",
    { preHandler: input.readRateLimit },
    async (r) => {
      const u = await personal(r, false);
      const { projectId } = projectParam.parse(r.params);
      try {
        return deckListSchema.parse(await repo().listPersonal(u.id, projectId));
      } catch (e) {
        return handle(e);
      }
    }
  );
  app.post(
    "/v1/projects/:projectId/decks",
    { preHandler: input.writeRateLimit },
    async (r, reply) => {
      const u = await personal(r, true);
      const { projectId } = projectParam.parse(r.params);
      const body = createDeckSchema.parse(r.body);
      try {
        return reply
          .code(201)
          .send(
            deckSchema.parse(await repo().createPersonal(u.id, projectId, body))
          );
      } catch (e) {
        return handle(e);
      }
    }
  );
  app.get(
    "/v1/projects/:projectId/decks/:deckId",
    { preHandler: input.readRateLimit },
    async (r) => {
      const u = await personal(r, false);
      const { projectId, deckId } = deckParam.parse(r.params);
      try {
        return deckSchema.parse(
          await repo().getPersonal(u.id, projectId, deckId)
        );
      } catch (e) {
        return handle(e);
      }
    }
  );
  app.patch(
    "/v1/projects/:projectId/decks/:deckId",
    { preHandler: input.writeRateLimit },
    async (r) => {
      const u = await personal(r, true);
      const { projectId, deckId } = deckParam.parse(r.params);
      try {
        return deckSchema.parse(
          await repo().patchDeck(
            u.id,
            projectId,
            deckId,
            false,
            patchDeckSchema.parse(r.body)
          )
        );
      } catch (e) {
        return handle(e);
      }
    }
  );
  app.delete(
    "/v1/projects/:projectId/decks/:deckId",
    { preHandler: input.writeRateLimit },
    async (r) => {
      const u = await personal(r, true);
      const { projectId, deckId } = deckParam.parse(r.params);
      try {
        return repo().deleteDeck(
          u.id,
          projectId,
          deckId,
          false,
          z
            .object({ expectedVersion: z.number().int().positive() })
            .strict()
            .parse(r.body).expectedVersion
        );
      } catch (e) {
        return handle(e);
      }
    }
  );
  app.post(
    "/v1/projects/:projectId/decks/:deckId/cards",
    { preHandler: input.writeRateLimit },
    async (r) => {
      const u = await personal(r, true);
      const { projectId, deckId } = deckParam.parse(r.params);
      const body = deckCardContentSchema
        .extend({ expectedDeckVersion: z.number().int().positive() })
        .parse(r.body);
      try {
        return deckSchema.parse(
          await repo().addCard(u.id, projectId, deckId, false, body)
        );
      } catch (e) {
        return handle(e);
      }
    }
  );
  app.patch(
    "/v1/projects/:projectId/decks/:deckId/cards/:cardId",
    { preHandler: input.writeRateLimit },
    async (r) => {
      const u = await personal(r, true);
      const { projectId, deckId, cardId } = cardParam.parse(r.params);
      try {
        return deckSchema.parse(
          await repo().patchCard(
            u.id,
            projectId,
            deckId,
            cardId,
            false,
            patchDeckCardSchema.parse(r.body)
          )
        );
      } catch (e) {
        return handle(e);
      }
    }
  );
  app.get(
    "/v1/projects/:projectId/deck-progress",
    { preHandler: input.readRateLimit },
    async (r) => {
      const u = await personal(r, false);
      const { projectId } = projectParam.parse(r.params);
      try {
        const result = await repo().progress(u.id, projectId);
        if (result.link.teamBackendId)
          throw new DeckUnavailableError(
            "Shared Deck progress requires live Team authority"
          );
        return deckProgressListSchema.parse({
          progress: result.progress.map((p) => ({
            cardId: p.cardId,
            box: p.box,
            nextAt: p.nextAt,
            misses: p.misses
          }))
        });
      } catch (e) {
        return handle(e);
      }
    }
  );
  app.put(
    "/v1/projects/:projectId/decks/:deckId/cards/:cardId/progress",
    { preHandler: input.writeRateLimit },
    async (r) => {
      const u = await personal(r, true);
      const { projectId, deckId, cardId } = cardParam.parse(r.params);
      const body = putDeckProgressSchema.parse(r.body);
      try {
        return deckProgressSchema.parse(
          await repo().putProgress(u.id, projectId, deckId, cardId, body)
        );
      } catch (e) {
        return handle(e);
      }
    }
  );
  app.get(
    "/v1/workspace-projects/:projectId/decks",
    { preHandler: input.readRateLimit },
    async (r) => {
      const u = await team(r, false);
      const { projectId } = projectParam.parse(r.params);
      try {
        return deckListSchema.parse(await repo().listTeam(u.id, projectId));
      } catch (e) {
        return handle(e);
      }
    }
  );
  app.post(
    "/v1/workspace-projects/:projectId/decks",
    { preHandler: input.writeRateLimit },
    async (r, reply) => {
      const u = await team(r, true);
      const { projectId } = projectParam.parse(r.params);
      const body = createTeamDeckSchema.parse(r.body);
      try {
        return reply
          .code(201)
          .send(
            deckSchema.parse(await repo().createTeam(u.id, projectId, body))
          );
      } catch (e) {
        return handle(e);
      }
    }
  );
  app.post(
    "/v1/workspace-projects/:projectId/decks/from-text-action",
    { preHandler: input.writeRateLimit },
    async (r, reply) => {
      if (!r.headers.authorization?.startsWith("Koed-Device "))
        return reply.code(403).send({ message: "Enrolled device required" });
      const u = await team(r, true);
      const { projectId } = projectParam.parse(r.params);
      const body = createTeamDeckSchema
        .extend({
          teamBackendId: z.string().min(1),
          runnerDeviceId: z.string().min(1),
          textActionNonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
          expectedProjectVersion: z.number().int().positive(),
          expectedMemberVersion: z.number().int().positive()
        })
        .strict()
        .parse(r.body);
      const {
        teamBackendId,
        runnerDeviceId,
        textActionNonce,
        expectedProjectVersion,
        expectedMemberVersion,
        ...payload
      } = body;
      const device = await input.auth.authenticateDeviceCredential(r, {
        fresh: true
      });
      if (
        device.user.id !== u.id ||
        device.credential.deviceInstanceId !== runnerDeviceId ||
        !device.credential.operationFamilies.includes("team_workspace_write")
      )
        return reply
          .code(403)
          .send({ message: "Reviewed device scope changed" });
      try {
        return reply.code(201).send(
          deckSchema.parse(
            await repo().createTeam(u.id, projectId, payload, {
              nonce: textActionNonce,
              teamBackendId,
              runnerDeviceId,
              deviceCredentialKeyId: device.credential.credentialKeyId,
              expectedProjectVersion,
              expectedMemberVersion
            })
          )
        );
      } catch (e) {
        return handle(e);
      }
    }
  );
  app.get(
    "/v1/workspace-projects/:projectId/decks/:deckId",
    { preHandler: input.readRateLimit },
    async (r) => {
      const u = await team(r, false);
      const { projectId, deckId } = deckParam.parse(r.params);
      try {
        return deckSchema.parse(await repo().getTeam(u.id, projectId, deckId));
      } catch (e) {
        return handle(e);
      }
    }
  );
  // Used only to reconcile an uncertain managed Deck generation outcome. The
  // key is an exact journal action ID; live Team read authority and creator
  // membership still decide whether the receipt is visible.
  app.get(
    "/v1/workspace-projects/:projectId/decks/by-creation-key/:key",
    { preHandler: input.readRateLimit },
    async (r, reply) => {
      const u = await team(r, false);
      const { projectId, key } = z
        .object({ projectId: z.uuid(), key: z.uuid() })
        .strict()
        .parse(r.params);
      if (!r.headers.authorization?.startsWith("Koed-Device "))
        return reply.code(403).send({ message: "Enrolled device required" });
      const device = await input.auth.authenticateDeviceCredential(r, {
        fresh: true
      });
      if (
        device.user.id !== u.id ||
        !device.credential.operationFamilies.includes("team_workspace_read")
      )
        return reply.code(403).send({ message: "Team read scope changed" });
      try {
        const receipt = await repo().getTeamByCreationKey(u.id, projectId, key);
        return receipt
          ? {
              deck: deckSchema.parse(receipt.deck),
              creationPayloadHash: z
                .string()
                .regex(/^[a-f0-9]{64}$/)
                .parse(receipt.creationPayloadHash),
              requestDeviceInstanceId: device.credential.deviceInstanceId
            }
          : reply.code(404).send({ message: "Deck creation not found" });
      } catch (e) {
        return handle(e);
      }
    }
  );
  app.get(
    "/v1/workspace-projects/:projectId/decks/by-source-deck/:sourceDeckId",
    { preHandler: input.readRateLimit },
    async (r, reply) => {
      const u = await team(r, false);
      const { projectId, sourceDeckId } = z
        .object({ projectId: z.uuid(), sourceDeckId: z.uuid() })
        .strict()
        .parse(r.params);
      try {
        const deck = await repo().getTeamBySourceDeckId(
          u.id,
          projectId,
          sourceDeckId
        );
        return deck
          ? deckSchema.parse(deck)
          : reply.code(404).send({ message: "Copied Deck not found" });
      } catch (e) {
        return handle(e);
      }
    }
  );
  app.patch(
    "/v1/workspace-projects/:projectId/decks/:deckId",
    { preHandler: input.writeRateLimit },
    async (r) => {
      const u = await team(r, true);
      const { projectId, deckId } = deckParam.parse(r.params);
      try {
        return deckSchema.parse(
          await repo().patchDeck(
            u.id,
            projectId,
            deckId,
            true,
            patchDeckSchema.parse(r.body)
          )
        );
      } catch (e) {
        return handle(e);
      }
    }
  );
  app.delete(
    "/v1/workspace-projects/:projectId/decks/:deckId",
    { preHandler: input.writeRateLimit },
    async (r) => {
      const u = await team(r, true);
      const { projectId, deckId } = deckParam.parse(r.params);
      try {
        return repo().deleteDeck(
          u.id,
          projectId,
          deckId,
          true,
          z
            .object({ expectedVersion: z.number().int().positive() })
            .strict()
            .parse(r.body).expectedVersion
        );
      } catch (e) {
        return handle(e);
      }
    }
  );
  app.post(
    "/v1/workspace-projects/:projectId/decks/:deckId/cards",
    { preHandler: input.writeRateLimit },
    async (r) => {
      const u = await team(r, true);
      const { projectId, deckId } = deckParam.parse(r.params);
      const body = deckCardContentSchema
        .extend({ expectedDeckVersion: z.number().int().positive() })
        .parse(r.body);
      try {
        return deckSchema.parse(
          await repo().addCard(u.id, projectId, deckId, true, body)
        );
      } catch (e) {
        return handle(e);
      }
    }
  );
  app.patch(
    "/v1/workspace-projects/:projectId/decks/:deckId/cards/:cardId",
    { preHandler: input.writeRateLimit },
    async (r) => {
      const u = await team(r, true);
      const { projectId, deckId, cardId } = cardParam.parse(r.params);
      try {
        return deckSchema.parse(
          await repo().patchCard(
            u.id,
            projectId,
            deckId,
            cardId,
            true,
            patchDeckCardSchema.parse(r.body)
          )
        );
      } catch (e) {
        return handle(e);
      }
    }
  );
  app.get(
    "/v1/workspace-projects/:projectId/deck-copy-map",
    { preHandler: input.readRateLimit },
    async (r) => {
      const u = await team(r, false);
      const { projectId } = projectParam.parse(r.params);
      try {
        return await repo().copyMapTeam(u.id, projectId);
      } catch (e) {
        return handle(e);
      }
    }
  );
  app.get(
    "/v1/workspace-projects/:projectId/copy-back-decks",
    { preHandler: input.readRateLimit },
    async (r) => {
      const u = await team(r, false);
      const { projectId } = projectParam.parse(r.params);
      const { expectedProjectVersion } = z
        .object({ expectedProjectVersion: z.coerce.number().int().positive() })
        .strict()
        .parse(r.query);
      try {
        return await repo().copyBackDecksTeam(
          u.id,
          projectId,
          expectedProjectVersion
        );
      } catch (e) {
        return handle(e);
      }
    }
  );
};
