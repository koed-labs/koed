import type { FastifyInstance } from "fastify";
import {
  aiClientCapabilityIds,
  aiClientPermissionContractFor,
  isSupportedAiClientDriverId,
  personalAgentIdentitySchema,
  type PersonalAgentIdentity
} from "@koed/shared";
import type { MemorySourceRepository, PersonalAgentRepository } from "@koed/db";
import type { ApiRouteContext } from "../server/context.js";
import {
  personalAgentCreateSchema,
  personalAgentIdParamsSchema,
  personalAgentListQuerySchema,
  personalAgentRetireSchema,
  personalAgentUpdateSchema
} from "./schemas.js";

const localExecutionProfiles = new Set(["developer", "local_personal"]);

export type PersonalAgentDetail = NonNullable<
  Awaited<ReturnType<PersonalAgentRepository["getPersonalAgent"]>>
>;

type CapabilityRepository = Pick<
  MemorySourceRepository,
  "listAiClientInstances" | "listCurrentAiClientCapabilitySnapshots"
>;

const conflict = (message: string, code = "conflict") =>
  Object.assign(new Error(message), { statusCode: 409, code });

const notFound = (message: string) =>
  Object.assign(new Error(message), { statusCode: 404 });

const capabilityUnavailable = (message: string) =>
  Object.assign(new Error(message), {
    statusCode: 409,
    code: "ai_client_capability_unavailable"
  });

const isStaleVersionError = (error: unknown): boolean =>
  Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "STALE_VERSION"
  );

const publicAgent = (agent: PersonalAgentIdentity) => {
  const parsed = personalAgentIdentitySchema.parse(agent);
  return {
    id: parsed.id,
    name: parsed.name,
    role: parsed.role,
    avatarReference: parsed.avatarReference,
    lifecycle: parsed.lifecycle,
    defaultProvider: parsed.defaultProvider,
    defaultModel: parsed.defaultModel,
    defaultReasoningEffort: parsed.defaultReasoningEffort,
    currentVersion: parsed.currentVersion,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    retiredAt: parsed.retiredAt
  };
};

const routeRepository = (
  repository: MemorySourceRepository
): PersonalAgentRepository => repository;

const modelId = (model: Record<string, unknown>): string | null =>
  typeof model.id === "string" && model.id.trim() ? model.id.trim() : null;

