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
  aiClientUsageAccountSchema,
  aiClientUsageCompletionSchema,
  aiClientUsageSnapshotsSchema,
  localMemoryAgentSettingsParamsSchema,
  localMemoryAgentSettingsSchema
} from "./local-agent-settings-schemas.js";
import { createHash, randomUUID } from "node:crypto";
import type { AiClientUsageCompletion } from "@koed/shared";

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
    { preHandler: rateLimit.aiClientControl },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const params = aiClientInstanceParamsSchema.parse(request.params);
      const input = aiClientInstanceSchema.parse(request.body);
      const previous = (
        await repo.listAiClientInstances({ userId: user.id })
      ).find((candidate) => candidate.instanceId === params.instanceId);
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
      if (
        previous &&
        (previous.driverId !== instance.driverId ||
          previous.configIdentityHash !== instance.configIdentityHash ||
          previous.enabled !== instance.enabled)
      ) {
        const binding = (
          await repo.listAiClientUsageAccountBindings({ userId: user.id })
        ).find((candidate) => candidate.instanceId === params.instanceId);
        if (binding)
          await repo.setAiClientUsageAccount(
            { userId: user.id },
            {
              instanceId: params.instanceId,
              accountIdentityHash: null,
              profileScopeHash: binding.profileScopeHash,
              observedAt: new Date().toISOString()
            }
          );
      }
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
    { preHandler: rateLimit.aiClientControl },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticate(request);
      const params = aiClientInstanceParamsSchema.parse(request.params);
      const input = aiClientCapabilitySnapshotSchema.parse(request.body);
      const configuredInstances = await repo.listAiClientInstances({
        userId: user.id
      });
      if (
        !configuredInstances.some(
          (instance) => instance.instanceId === params.instanceId
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

const registerUsageRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
) => {
  if (context.config.runtimeMode === "external") return;
  const {
    requireRepository,
    auth: { authenticate },
    rateLimit
  } = context;
  const profileScope = (request: { headers: Record<string, unknown> }) =>
    z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .parse(request.headers["x-koed-ai-client-profile-scope"]);
  const listeners = new Map<
    string,
    Set<{
      profileScopeHash: string;
      send: (event: AiClientUsageCompletion) => void;
      close: () => void;
    }>
  >();
  app.addHook("onClose", () => {
    for (const subscribers of listeners.values()) {
      for (const subscriber of [...subscribers]) subscriber.close();
    }
    listeners.clear();
  });
  const bindingFingerprint = async (
    ownerId: string,
    profileScopeHash: string
  ) => {
    const bindings = (
      await requireRepository().listAiClientUsageAccountBindings({
        userId: ownerId
      })
    ).filter((binding) => binding.profileScopeHash === profileScopeHash);
    const enabledInstanceIds = (
      await requireRepository().listAiClientInstances({ userId: ownerId })
    )
      .filter((instance) => instance.enabled)
      .map((instance) => instance.instanceId)
      .sort();
    return createHash("sha256")
      .update(JSON.stringify({ bindings, enabledInstanceIds }))
      .digest("hex");
  };
  const publish = (
    ownerId: string,
    profileScopeHash: string,
    event: AiClientUsageCompletion
  ) => {
    for (const listener of listeners.get(ownerId) ?? [])
      if (listener.profileScopeHash === profileScopeHash) listener.send(event);
  };
  const configured = async (userId: string, instanceId: string) =>
    (await requireRepository().listAiClientInstances({ userId })).some(
      (instance) => instance.instanceId === instanceId && instance.enabled
    );
  app.get(
    "/v1/memory/ai-client-instances/usage",
    {
      preHandler: rateLimit.aiClientControl
    },
    async (request) => {
      const user = await authenticate(request);
      const scope = profileScope(request);
      const before = await bindingFingerprint(user.id, scope);
      const enabledIds = new Set(
        (await requireRepository().listAiClientInstances({ userId: user.id }))
          .filter((instance) => instance.enabled)
          .map((instance) => instance.instanceId)
      );
      const snapshots = (
        await requireRepository().listCurrentAiClientUsageSnapshots(
          { userId: user.id },
          scope
        )
      )
        .filter((snapshot) => enabledIds.has(snapshot.instanceId))
        .map((snapshot) => ({
          instanceId: snapshot.instanceId,
          source: snapshot.source,
          bucketId: snapshot.bucketId,
          bucketName: snapshot.bucketName,
          window: snapshot.window,
          windowDurationMins: snapshot.windowDurationMins,
          usedPercent: snapshot.usedPercent,
          status: snapshot.status,
          resetsAt: snapshot.resetsAt,
          planType: snapshot.planType,
          details: snapshot.details,
          observedAt: snapshot.observedAt
        }));
      const after = await bindingFingerprint(user.id, scope);
      if (before !== after)
        throw assignmentUnavailable(
          "AI Client usage account changed during read."
        );
      return {
        snapshots,
        authorityGeneration: after
      };
    }
  );
  app.get(
    "/v1/memory/ai-client-instances/usage/authority",
    {
      preHandler: rateLimit.aiClientControl
    },
    async (request) => {
      const user = await authenticate(request);
      const scope = profileScope(request);
      return {
        authorityGeneration: await bindingFingerprint(user.id, scope),
        allowedInstanceIds: (
          await requireRepository().listAiClientInstances({ userId: user.id })
        )
          .filter((instance) => instance.enabled)
          .map((instance) => instance.instanceId)
      };
    }
  );
  app.put(
    "/v1/memory/ai-client-instances/:instanceId/usage/account",
    {
      preHandler: rateLimit.aiClientControl
    },
    async (request) => {
      const user = await authenticate(request);
      const { instanceId } = aiClientInstanceParamsSchema.parse(request.params);
      const input = aiClientUsageAccountSchema.parse(request.body);
      if (!(await configured(user.id, instanceId)))
        throw assignmentUnavailable("AI Client instance is unavailable.");
      const before = await bindingFingerprint(
        user.id,
        input.profile_scope_hash
      );
      const accepted = await requireRepository().setAiClientUsageAccount(
        { userId: user.id },
        {
          instanceId,
          accountIdentityHash: input.account_identity_hash,
          profileScopeHash: input.profile_scope_hash,
          observedAt: input.observed_at
        }
      );
      if (
        accepted &&
        before !== (await bindingFingerprint(user.id, input.profile_scope_hash))
      ) {
        for (const subscriber of [...(listeners.get(user.id) ?? [])])
          subscriber.close();
      }
      return { accepted };
    }
  );
  app.post(
    "/v1/memory/ai-client-instances/:instanceId/usage/snapshots",
    {
      preHandler: rateLimit.aiClientControl
    },
    async (request) => {
      const user = await authenticate(request);
      const { instanceId } = aiClientInstanceParamsSchema.parse(request.params);
      const input = aiClientUsageSnapshotsSchema.parse(request.body);
      if (!(await configured(user.id, instanceId)))
        throw assignmentUnavailable("AI Client instance is unavailable.");
      const snapshots = await requireRepository().recordAiClientUsageSnapshots(
        { userId: user.id },
        {
          instanceId,
          accountIdentityHash: input.account_identity_hash,
          profileScopeHash: input.profile_scope_hash,
          observedAt: input.observed_at,
          readings: input.readings
        }
      );
      if (snapshots.length)
        publish(user.id, input.profile_scope_hash, {
          instanceId,
          completionId: randomUUID(),
          outcome: "checked",
          observedAt: input.observed_at
        });
      return { snapshots };
    }
  );
  app.post(
    "/v1/memory/ai-client-instances/:instanceId/usage/completions",
    {
      preHandler: rateLimit.aiClientControl
    },
    async (request) => {
      const user = await authenticate(request);
      const { instanceId } = aiClientInstanceParamsSchema.parse(request.params);
      const input = aiClientUsageCompletionSchema.parse(request.body);
      if (!(await configured(user.id, instanceId)))
        throw assignmentUnavailable("AI Client instance is unavailable.");
      const binding = (
        await requireRepository().listAiClientUsageAccountBindings({
          userId: user.id
        })
      ).find((row) => row.instanceId === instanceId);
      if (
        !binding?.accountIdentityHash ||
        binding.profileScopeHash !== input.profile_scope_hash ||
        Date.parse(input.observed_at) < Date.parse(binding.observedAt)
      ) {
        return { completion: null };
      }
      const completion = {
        instanceId,
        completionId: randomUUID(),
        outcome: input.outcome,
        observedAt: input.observed_at
      } as const;
      publish(user.id, input.profile_scope_hash, completion);
      return { completion };
    }
  );
  app.get(
    "/v1/memory/ai-client-instances/usage/events",
    {
      preHandler: rateLimit.aiClientControl
    },
    async (request, reply) => {
      const user = await authenticate(request);
      const scope = profileScope(request);
      if ((listeners.get(user.id)?.size ?? 0) >= 4) {
        throw assignmentUnavailable("AI Client usage stream limit reached.");
      }
      const generation = await bindingFingerprint(user.id, scope);
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        const ownerListeners = listeners.get(user.id);
        ownerListeners?.delete(subscriber);
        if (ownerListeners?.size === 0) listeners.delete(user.id);
        if (!reply.raw.destroyed) reply.raw.end();
      };
      const valid = async (instanceId?: string) => {
        try {
          const current = await authenticate(request, { fresh: true });
          if (current.id !== user.id) return false;
          if (generation !== (await bindingFingerprint(user.id, scope)))
            return false;
          return !instanceId || (await configured(user.id, instanceId));
        } catch {
          return false;
        }
      };
      let checkingDelivery = false;
      const subscriber = {
        profileScopeHash: scope,
        close,
        send: (event: AiClientUsageCompletion) => {
          if (closed) return;
          if (checkingDelivery) return close();
          checkingDelivery = true;
          void valid(event.instanceId)
            .then((authorized) => {
              if (!authorized) return close();
              if (
                !closed &&
                !reply.raw.write(
                  `event: usage\ndata: ${JSON.stringify(event)}\n\n`
                )
              )
                close();
            })
            .catch(close)
            .finally(() => {
              checkingDelivery = false;
            });
        }
      };
      const heartbeat = setInterval(() => {
        void valid()
          .then((authorized) => {
            if (!authorized) return close();
            if (!closed && !reply.raw.write(": heartbeat\n\n")) close();
          })
          .catch(close);
      }, 15_000);
      if ((listeners.get(user.id)?.size ?? 0) >= 4) {
        clearInterval(heartbeat);
        throw assignmentUnavailable("AI Client usage stream limit reached.");
      }
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-store",
        connection: "keep-alive"
      });
      reply.raw.write(": connected\n\n");
      const set = listeners.get(user.id) ?? new Set();
      set.add(subscriber);
      listeners.set(user.id, set);
      request.raw.on("close", close);
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
  registerUsageRoutes(app, context);
  registerSettingsListRoute(app, context);
  registerSettingsWriteRoute(app, context);
  registerSettingsDeleteRoute(app, context);
};
