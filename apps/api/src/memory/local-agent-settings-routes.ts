import type { FastifyInstance } from "fastify";
import type { ApiRouteContext } from "../server/context.js";
import {
  aiClientCapabilitySnapshotSchema,
  aiClientInstanceParamsSchema,
  aiClientInstanceSchema,
  localMemoryAgentSettingsParamsSchema,
  localMemoryAgentSettingsSchema
} from "./local-agent-settings-schemas.js";

const assignmentUnavailable = (
  message: string
): Error & {
  statusCode: number;
} => Object.assign(new Error(message), { statusCode: 409 });

const modelId = (model: Record<string, unknown>): string | null => {
  const value = model.model ?? model.id;
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

const supportedReasoningEfforts = (
  model: Record<string, unknown>
): string[] | null => {
  if (!Array.isArray(model.supportedReasoningEfforts)) return null;
  return model.supportedReasoningEfforts.flatMap((candidate) => {
    if (typeof candidate === "string") return [candidate];
    if (!candidate || typeof candidate !== "object") return [];
    const effort = (candidate as Record<string, unknown>).reasoningEffort;
    return typeof effort === "string" ? [effort] : [];
  });
};

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
    "/v1/memory/ai-client-instances",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const actor = { userId: user.id };
      const [instances, capabilitySnapshots] = await Promise.all([
        repo.listAiClientInstances(actor),
        repo.listCurrentAiClientCapabilitySnapshots(actor)
      ]);
      return { instances, capabilitySnapshots };
    }
  );

  app.put(
    "/v1/memory/ai-client-instances/:instanceId",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const params = aiClientInstanceParamsSchema.parse(request.params);
      const input = aiClientInstanceSchema.parse(request.body);
      const instance = await repo.upsertAiClientInstance(
        { userId: user.id },
        {
          instanceId: params.instanceId,
          driverId: input.driver_id,
          displayName: input.display_name,
          configIdentityHash: input.config_identity_hash,
          enabled: input.enabled
        }
      );
      return { instance };
    }
  );

  app.post(
    "/v1/memory/ai-client-instances/:instanceId/capability-snapshots",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const params = aiClientInstanceParamsSchema.parse(request.params);
      const input = aiClientCapabilitySnapshotSchema.parse(request.body);
      const capabilitySnapshot = await repo.recordAiClientCapabilitySnapshot(
        { userId: user.id },
        {
          instanceId: params.instanceId,
          installationIdentityHash: input.installation_identity_hash,
          clientVersion: input.client_version,
          authenticationState: input.authentication_state,
          healthState: input.health_state,
          models: input.models,
          capabilities: input.capabilities,
          observedAt: input.observed_at,
          expiresAt: input.expires_at
        }
      );
      return { capabilitySnapshot };
    }
  );

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
      const actor = { userId: user.id };
      const [instances, snapshots] = await Promise.all([
        repo.listAiClientInstances(actor),
        repo.listCurrentAiClientCapabilitySnapshots(actor)
      ]);
      const instance = instances.find(
        (candidate) => candidate.instanceId === input.ai_client_instance_id
      );
      if (!instance) {
        throw assignmentUnavailable(
          `AI Client instance "${input.ai_client_instance_id}" is not configured`
        );
      }
      if (!instance.enabled) {
        throw assignmentUnavailable(
          `AI Client instance "${input.ai_client_instance_id}" is disabled`
        );
      }
      if (instance.driverId !== input.provider) {
        throw assignmentUnavailable(
          `AI Client instance "${input.ai_client_instance_id}" belongs to driver "${instance.driverId}"`
        );
      }
      const snapshot = snapshots.find(
        (candidate) => candidate.instanceId === input.ai_client_instance_id
      );
      if (
        !snapshot ||
        snapshot.healthState !== "healthy" ||
        snapshot.authenticationState !== "authenticated"
      ) {
        throw assignmentUnavailable(
          `AI Client instance "${input.ai_client_instance_id}" has no current healthy authenticated capability snapshot`
        );
      }
      const selectedModel = snapshot.models.find(
        (candidate) => modelId(candidate) === input.model
      );
      if (!selectedModel) {
        throw assignmentUnavailable(
          `Model "${input.model}" is not configured or reported for AI Client instance "${input.ai_client_instance_id}"`
        );
      }
      const supportedEfforts = supportedReasoningEfforts(selectedModel);
      if (
        (input.provider === "claude" || input.provider === "pi") &&
        (!supportedEfforts ||
          !supportedEfforts.includes(input.reasoning_effort))
      ) {
        throw assignmentUnavailable(
          `Reasoning effort "${input.reasoning_effort}" is not reported for model "${input.model}" on AI Client instance "${input.ai_client_instance_id}"`
        );
      }
      const setting = await repo.upsertLocalMemoryAgentSetting(actor, {
        flowKey: params.flowKey,
        provider: input.provider,
        aiClientInstanceId: input.ai_client_instance_id,
        model: input.model,
        reasoningEffort: input.reasoning_effort,
        timeoutMs: input.timeout_ms,
        maxAttempts: input.max_attempts
      });
      return { setting };
    }
  );
};
