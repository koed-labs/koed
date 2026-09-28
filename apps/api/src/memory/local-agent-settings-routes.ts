import { createHash } from "node:crypto";

import {
  aiClientCapabilityIds,
  codeDefaultAssignmentFor,
  documentDefault,
  localAiClientFlowKeys
} from "@koed/shared";
import type { MemorySourceRepository } from "@koed/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
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
const localPublicationProfiles = new Set(["developer", "local_personal"]);
const deviceScopedIdentityHash = (
  sourceDeviceCredentialId: string | null,
  identityHash: string | null | undefined
): string | null => {
  if (identityHash == null || sourceDeviceCredentialId === null) {
    return identityHash ?? null;
  }
  return createHash("sha256")
    .update(`${sourceDeviceCredentialId}\0${identityHash}`)
    .digest("hex");
};

const assignmentUnavailable = (
  message: string
): Error & {
  statusCode: number;
} => Object.assign(new Error(message), { statusCode: 409 });

const parseRequestBody = <Schema extends z.ZodType>(
  schema: Schema,
  body: unknown
): z.infer<Schema> => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw Object.assign(new Error("Request body is invalid"), {
      statusCode: 400
    });
  }
  return parsed.data;
};

const authenticateInstancePublisher = async (
  request: FastifyRequest,
  context: ApiRouteContext
): Promise<{
  userId: string;
  sourceDeviceCredentialId: string | null;
  sourceDeviceLabel: string | null;
}> => {
  const scheme = request.headers.authorization
    ?.trim()
    .split(/\s+/, 1)[0]
    ?.toLowerCase();
  if (scheme === "koed-device") {
    const auth = await context.auth.authenticateDeviceCredential(request);
    if (
      !auth.credential.operationFamilies.includes(
        "ai_client_capability_publish"
      )
    ) {
      throw Object.assign(
        new Error(
          "Device credential is not allowed to publish AI Client capabilities"
        ),
        { statusCode: 403 }
      );
    }
    return {
      userId: auth.user.id,
      sourceDeviceCredentialId: auth.credential.id,
      sourceDeviceLabel: auth.credential.deviceLabel
    };
  }
  if (!localPublicationProfiles.has(context.config.deploymentProfile)) {
    throw Object.assign(
      new Error(
        "An enrolled device credential is required to publish AI Client capabilities"
      ),
      { statusCode: 403 }
    );
  }
  const user = await context.auth.authenticate(request);
  return {
    userId: user.id,
    sourceDeviceCredentialId: null,
    sourceDeviceLabel: null
  };
};

const publicAiClientInstance = <
  T extends { sourceDeviceCredentialId: unknown }
>(
  instance: T
): Omit<T, "sourceDeviceCredentialId"> => {
  const {
    sourceDeviceCredentialId: _sourceDeviceCredentialId,
    ...publicRecord
  } = instance;
  void _sourceDeviceCredentialId;
  return publicRecord;
};

const publicCapabilitySnapshot = <
  T extends { sourceDeviceCredentialId: unknown }
>(
  snapshot: T
): Omit<T, "sourceDeviceCredentialId"> => {
  const {
    sourceDeviceCredentialId: _sourceDeviceCredentialId,
    ...publicRecord
  } = snapshot;
  void _sourceDeviceCredentialId;
  return publicRecord;
};

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

const assignmentCapabilityReady = (
  capabilities: Record<string, unknown>,
  conversations: boolean
): boolean => {
  const descriptors = capabilities.descriptors;
  if (!descriptors || typeof descriptors !== "object") return false;
  const descriptor = (descriptors as Record<string, unknown>)[
    conversations
      ? aiClientCapabilityIds.managedConversationStart
      : aiClientCapabilityIds.localSynthesis
  ];
  if (!descriptor || typeof descriptor !== "object") return false;
  const value = descriptor as Record<string, unknown>;
  return value.support === "supported" && value.readiness === "ready";
};