const modelReasoningEfforts = (model: Record<string, unknown>): string[] =>
  Array.isArray(model.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts.filter(
        (value): value is string => typeof value === "string" && !!value.trim()
      )
    : [];

const capabilityDescriptor = (
  capabilities: Record<string, unknown>,
  capability: string
): Record<string, unknown> | undefined => {
  const descriptors = capabilities.descriptors;
  const source =
    descriptors && typeof descriptors === "object" ? descriptors : capabilities;
  const descriptor = (source as Record<string, unknown>)[capability];
  return descriptor && typeof descriptor === "object"
    ? (descriptor as Record<string, unknown>)
    : undefined;
};

const readyCapabilityInstances = async (
  repository: CapabilityRepository,
  userId: string
) => {
  const [instances, snapshots] = await Promise.all([
    repository.listAiClientInstances({ userId }),
    repository.listCurrentAiClientCapabilitySnapshots({ userId })
  ]);
  return instances.flatMap((instance) => {
    if (!isSupportedAiClientDriverId(instance.driverId)) return [];
    const snapshot = snapshots.find(
      (candidate) => candidate.instanceId === instance.instanceId
    );
    const descriptor = snapshot
      ? capabilityDescriptor(
          snapshot.capabilities,
          aiClientCapabilityIds.managedConversationStart
        )
      : undefined;
    const ready = Boolean(
      instance.enabled &&
      typeof instance.configIdentityHash === "string" &&
      snapshot?.installationIdentityHash === instance.configIdentityHash &&
      snapshot.authenticationState === "authenticated" &&
      snapshot.healthState === "healthy" &&
      Date.parse(snapshot.expiresAt) > Date.now() &&
      descriptor?.support === "supported" &&
      descriptor.readiness === "ready"
    );
    if (!ready || !snapshot) return [];
    return [
      {
        provider: instance.driverId,
        instanceId: instance.instanceId,
        displayName: instance.displayName,
        models: snapshot.models.flatMap((candidate) => {
          const id = modelId(candidate);
          if (!id) return [];
          return [
            {
              id,
              // `provider` is the AI Client driver used to run the model.
              // The model's own provider, when reported, stays in fullId or
              // the capability payload and must not be confused with it.
              provider: instance.driverId,
              instanceId: instance.instanceId,
              ...(typeof candidate.displayName === "string"
                ? { displayName: candidate.displayName }
                : {}),
              ...(typeof candidate.fullId === "string"
                ? { fullId: candidate.fullId }
                : {}),
              supportedReasoningEfforts: modelReasoningEfforts(candidate)
            }
          ];
        }),
        permissionModes: aiClientPermissionContractFor(instance.driverId)
          .permissionModes.filter((mode) => mode.support === "supported")
          .map((mode) => mode.mode)
      }
    ];
  });
};

const assertDefaultCapability = async (
  repository: CapabilityRepository,
  userId: string,
  input: {
    provider: string;
    model: string;
    reasoningEffort: string | null;
  }
): Promise<void> => {
  const instances = await readyCapabilityInstances(repository, userId);
  const matches = instances.flatMap((instance) =>
    instance.models.filter(
      (model) => model.id === input.model && model.provider === input.provider
    )
  );
  if (matches.length === 0) {
    throw capabilityUnavailable("Selected AI Client model is unavailable");
  }
  if (
    input.reasoningEffort !== null &&
    !matches.some((model) =>
      model.supportedReasoningEfforts.includes(input.reasoningEffort as string)
    )
  ) {
    throw capabilityUnavailable(
      "Selected reasoning effort is unavailable for this model"
    );
  }
};

const handleWriteConflict = (error: unknown): never => {
  if (isStaleVersionError(error))
    throw conflict("Stale version", "stale_version");
  if (
    error &&
    typeof error === "object" &&
    (("statusCode" in error && error.statusCode === 409) ||
      ("code" in error && error.code === "IDEMPOTENCY_CONFLICT"))
  ) {
    throw conflict(
      "Personal Agent request conflicts with existing state",
      "request_conflict"
    );
  }
  throw error;
};

export const registerPersonalAgentRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
): void => {
  const {
    requireRepository,
    auth: { authenticate, authenticateSession },
    rateLimit: { personalAgentControl: agentRateLimit }
  } = context;
  const authenticatePersonalAgent = (
    request: Parameters<typeof authenticate>[0]
  ) =>
    localExecutionProfiles.has(context.config.deploymentProfile)
      ? authenticate(request)
      : authenticateSession(request);

  app.get(
    "/v1/personal-agent-role-templates",
    { preHandler: agentRateLimit },
    async (request) => {
      await authenticatePersonalAgent(request);
      personalAgentListQuerySchema.parse(request.query);
      return {
        templates:
          await routeRepository(
            requireRepository()
          ).listPersonalAgentRoleTemplates()
      };
    }
  );

  const assertPublishedTemplate = async (
    templateId: string | null,
    version: number | null
  ) => {
    if (templateId === null && version === null) return;
    const template = await routeRepository(
      requireRepository()
    ).getPersonalAgentRoleTemplate(templateId!, version!);
    if (!template) throw notFound("Personal Agent role template not found");
  };

  app.get(
    "/v1/personal-agents/capabilities",
    { preHandler: agentRateLimit },
    async (request) => {
      const user = await authenticatePersonalAgent(request);
      personalAgentListQuerySchema.parse(request.query);
      const instances = await readyCapabilityInstances(
        requireRepository(),
        user.id
      );
      return {
        models: instances.flatMap((instance) => instance.models),
        instances
      };
    }
  );

  app.get(
    "/v1/personal-agents",
    { preHandler: agentRateLimit },
    async (request) => {
      const user = await authenticatePersonalAgent(request);
      personalAgentListQuerySchema.parse(request.query);
      const agents = await routeRepository(
        requireRepository()
      ).listPersonalAgents({ userId: user.id }, { includeRetired: true });
      return { agents: agents.map(publicAgent) };
    }
  );

  app.get(
    "/v1/personal-agents/:agentId",
    { preHandler: agentRateLimit },
    async (request) => {
      const user = await authenticatePersonalAgent(request);
      const { agentId } = personalAgentIdParamsSchema.parse(request.params);
      const detail = await routeRepository(
        requireRepository()
      ).getPersonalAgent({ userId: user.id }, agentId);
      if (!detail) throw notFound("Personal Agent not found");
      const identityVersion = await routeRepository(
        requireRepository()
      ).getPersonalAgentVersion(
        { userId: user.id },
        {
          agentId,
          version: detail.agent.currentVersion
        }
      );
      if (!identityVersion) throw notFound("Personal Agent version not found");
      return {
        agent: publicAgent(detail.agent),
        soulInstructions: detail.soulInstructions,
        sourceTemplateId: identityVersion.sourceTemplateId,
        sourceTemplateVersion: identityVersion.sourceTemplateVersion,
        stats: detail.history.stats,
        jobs: detail.history.jobs,
        jobsHasMore: detail.history.jobsHasMore,
        jobsNextCursor: detail.history.jobsNextCursor,
        projects: detail.history.projects ?? []
      };
    }
  );

  app.post(
    "/v1/personal-agents",
    { preHandler: agentRateLimit },
    async (request) => {
      const user = await authenticatePersonalAgent(request);
      const input = personalAgentCreateSchema.parse(request.body);
      await assertPublishedTemplate(
        input.sourceTemplateId,
        input.sourceTemplateVersion
      );
      await assertDefaultCapability(requireRepository(), user.id, {
        provider: input.defaultProvider,
        model: input.defaultModel,
        reasoningEffort: input.defaultReasoningEffort ?? null
      });
      const detail = await routeRepository(requireRepository())
        .createPersonalAgent(
          { userId: user.id },
          { ...input, instructionSource: "custom" }
        )
        .catch(handleWriteConflict);
      return {
        agent: publicAgent(detail.agent),
        soulInstructions: detail.soulInstructions,
        sourceTemplateId: input.sourceTemplateId,
        sourceTemplateVersion: input.sourceTemplateVersion
      };
    }
  );

  app.patch(
    "/v1/personal-agents/:agentId",
    { preHandler: agentRateLimit },
    async (request) => {
      const user = await authenticatePersonalAgent(request);
      const { agentId } = personalAgentIdParamsSchema.parse(request.params);
      const input = personalAgentUpdateSchema.parse(request.body);
      if (input.sourceTemplateId !== undefined) {
        await assertPublishedTemplate(
          input.sourceTemplateId,
          input.sourceTemplateVersion!
        );
      }
      const hasDefaultInput =
        input.defaultProvider !== undefined ||
        input.defaultModel !== undefined ||
        input.defaultReasoningEffort !== undefined;
      if (hasDefaultInput) {
        const current = await routeRepository(
          requireRepository()
        ).getPersonalAgent({ userId: user.id }, agentId);
        if (!current) throw notFound("Personal Agent not found");
        const defaultsChanged =
          (input.defaultProvider !== undefined &&
            input.defaultProvider !== current.agent.defaultProvider) ||
          (input.defaultModel !== undefined &&
            input.defaultModel !== current.agent.defaultModel) ||
          (input.defaultReasoningEffort !== undefined &&
            input.defaultReasoningEffort !==
              current.agent.defaultReasoningEffort);
        if (defaultsChanged) {
          await assertDefaultCapability(requireRepository(), user.id, {
            provider: input.defaultProvider ?? current.agent.defaultProvider,
            model: input.defaultModel ?? current.agent.defaultModel,
            reasoningEffort:
              input.defaultReasoningEffort !== undefined
                ? input.defaultReasoningEffort
                : current.agent.defaultReasoningEffort
          });
        }
      }
      const detail = await routeRepository(requireRepository())
        .updatePersonalAgent({ userId: user.id }, { agentId, ...input })
        .catch(handleWriteConflict);
      if (!detail) throw notFound("Personal Agent not found");
      const identityVersion = await routeRepository(
        requireRepository()
      ).getPersonalAgentVersion(
        { userId: user.id },
        {
          agentId,
          version: detail.agent.currentVersion
        }
      );
      if (!identityVersion) throw notFound("Personal Agent version not found");
      return {
        agent: publicAgent(detail.agent),
        soulInstructions: detail.soulInstructions,
        sourceTemplateId: identityVersion.sourceTemplateId,
        sourceTemplateVersion: identityVersion.sourceTemplateVersion
      };
    }
  );

  app.post(
    "/v1/personal-agents/:agentId/retire",
    { preHandler: agentRateLimit },
    async (request) => {
      const user = await authenticatePersonalAgent(request);
      const { agentId } = personalAgentIdParamsSchema.parse(request.params);
      const input = personalAgentRetireSchema.parse(request.body);
      const agent = await routeRepository(requireRepository())
        .retirePersonalAgent({ actor: { userId: user.id }, agentId, ...input })
        .catch(handleWriteConflict);
      if (!agent) throw notFound("Personal Agent not found");
      return { agent: publicAgent(agent) };
    }
  );
};
