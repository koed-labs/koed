import type { FastifyInstance } from "fastify";
import {
  aiClientCapabilityIds,
  aiClientPermissionContractFor,
  isSupportedAiClientDriverId,
  personalAgentIdentitySchema,
  personalAgentActivityResponseSchema,
  personalAgentHistoryJobsResponseSchema,
  PERSONAL_AGENT_CONTRACT_VERSION,
  fetchBoundedJsonObject,
  readLocalEdgeUpstreamRegistry,
  upstreamAdvertisesCapability,
  upstreamApiUrl,
  upstreamBackendById,
  type PersonalAgentIdentity
} from "@koed/shared";
import type { MemorySourceRepository, PersonalAgentRepository } from "@koed/db";
import type { ApiRouteContext } from "../server/context.js";
import { assertUpstreamOperationPathAllowed } from "../local-edge/upstream-routing.js";
import {
  personalAgentCreateSchema,
  personalAgentActivityQuerySchema,
  personalAgentHistoryQuerySchema,
  personalAgentIdParamsSchema,
  personalAgentListQuerySchema,
  personalAgentRetireSchema,
  personalAgentRestoreSchema,
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

const badRequest = (message: string) =>
  Object.assign(new Error(message), { statusCode: 400 });

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

const handleWriteConflict = (error: unknown): never => {
  if (isStaleVersionError(error))
    throw conflict("Stale version", "stale_version");
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "PERSONAL_AGENT_NOT_RETIRED"
  ) {
    throw conflict("Personal Agent is already active", "lifecycle_conflict");
  }
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
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "PERSONAL_AGENT_NAME_CONFLICT"
  ) {
    throw conflict(
      "A Personal Agent with this name or a previous name already exists for this account",
      "name_conflict"
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
  ) => {
    if (localExecutionProfiles.has(context.config.deploymentProfile)) {
      return authenticate(request);
    }
    return /^Koed-Device\s/i.test(request.headers.authorization?.trim() ?? "")
      ? context.auth.authenticateSessionOrDeviceCredential(
          request,
          "managed_execution"
        )
      : authenticateSession(request);
  };

  // Electron's local Studio keeps using its local API token, but its saved
  // Agent library must live under the same hosted owner as managed Jobs when
  // that managed-execution authority is enabled. The upstream device
  // credential supplies the hosted owner identity; local owner IDs are never
  // forwarded as authority.
  const remoteAuthority = () => {
    if (!localExecutionProfiles.has(context.config.deploymentProfile)) {
      return null;
    }
    const registry = readLocalEdgeUpstreamRegistry(
      context.localEdge.upstreamBackendsPath
    );
    const backend = registry.activeBackendId
      ? upstreamBackendById(registry, registry.activeBackendId)
      : null;
    if (!backend || backend.routePolicy.managedExecution !== "enabled") {
      return null;
    }
    if (!context.localEdge.remoteOperationsAllowed()) {
      throw Object.assign(
        new Error("Personal Agent remote operations are suspended"),
        { statusCode: 503 }
      );
    }
    const capabilities = backend.capabilities;
    const capabilitiesValid =
      capabilities?.state === "validated" &&
      (!capabilities.expiresAt ||
        Date.parse(capabilities.expiresAt) > Date.now()) &&
      upstreamAdvertisesCapability(backend, "memory.managedConversations");
    if (!capabilitiesValid) {
      throw Object.assign(
        new Error("Personal Agent upstream capabilities are unavailable"),
        { statusCode: 503 }
      );
    }
    const authorization =
      context.localEdge.resolveUpstreamAuthorization(backend);
    if (!authorization) {
      throw Object.assign(
        new Error("Personal Agent upstream is not enrolled"),
        { statusCode: 503 }
      );
    }
    return { backend, authorization };
  };

  const proxyPersonalAgent = async (
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown
  ): Promise<{ status: number; payload: Record<string, unknown> } | null> => {
    const authority = remoteAuthority();
    if (!authority) return null;
    assertUpstreamOperationPathAllowed("managed_execution", method, path);
    const maxBytes = path.startsWith("/v1/personal-agents/activity?")
      ? 1024 * 1024
      : /^\/v1\/personal-agents\/[0-9a-f-]+\/jobs\?/.test(path)
        ? 8 * 1024 * 1024
        : 256 * 1024;
    const requestPath = new URL(path, "http://localhost");
    const upstreamUrl = upstreamApiUrl(
      authority.backend.baseUrl,
      requestPath.pathname
    );
    upstreamUrl.search = requestPath.search;
    const { response, payload } = await fetchBoundedJsonObject(
      context.localEdge.fetch,
      upstreamUrl,
      {
        method,
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: authority.authorization,
          ...(body === undefined ? {} : { "content-type": "application/json" })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      },
      {
        timeoutMs: 15_000,
        maxBytes,
        readErrorBody: true
      }
    );
    if (!response.ok) {
      const message =
        typeof payload.error === "string"
          ? payload.error
          : `Personal Agent authority returned HTTP ${response.status}`;
      throw Object.assign(new Error(message), {
        statusCode: response.status >= 500 ? 502 : response.status
      });
    }
    return { status: response.status, payload };
  };

  app.get(
    "/v1/personal-agent-role-templates",
    { preHandler: agentRateLimit },
    async (request) => {
      await authenticatePersonalAgent(request);
      personalAgentListQuerySchema.parse(request.query);
      const proxied = await proxyPersonalAgent(
        "GET",
        "/v1/personal-agent-role-templates"
      );
      if (proxied) return proxied.payload;
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
      const proxied = await proxyPersonalAgent(
        "GET",
        "/v1/personal-agents/capabilities"
      );
      if (proxied) return proxied.payload;
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
      const proxied = await proxyPersonalAgent("GET", "/v1/personal-agents");
      if (proxied) return proxied.payload;
      const agents = await routeRepository(
        requireRepository()
      ).listPersonalAgents({ userId: user.id }, { includeRetired: true });
      return { agents: agents.map(publicAgent) };
    }
  );

  app.get(
    "/v1/personal-agents/activity",
    { preHandler: agentRateLimit },
    async (request) => {
      const user = await authenticatePersonalAgent(request);
      const { agentIds } = personalAgentActivityQuerySchema.parse(
        request.query
      );
      const unknownActivity = (availability: "unavailable" | "unsupported") =>
        agentIds.map((agentId) => ({
          agentId,
          status: "unknown" as const,
          availability,
          freshness: "unknown" as const,
          observedAt: null,
          runningAttempts: null,
          persistedRunningAttempts: null,
          activeJobs: [],
          activeJobsCount: null,
          activeJobsTruncated: false,
          projectSummary: null
        }));
      try {
        const search = new URLSearchParams();
        for (const agentId of agentIds) search.append("agentId", agentId);
        const proxied = await proxyPersonalAgent(
          "GET",
          `/v1/personal-agents/activity?${search.toString()}`
        );
        if (proxied) {
          const parsed = personalAgentActivityResponseSchema.safeParse(
            proxied.payload
          );
          const returnedIds = parsed.success
            ? parsed.data.activity.map((item) => item.agentId)
            : [];
          const requestedIds = new Set(agentIds);
          if (
            parsed.success &&
            returnedIds.length === agentIds.length &&
            new Set(returnedIds).size === returnedIds.length &&
            returnedIds.every((agentId) => requestedIds.has(agentId))
          ) {
            return parsed.data;
          }
          return {
            contractVersion: PERSONAL_AGENT_CONTRACT_VERSION,
            activity: unknownActivity("unsupported")
          };
        }
        const activity = await routeRepository(
          requireRepository()
        ).getPersonalAgentActivity({ userId: user.id }, { agentIds });
        return personalAgentActivityResponseSchema.parse({
          contractVersion: PERSONAL_AGENT_CONTRACT_VERSION,
          activity
        });
      } catch (error) {
        const unsupported =
          error &&
          typeof error === "object" &&
          "statusCode" in error &&
          error.statusCode === 404;
        return {
          contractVersion: PERSONAL_AGENT_CONTRACT_VERSION,
          activity: unknownActivity(unsupported ? "unsupported" : "unavailable")
        };
      }
    }
  );

  app.get(
    "/v1/personal-agents/:agentId/jobs",
    { preHandler: agentRateLimit },
    async (request) => {
      const user = await authenticatePersonalAgent(request);
      const { agentId } = personalAgentIdParamsSchema.parse(request.params);
      const query = personalAgentHistoryQuerySchema.parse(request.query);
      const search = new URLSearchParams({ limit: String(query.limit) });
      if (query.before) search.set("before", query.before);
      const proxied = await proxyPersonalAgent(
        "GET",
        `/v1/personal-agents/${encodeURIComponent(agentId)}/jobs?${search.toString()}`
      );
      if (proxied) {
        return personalAgentHistoryJobsResponseSchema.parse(proxied.payload);
      }
      let page;
      try {
        page = await routeRepository(
          requireRepository()
        ).listPersonalAgentHistoryJobs(
          { userId: user.id },
          { agentId, ...query }
        );
      } catch (error) {
        if (
          error instanceof TypeError &&
          error.message === "Invalid Personal Agent history cursor"
        ) {
          throw badRequest("Invalid Personal Agent history cursor");
        }
        throw error;
      }
      return personalAgentHistoryJobsResponseSchema.parse({
        contractVersion: PERSONAL_AGENT_CONTRACT_VERSION,
        ...page
      });
    }
  );

  app.get(
    "/v1/personal-agents/:agentId",
    { preHandler: agentRateLimit },
    async (request) => {
      const user = await authenticatePersonalAgent(request);
      const { agentId } = personalAgentIdParamsSchema.parse(request.params);
      const proxied = await proxyPersonalAgent(
        "GET",
        `/v1/personal-agents/${encodeURIComponent(agentId)}`
      );
      if (proxied) return proxied.payload;
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
        runningNow: detail.history.runningNow ?? [],
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
      const proxied = await proxyPersonalAgent(
        "POST",
        "/v1/personal-agents",
        input
      );
      if (proxied) return proxied.payload;
      await assertPublishedTemplate(
        input.sourceTemplateId,
        input.sourceTemplateVersion
      );
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
      const proxied = await proxyPersonalAgent(
        "PATCH",
        `/v1/personal-agents/${encodeURIComponent(agentId)}`,
        input
      );
      if (proxied) return proxied.payload;
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
        const resultingProvider =
          input.defaultProvider !== undefined
            ? input.defaultProvider
            : current.agent.defaultProvider;
        const resultingModel =
          input.defaultModel !== undefined
            ? input.defaultModel
            : current.agent.defaultModel;
        const resultingEffort =
          input.defaultReasoningEffort !== undefined
            ? input.defaultReasoningEffort
            : current.agent.defaultReasoningEffort;
        if ((resultingProvider === null) !== (resultingModel === null)) {
          throw badRequest(
            "Default provider and model must both be set or both be cleared"
          );
        }
        if (resultingProvider === null && resultingEffort !== null) {
          throw badRequest(
            "Default reasoning effort must be cleared when provider and model are cleared"
          );
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
    "/v1/personal-agents/:agentId/restore",
    { preHandler: agentRateLimit },
    async (request) => {
      const user = await authenticatePersonalAgent(request);
      const { agentId } = personalAgentIdParamsSchema.parse(request.params);
      const input = personalAgentRestoreSchema.parse(request.body);
      const proxied = await proxyPersonalAgent(
        "POST",
        `/v1/personal-agents/${encodeURIComponent(agentId)}/restore`,
        input
      );
      if (proxied) return proxied.payload;
      const agent = await routeRepository(requireRepository())
        .restorePersonalAgent({ actor: { userId: user.id }, agentId, ...input })
        .catch(handleWriteConflict);
      if (!agent) throw notFound("Personal Agent not found");
      return { agent: publicAgent(agent) };
    }
  );

  app.post(
    "/v1/personal-agents/:agentId/retire",
    { preHandler: agentRateLimit },
    async (request) => {
      const user = await authenticatePersonalAgent(request);
      const { agentId } = personalAgentIdParamsSchema.parse(request.params);
      const input = personalAgentRetireSchema.parse(request.body);
      const proxied = await proxyPersonalAgent(
        "POST",
        `/v1/personal-agents/${encodeURIComponent(agentId)}/retire`,
        input
      );
      if (proxied) return proxied.payload;
      const agent = await routeRepository(requireRepository())
        .retirePersonalAgent({ actor: { userId: user.id }, agentId, ...input })
        .catch(handleWriteConflict);
      if (!agent) throw notFound("Personal Agent not found");
      return { agent: publicAgent(agent) };
    }
  );
};
