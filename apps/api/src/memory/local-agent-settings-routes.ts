import type { FastifyInstance } from "fastify";
import type { ApiRouteContext } from "../server/context.js";
import {
  localMemoryAgentSettingsParamsSchema,
  localMemoryAgentSettingsSchema
} from "./local-agent-settings-schemas.js";

export const registerLocalAgentSettingsRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
) => {
  const {
    requireRepository,
    auth: { authenticate },
    rateLimit: {
      memoryRead: memoryReadRateLimit,
      memoryWrite: memoryWriteRateLimit
    }
  } = context;

  app.get(
    "/v1/memory/local-agent-settings",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const settings = await repo.listLocalMemoryAgentSettings({
        userId: user.id
      });
      return { settings };
    }
  );

  app.put(
    "/v1/memory/local-agent-settings/:flowKey",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const params = localMemoryAgentSettingsParamsSchema.parse(request.params);
      const input = localMemoryAgentSettingsSchema.parse(request.body);
      const setting = await repo.upsertLocalMemoryAgentSetting(
        { userId: user.id },
        {
          flowKey: params.flowKey,
          provider: input.provider,
          model: input.model,
          reasoningEffort: input.reasoning_effort,
          timeoutMs: input.timeout_ms,
          maxAttempts: input.max_attempts
        }
      );
      return { setting };
    }
  );
};
