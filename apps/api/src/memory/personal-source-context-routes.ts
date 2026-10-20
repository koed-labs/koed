import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  personalSourceCorrectionInputSchema,
  personalSourceCorrectionApplySchema
} from "@koed/shared";
import type { ApiRouteContext } from "../server/context.js";

const sourceParams = z.object({ sessionId: z.uuid() }).strict();
export const registerPersonalSourceContextRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
) => {
  const {
    requireRepository,
    auth: { authenticate },
    rateLimit: { memoryRead: read, memoryWrite: write }
  } = context;
  app.get(
    "/v1/personal/sessions/:sessionId/source-context",
    { preHandler: read },
    async (request) => {
      const user = await authenticate(request),
        { sessionId } = sourceParams.parse(request.params);
      return requireRepository().getPersonalSourceContext(
        { userId: user.id },
        sessionId
      );
    }
  );
  app.post(
    "/v1/personal/sessions/:sessionId/source-context/reviews",
    { preHandler: write },
    async (request) => {
      const user = await authenticate(request),
        { sessionId } = sourceParams.parse(request.params);
      return requireRepository().previewPersonalSourceCorrection(
        { userId: user.id },
        sessionId,
        personalSourceCorrectionInputSchema.parse(request.body)
      );
    }
  );
  app.post(
    "/v1/personal/sessions/:sessionId/source-context/reviews/:reviewId/apply",
    { preHandler: write },
    async (request) => {
      const user = await authenticate(request),
        { sessionId, reviewId } = sourceParams
          .extend({ reviewId: z.uuid() })
          .strict()
          .parse(request.params);
      const { expectedVersion } = personalSourceCorrectionApplySchema.parse(
        request.body
      );
      return requireRepository().applyPersonalSourceCorrection(
        { userId: user.id },
        sessionId,
        reviewId,
        { expectedVersion }
      );
    }
  );
};
