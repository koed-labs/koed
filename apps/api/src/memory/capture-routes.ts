import { capturePersonalEvent } from "@koed/core";
import type { FastifyInstance } from "fastify";
import { publicUser } from "../auth/session.js";
import type { ApiRouteContext } from "../server/context.js";
import {
  capturedSessionQuerySchema,
  capturePersonalEventSchema,
  capturePoliciesQuerySchema,
  capturePolicySchema,
  createMcpSessionSchema,
  effectivePolicyQuerySchema,
  latestCapturedSessionQuerySchema,
  mcpSessionEventSchema,
  sessionIdParamsSchema
} from "./capture-schemas.js";

export const registerCaptureRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
) => {
  const {
    requireRepository,
    auth: { authenticate, authenticateApiToken },
    capture: {
      rejectUnsupportedCapturePolicy,
      resolveCapturePolicyForRequest,
      scheduleMemoryEventProcessing
    },
    rateLimit: {
      memoryRead: memoryReadRateLimit,
      memoryWrite: memoryWriteRateLimit
    }
  } = context;

  app.get(
    "/v1/access/check",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);

      return {
        ok: true,
        auth: "bearer_api_token",
        user: publicUser(user),
        canWritePersonal: true,
        providerConfigSupported: false,
        embeddingRetrieval: await repo.getLocalEmbeddingStatus()
      };
    }
  );

  app.get(
    "/v1/capture-policy/effective",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      const query = effectivePolicyQuerySchema.parse(request.query);
      return {
        policy: await repo.getEffectiveCapturePolicy({ userId: user.id }, query)
      };
    }
  );

  app.get(
    "/v1/capture-policies",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const query = capturePoliciesQuerySchema.parse(request.query);
      return {
        policies: await repo.listCapturePolicies(
          { userId: user.id },
          query.targetType
        )
      };
    }
  );

  app.put(
    "/v1/capture-policies",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const input = capturePolicySchema.parse(request.body);
      return {
        policy: await repo.upsertCapturePolicy({ userId: user.id }, input)
      };
    }
  );

  app.post(
    "/v1/sessions",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      const input = createMcpSessionSchema.parse(request.body);
      const policy = await resolveCapturePolicyForRequest(
        repo,
        { userId: user.id },
        {
          workspaceId: input.cwd ?? input.workspaceId,
          threadId: input.externalSessionId
        }
      );
      rejectUnsupportedCapturePolicy(policy);
      if (policy.captureState !== "enabled") {
        return { skipped: true, reason: "capture_disabled", policy };
      }
      const session = await repo.createCapturedSession(
        { userId: user.id },
        input
      );

      return { session, policy };
    }
  );

  app.get(
    "/v1/sessions/latest",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      const query = latestCapturedSessionQuerySchema.parse(request.query);
      const session = await repo.getLatestCapturedSessionForProject(
        { userId: user.id },
        { workspaceId: query.workspace_id }
      );
      if (!session) {
        throw Object.assign(
          new Error("No Personal Captured Session found for Project"),
          { statusCode: 404 }
        );
      }
      return { session };
    }
  );

  app.get(
    "/v1/sessions/:sessionId",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      const params = sessionIdParamsSchema.parse(request.params);
      const query = capturedSessionQuerySchema.parse(request.query);
      const session = await repo.getCapturedSession(
        { userId: user.id },
        params.sessionId
      );
      if (!session) {
        throw Object.assign(new Error("Captured Session not found"), {
          statusCode: 404
        });
      }
      if (query.workspace_id && session.workspaceId !== query.workspace_id) {
        throw Object.assign(
          new Error("Captured Session does not belong to Project"),
          { statusCode: 404 }
        );
      }
      return { session };
    }
  );

  app.post(
    "/v1/sessions/:sessionId/events",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const params = sessionIdParamsSchema.parse(request.params);
      const input = mcpSessionEventSchema.parse(request.body);
      const requesterContext = { userId: user.id };
      const policy = await resolveCapturePolicyForRequest(
        repo,
        requesterContext,
        { workspaceId: input.workspaceId, sessionId: params.sessionId }
      );
      rejectUnsupportedCapturePolicy(policy);
      if (policy.captureState !== "enabled") {
        return { skipped: true, reason: "capture_disabled", policy };
      }
      const event = await capturePersonalEvent({
        repository: repo,
        requesterContext,
        workspaceId: input.workspaceId,
        sessionId: params.sessionId,
        turnId: input.turnId,
        actor: input.actor,
        eventType: input.eventType,
        content: input.content,
        metadata: input.metadata,
        visibility: policy.visibility
      });
      const processing = await scheduleMemoryEventProcessing(
        repo,
        requesterContext,
        event.id,
        event.visibility
      );

      return {
        event,
        policy,
        processing,
        compaction: processing.compaction.compaction
      };
    }
  );

  app.post(
    "/v1/memory/capture-personal-event",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateApiToken(request);
      const input = capturePersonalEventSchema.parse(request.body);
      const requesterContext = { userId: user.id };
      const policy = await resolveCapturePolicyForRequest(
        repo,
        requesterContext,
        {
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          threadId:
            typeof input.metadata.externalSessionId === "string"
              ? input.metadata.externalSessionId
              : undefined
        }
      );
      rejectUnsupportedCapturePolicy(policy);
      if (policy.captureState !== "enabled") {
        return { skipped: true, reason: "capture_disabled", policy };
      }
      const event = await capturePersonalEvent({
        repository: repo,
        requesterContext,
        ...input,
        visibility: policy.visibility
      });
      const processing = await scheduleMemoryEventProcessing(
        repo,
        requesterContext,
        event.id,
        event.visibility
      );

      return {
        event,
        policy,
        processing,
        compaction: processing.compaction.compaction
      };
    }
  );
};
