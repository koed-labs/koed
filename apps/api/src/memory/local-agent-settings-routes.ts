import {
  aiClientCapabilityIds,
  codeDefaultAssignmentFor,
  documentDefault,
  localAiClientFlowKeys
} from "@koed/shared";
import type { MemorySourceRepository } from "@koed/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiRouteContext } from "../server/context.js";
import {
  aiClientCapabilitySnapshotSchema,
  aiClientInstanceParamsSchema,
  aiClientInstanceSchema,
  localMemoryAgentSettingsParamsSchema,
  localMemoryAgentSettingsSchema
} from "./local-agent-settings-schemas.js";

type AssignmentInput = z.infer<typeof localMemoryAgentSettingsSchema>;
type AiClientInstance = Awaited<
  ReturnType<MemorySourceRepository["listAiClientInstances"]>
>[number];
type CapabilitySnapshot = Awaited<
  ReturnType<MemorySourceRepository["listCurrentAiClientCapabilitySnapshots"]>
>[number];

const assignmentUnavailable = (
  message: string
): Error & {
  statusCode: number;
} => Object.assign(new Error(message), { statusCode: 409 });

const documentedDefaults = () =>
  Object.fromEntries(
    localAiClientFlowKeys.map((flowKey) => [
      flowKey,
      (() => {
        const documented = documentDefault(codeDefaultAssignmentFor(flowKey));
        return { ...documented.assignment, ...documented };
      })()
    ])
  );

const modelIds = (model: Record<string, unknown>): string[] =>
  [model.id, model.fullId, model.model].flatMap((value) =>
    typeof value === "string" && value.trim() ? [value.trim()] : []
  );

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

const localSynthesisReady = (
  capabilities: Record<string, unknown>
): boolean => {
  const descriptors = capabilities.descriptors;
  if (!descriptors || typeof descriptors !== "object") return false;
  const descriptor = (descriptors as Record<string, unknown>)[
    aiClientCapabilityIds.localSynthesis
  ];
  if (!descriptor || typeof descriptor !== "object") return false;
  const value = descriptor as Record<string, unknown>;
  return value.support === "supported" && value.readiness === "ready";
};

const validateAssignment = (
  instances: AiClientInstance[],
  snapshots: CapabilitySnapshot[],
  input: AssignmentInput
) => {
  const instance = instances.find(
    (candidate) => candidate.instanceId === input.ai_client_instance_id
  );
  if (!instance) {
    throw assignmentUnavailable(
      `AI Client instance "${input.ai_client_instance_id}" is not configured`
    );
  }
  validateInstance(instance, input);
  const snapshot = snapshots.find(
    (candidate) => candidate.instanceId === input.ai_client_instance_id
  );
  validateSnapshot(snapshot, input);
  const selectedModel = snapshot!.models.find((candidate) =>
    modelIds(candidate).includes(input.model)
  );
  if (!selectedModel) {
    throw assignmentUnavailable(
      `Model "${input.model}" is not configured or reported for AI Client instance "${input.ai_client_instance_id}"`
    );
  }
  const supportedEfforts = supportedReasoningEfforts(selectedModel);
  if (!supportedEfforts || !supportedEfforts.includes(input.reasoning_effort)) {
    throw assignmentUnavailable(
      `Reasoning effort "${input.reasoning_effort}" is not reported for model "${input.model}" on AI Client instance "${input.ai_client_instance_id}"`
    );
  }
};

const validateInstance = (
  instance: AiClientInstance,
  input: AssignmentInput
) => {
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
};

const validateSnapshot = (
  snapshot: CapabilitySnapshot | undefined,
  input: AssignmentInput
) => {
  if (
    !snapshot ||
    snapshot.healthState !== "healthy" ||
    snapshot.authenticationState !== "authenticated"
  ) {
    throw assignmentUnavailable(
      `AI Client instance "${input.ai_client_instance_id}" has no current healthy authenticated capability snapshot`
    );
  }
  if (!localSynthesisReady(snapshot.capabilities)) {
    throw assignmentUnavailable(
      `AI Client instance "${input.ai_client_instance_id}" does not report ready local synthesis`
    );
  }
};

const registerInstanceListRoute = (
  app: FastifyInstance,
  context: ApiRouteContext
) => {
  const {
    requireRepository,
    auth: { authenticate },
    rateLimit
  } = context;
  app.get(
    "/v1/memory/ai-client-instances",
    { preHandler: rateLimit.memoryRead },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const actor = { userId: user.id };
      const [instances, capabilitySnapshots, settings] = await Promise.all([
        repo.listAiClientInstances(actor),
        repo.listAiClientCapabilitySnapshots(actor),
        repo.listLocalMemoryAgentSettings(actor)
      ]);
      return {
        instances,
        capabilitySnapshots,
        settings,
        defaults: documentedDefaults()
      };
    }
  );
};

const registerInstanceWriteRoute = (
  app: FastifyInstance,
  context: ApiRouteContext
) => {
  const {
    requireRepository,
    auth: { authenticate },
    rateLimit
  } = context;
  app.put(
    "/v1/memory/ai-client-instances/:instanceId",
    { preHandler: rateLimit.memoryWrite },
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
};

const registerCapabilitySnapshotRoute = (
  app: FastifyInstance,
  context: ApiRouteContext
) => {
  const {
    requireRepository,
    auth: { authenticate },
    rateLimit
  } = context;
  app.post(
    "/v1/memory/ai-client-instances/:instanceId/capability-snapshots",
    { preHandler: rateLimit.memoryWrite },
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
};

const registerSettingsListRoute = (
  app: FastifyInstance,
  context: ApiRouteContext
) => {
  const {
    requireRepository,
    auth: { authenticate },
    rateLimit
  } = context;
  app.get(
    "/v1/memory/local-agent-settings",
    { preHandler: rateLimit.memoryRead },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const actor = { userId: user.id };
      const [settings, instances, capabilitySnapshots] = await Promise.all([
        repo.listLocalMemoryAgentSettings(actor),
        repo.listAiClientInstances(actor),
        repo.listAiClientCapabilitySnapshots(actor)
      ]);
      return {
        settings,
        instances,
        capabilitySnapshots,
        defaults: documentedDefaults()
      };
    }
  );
};

const registerSettingsWriteRoute = (
  app: FastifyInstance,
  context: ApiRouteContext
) => {
  const {
    requireRepository,
    auth: { authenticate },
    rateLimit
  } = context;
  app.put(
    "/v1/memory/local-agent-settings/:flowKey",
    { preHandler: rateLimit.memoryWrite },
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
      validateAssignment(instances, snapshots, input);
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

const registerSettingsDeleteRoute = (
  app: FastifyInstance,
  context: ApiRouteContext
) => {
  const {
    requireRepository,
    auth: { authenticate },
    rateLimit
  } = context;
  app.delete(
    "/v1/memory/local-agent-settings/:flowKey",
    { preHandler: rateLimit.memoryWrite },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const params = localMemoryAgentSettingsParamsSchema.parse(request.params);
      const deleted = await repo.deleteLocalMemoryAgentSetting(
        { userId: user.id },
        params.flowKey
      );
      return { flow_key: params.flowKey, reset: deleted };
    }
  );
};

export const registerLocalAgentSettingsRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
) => {
  registerInstanceListRoute(app, context);
  registerInstanceWriteRoute(app, context);
  registerCapabilitySnapshotRoute(app, context);
  registerSettingsListRoute(app, context);
  registerSettingsWriteRoute(app, context);
  registerSettingsDeleteRoute(app, context);
};