const validateAssignment = (
  instances: AiClientInstance[],
  snapshots: CapabilitySnapshot[],
  input: AssignmentInput,
  conversations: boolean
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
  validateSnapshot(snapshot, input, conversations);
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
  input: AssignmentInput,
  conversations: boolean
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
  if (!assignmentCapabilityReady(snapshot.capabilities, conversations)) {
    throw assignmentUnavailable(
      `AI Client instance "${input.ai_client_instance_id}" does not report ready ${conversations ? "conversation start" : "local synthesis"}`
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
    { preHandler: rateLimit.aiClientControl },
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
        instances: instances.map(publicAiClientInstance),
        capabilitySnapshots: capabilitySnapshots.map(publicCapabilitySnapshot),
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
  const { requireRepository, rateLimit } = context;
  app.put(
    "/v1/memory/ai-client-instances/:instanceId",
    { preHandler: rateLimit.aiClientControl },
    async (request) => {
      const repo = requireRepository();
      const actor = await authenticateInstancePublisher(request, context);
      const params = aiClientInstanceParamsSchema.parse(request.params);
      const input = parseRequestBody(aiClientInstanceSchema, request.body);
      const instance = await repo.upsertAiClientInstance(
        { userId: actor.userId },
        {
          instanceId: params.instanceId,
          sourceDeviceCredentialId: actor.sourceDeviceCredentialId,
          sourceDeviceLabel: actor.sourceDeviceLabel,
          driverId: input.driver_id,
          displayName: input.display_name,
          configIdentityHash: deviceScopedIdentityHash(
            actor.sourceDeviceCredentialId,
            input.config_identity_hash
          ),
          enabled: input.enabled
        }
      );
      return { instance: publicAiClientInstance(instance) };
    }
  );
};

const registerCapabilitySnapshotRoute = (
  app: FastifyInstance,
  context: ApiRouteContext
) => {
  const { requireRepository, rateLimit } = context;
  app.post(
    "/v1/memory/ai-client-instances/:instanceId/capability-snapshots",
    { preHandler: rateLimit.aiClientControl },
    async (request) => {
      const repo = requireRepository();
      const actor = await authenticateInstancePublisher(request, context);
      const params = aiClientInstanceParamsSchema.parse(request.params);
      const input = parseRequestBody(
        aiClientCapabilitySnapshotSchema,
        request.body
      );
      const configuredInstances = await repo.listAiClientInstances({
        userId: actor.userId
      });
      if (
        !configuredInstances.some(
          (instance) =>
            instance.instanceId === params.instanceId &&
            instance.sourceDeviceCredentialId === actor.sourceDeviceCredentialId
        )
      ) {
        throw Object.assign(
          new Error(
            `AI Client instance "${params.instanceId}" is not configured`
          ),
          { statusCode: 409 }
        );
      }
      const capabilitySnapshot = await repo.recordAiClientCapabilitySnapshot(
        { userId: actor.userId },
        {
          instanceId: params.instanceId,
          sourceDeviceCredentialId: actor.sourceDeviceCredentialId,
          installationIdentityHash: deviceScopedIdentityHash(
            actor.sourceDeviceCredentialId,
            input.installation_identity_hash
          )!,
          clientVersion: input.client_version,
          authenticationState: input.authentication_state,
          healthState: input.health_state,
          models: input.models,
          capabilities: input.capabilities,
          observedAt: input.observed_at,
          expiresAt: input.expires_at
        }
      );
      return {
        capabilitySnapshot: publicCapabilitySnapshot(capabilitySnapshot)
      };
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
    { preHandler: rateLimit.aiClientControl },
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
        instances: instances.map(publicAiClientInstance),
        capabilitySnapshots: capabilitySnapshots.map(publicCapabilitySnapshot),
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
    { preHandler: rateLimit.aiClientControl },
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
      validateAssignment(
        instances,
        snapshots,
        input,
        params.flowKey === "conversations"
      );
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
    { preHandler: rateLimit.aiClientControl },
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
