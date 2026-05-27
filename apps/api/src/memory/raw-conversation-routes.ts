import type { FastifyInstance } from "fastify";
import type { ApiRouteContext } from "../server/context.js";
import {
  createConversationItemsSchema,
  projectConversationItemsSchema,
  tokenUsageSchema
} from "./raw-conversation-schemas.js";

export const registerRawConversationRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
) => {
  const {
    requireRepository,
    auth: { authenticateApiToken },
    capture: { scheduleProjectedMemoryEventProcessing },
    rateLimit: { memoryWrite: memoryWriteRateLimit }
  } = context;

  app.post(
    "/v1/memory/conversation-items",
    { preHandler: memoryWriteRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      const input = createConversationItemsSchema.parse(request.body);
      const nonPersonalItem = input.items.find(
        (item) => item.visibility === "team" || item.teamId
      );
      if (nonPersonalItem) {
        return reply.status(403).send({
          error:
            "API token raw conversation item capture is limited to Personal Memory"
        });
      }

      const items = await repo.createConversationItems(
        { userId: user.id },
        {
          items: input.items.map((item) => ({
            ...item,
            visibility: "personal" as const,
            teamId: undefined
          }))
        }
      );

      return { items };
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

  app.post(
    "/v1/memory/conversation-items/project",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      const input = projectConversationItemsSchema.parse(request.body);
      const projection = await repo.projectPendingConversationItems(
        { userId: user.id },
        { ...input, visibility: "personal" }
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
