import { verifyManagedJournalTerminal } from "@koed/db";
import { createFilesystemConversationSourceStorage } from "./conversation-source-storage.js";
import {
  readConversationSourceSegmentBytes,
  requireLocalJournalSurface
} from "./conversation-source-journal-routes.js";
import type { KoedWorkClass } from "@koed/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ApiRouteContext } from "../server/context.js";
import {
  conversationItemStableIdentityQuerySchema,
  createConversationItemsSchema,
  projectConversationItemsSchema,
  releaseConversationProjectionHoldSchema,
  releaseManagedJournalProjectionSchema,
  resetConversationProjectionSchema,
  resetConversationPresentationSchema,
  tokenUsageRollupQuerySchema,
  tokenUsageSchema
} from "./raw-conversation-schemas.js";

export const registerRawConversationRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
) => {
  const {
    requireRepository,
    auth: { authenticateApiToken, authenticateSession },
    capture: { scheduleProjectedMemoryEventProcessing },
    rateLimit: {
      memoryRead: memoryReadRateLimit,
      memoryWrite: memoryWriteRateLimit,
      projectionRebuild: projectionRebuildRateLimit
    }
  } = context;
  const projectionRebuildUsers = new WeakMap<FastifyRequest, { id: string }>();
  const authenticateProjectionRebuild = async (request: FastifyRequest) => {
    const user = await authenticateSession(request);
    projectionRebuildUsers.set(request, user);
  };
  const projectionRebuildUser = (request: FastifyRequest): { id: string } => {
    const user = projectionRebuildUsers.get(request);
    if (!user) {
      throw Object.assign(
        new Error("Projection rebuild authentication context is missing"),
        { statusCode: 500 }
      );
    }
    return user;
  };

  app.post(
    "/v1/memory/conversation-items/presentation/rebuild",
    {
      preHandler: [
        authenticateProjectionRebuild,
        memoryWriteRateLimit,
        projectionRebuildRateLimit
      ]
    },
    async (request) => {
      const repo = requireRepository();
      const user = projectionRebuildUser(request);
      const input = resetConversationPresentationSchema.parse(request.body);
      const reset = await repo.resetConversationPresentation(
        { userId: user.id },
        input
      );
      const presentation = await repo.projectPendingConversationItems(
        { userId: user.id },
        {
          visibility: "personal",
          conversationItemIds: reset.conversationItemIds,
          limit: Math.max(reset.conversationItemIds.length, 1),
          presentationOnly: true
        }
      );
      return { reset, presentation };
    }
  );

  app.post(
    "/v1/memory/conversation-items",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      const input = createConversationItemsSchema.parse(request.body);

      const items = await repo.createConversationItems(
        { userId: user.id },
        {
          items: input.items.map((item) => ({
            ...item,
            visibility: "personal" as const
          }))
        }
      );

      return {
        items,
        acceptedCount: input.items.length,
        canonicalItemCount: items.length,
        sourceObservationCount: input.items.length - items.length
      };
    }
  );

  app.get(
    "/v1/memory/conversation-items/by-stable-identity",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      const query = conversationItemStableIdentityQuerySchema.parse(
        request.query
      );
      return {
        item: await repo.findConversationItemByStableIdentity(
          { userId: user.id },
          {
            sessionId: query.session_id,
            canonicalStableItemId: query.canonical_stable_item_id
          }
        )
      };
    }
  );

  app.post(
    "/v1/memory/token-usage",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      const input = tokenUsageSchema.parse(request.body);
      const tokenUsage = await repo.recordWorkflowTokenUsage(
        { userId: user.id },
        {
          ...input,
          model: input.model ?? undefined,
          modelContextWindow: input.modelContextWindow ?? undefined,
          inputTokens: input.inputTokens ?? undefined,
          cachedInputTokens: input.cachedInputTokens ?? undefined,
          outputTokens: input.outputTokens ?? undefined,
          reasoningOutputTokens: input.reasoningOutputTokens ?? undefined,
          totalTokens: input.totalTokens ?? undefined
        }
      );

      return { tokenUsage };
    }
  );

  app.get(
    "/v1/memory/token-usage/rollups",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      const query = tokenUsageRollupQuerySchema.parse(request.query);

      return {
        rollups: await repo.listWorkflowTokenUsageRollups(
          { userId: user.id },
          {
            groupBy: query.group_by,
            includeEstimates: query.include_estimates,
            from: query.from,
            to: query.to
          }
        )
      };
    }
  );

  app.post(
    "/v1/memory/conversation-items/release-journal",
    { preHandler: context.rateLimit.sourceJournal },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      requireLocalJournalSurface(context);
      const input = releaseManagedJournalProjectionSchema.parse(request.body);
      const actor = { userId: user.id };
      const artifact = await repo.getConversationSourceArtifact(
        actor,
        input.artifactId
      );
      if (
        !artifact ||
        artifact.sessionId !== input.sessionId ||
        !["claude-code", "pi"].includes(artifact.sourceKind) ||
        artifact.journalStartOffset !== 0 ||
        input.sourceOffset > artifact.providerCursorOffset
      ) {
        throw Object.assign(
          new Error("Managed journal boundary is unavailable"),
          { statusCode: 409, code: "managed_terminal_journal_invalid" }
        );
      }
      const session = await repo.getCapturedSession(actor, input.sessionId);
      if (!session || session.metadata.managedConversation !== true) {
        throw Object.assign(
          new Error("Managed conversation session is unavailable"),
          { statusCode: 404 }
        );
      }
      const storage = createFilesystemConversationSourceStorage(
        context.config.koedHome
      );
      const chunks: Uint8Array[] = [];
      let offset = 0;
      let line = 0;
      while (offset < input.sourceOffset) {
        const segments = await repo.listConversationSourceSegments(actor, {
          artifactId: artifact.id,
          afterOffset: offset,
          limit: 100
        });
        if (segments.length === 0)
          throw Object.assign(new Error("Managed journal is incomplete"), {
            statusCode: 409
          });
        for (const segment of segments) {
          if (
            segment.sourceStartOffset !== offset ||
            segment.sourceStartLine !== line ||
            segment.sourceEndOffset <= offset
          ) {
            throw Object.assign(
              new Error("Managed journal segment chain is invalid"),
              { statusCode: 409 }
            );
          }
          const bytes = await readConversationSourceSegmentBytes(
            context,
            storage,
            segment
          );
          if (bytes.byteLength !== segment.sourceEndOffset - offset) {
            throw Object.assign(
              new Error("Managed journal segment size is invalid"),
              { statusCode: 409 }
            );
          }
          chunks.push(
            bytes.subarray(
              0,
              Math.min(bytes.length, input.sourceOffset - offset)
            )
          );
          offset = segment.sourceEndOffset;
          line = segment.sourceEndLine;
          if (offset >= input.sourceOffset) break;
        }
      }
      const proof = verifyManagedJournalTerminal({
        artifact,
        sourceOffset: input.sourceOffset,
        bytes: Buffer.concat(chunks)
      });
      return repo.releaseConversationProjectionHold(actor, {
        sessionId: input.sessionId,
        externalTurnId: `journal:${artifact.id}`,
        verifiedJournal: proof
      });
    }
  );

  app.post(
    "/v1/memory/conversation-items/release",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      const input = releaseConversationProjectionHoldSchema.parse(request.body);
      return repo.releaseConversationProjectionHold({ userId: user.id }, input);
    }
  );

  app.post(
    "/v1/memory/conversation-items/rebuild",
    {
      preHandler: [
        authenticateProjectionRebuild,
        memoryWriteRateLimit,
        projectionRebuildRateLimit
      ]
    },
    async (request) => {
      const repo = requireRepository();
      const user = projectionRebuildUser(request);
      const input = resetConversationProjectionSchema.parse(request.body);
      const reset = await repo.resetConversationProjection(
        { userId: user.id },
        input
      );
      const projection = {
        rawItemsScanned: 0,
        rawItemsProjected: 0,
        rawItemsWaitingForAgentSeal: 0,
        messagesCreated: 0,
        toolEventsCreated: 0,
        memoryEventsCreated: 0,
        tokenUsageRowsCreated: 0,
        memoryEventIds: [] as string[],
        memoryEventScopes: [] as Array<{
          eventId: string;
          visibility: "personal";
          includeInEmbedding: boolean;
          includeInLcm: boolean;
          workClass: KoedWorkClass;
        }>
      };
      for (
        let index = 0;
        index < reset.conversationItemIds.length;
        index += 1000
      ) {
        const conversationItemIds = reset.conversationItemIds.slice(
          index,
          index + 1000
        );
        const batch = await repo.projectPendingConversationItems(
          { userId: user.id },
          {
            visibility: "personal",
            conversationItemIds,
            limit: conversationItemIds.length
          }
        );
        projection.rawItemsScanned += batch.rawItemsScanned;
        projection.rawItemsProjected += batch.rawItemsProjected;
        projection.rawItemsWaitingForAgentSeal = Math.max(
          projection.rawItemsWaitingForAgentSeal,
          batch.rawItemsWaitingForAgentSeal
        );
        projection.messagesCreated += batch.messagesCreated;
        projection.toolEventsCreated += batch.toolEventsCreated;
        projection.memoryEventsCreated += batch.memoryEventsCreated;
        projection.tokenUsageRowsCreated += batch.tokenUsageRowsCreated;
        projection.memoryEventIds.push(...batch.memoryEventIds);
        projection.memoryEventScopes.push(...batch.memoryEventScopes);
      }
      projection.memoryEventIds = [...new Set(projection.memoryEventIds)];
      projection.memoryEventScopes = [
        ...new Map(
          projection.memoryEventScopes.map((scope) => [scope.eventId, scope])
        ).values()
      ];
      const processing = await scheduleProjectedMemoryEventProcessing(
        repo,
        { userId: user.id },
        projection.memoryEventScopes
      );
      return { reset, projection, processing };
    }
  );

  app.post(
    "/v1/memory/conversation-items/project",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      const input = projectConversationItemsSchema.parse(request.body);
      const projection = await repo.projectPendingConversationItems(
        { userId: user.id },
        {
          ...input,
          visibility: "personal",
          workClass: "live_capture_projection"
        }
      );
      const processing = await scheduleProjectedMemoryEventProcessing(
        repo,
        { userId: user.id },
        projection.memoryEventScopes
      );

      return { projection, processing };
    }
  );
};
