import type { FastifyInstance, FastifyRequest } from "fastify";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  DeviceCredentialAuthContext,
  MemorySourceRepository
} from "@koed/db";
import { defaultFreshAuthenticationMaxAgeMs } from "@koed/db";
import { z } from "zod";
import {
  fetchBoundedJsonObject,
  readLocalEdgeUpstreamRegistry,
  upstreamAdvertisesCapability,
  upstreamApiUrl,
  upstreamBackendById
} from "@koed/shared";

import type { ApiRouteContext } from "../server/context.js";
import {
  managedConversationTransferRequestHash,
  managedConversationTransferScopeHash
} from "../high-risk/action-grant-protocol.js";
import { assertUpstreamOperationPathAllowed } from "../local-edge/upstream-routing.js";

const localExecutionProfiles = new Set(["developer", "local_personal"]);
const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const startSchema = z
  .object({
    projectId: z.string().trim().min(1).max(2_048),
    provider: z.enum(["codex", "claude"]).default("codex"),
    idempotencyKey: idempotencyKeySchema
  })
  .strict();

const authorityStartSchema = startSchema
  .extend({
    deferUntilRuntimeBinding: z.literal(true).optional()
  })
  .strict();

const proxiedStartResponseSchema = z
  .object({
    execution: z
      .object({
        id: z.uuid(),
        projectId: z.string().trim().min(1).max(2_048),
        executionGeneration: z.number().int().safe().positive()
      })
      .passthrough(),
    command: z
      .object({
        id: z.uuid(),
        state: z.enum(["blocked", "queued", "dispatching", "completed"])
      })
      .passthrough()
  })
  .passthrough();

const executionParamsSchema = z.object({ executionId: z.uuid() }).strict();

const promptSchema = z
  .object({
    executionGeneration: z.number().int().safe().positive(),
    idempotencyKey: idempotencyKeySchema,
    prompt: z.string().trim().min(1).max(256_000)
  })
  .strict();

const handoffSchema = z
  .object({
    actionGrantId: z.uuid().optional(),
    operationId: z.uuid(),
    targetDeviceId: z.uuid()
  })
  .strict();

const forkSchema = z
  .object({
    actionGrantId: z.uuid().optional(),
    operationId: z.uuid(),
    reason: z.enum([
      "user_requested",
      "incompatible_provider",
      "origin_unavailable",
      "independent_work"
    ]),
    targetDeviceId: z.uuid()
  })
  .strict();

const remoteDeviceStatusSchema = z
  .object({
    ok: z.literal(true),
    user: z
      .object({
        id: z.uuid()
      })
      .passthrough(),
    credential: z
      .object({
        id: z.uuid(),
        operationFamilies: z.array(z.string())
      })
      .passthrough()
  })
  .passthrough();

const listSchema = z
  .object({
    projectId: z.string().trim().min(1).max(2_048).optional(),
    limit: z.coerce.number().int().safe().min(1).max(500).default(100)
  })
  .strict();

const localProjectStoreSchema = z
  .object({
    schemaVersion: z.literal(3),
    projects: z.array(
      z
        .object({
          localProjectId: z.string().trim().min(1).max(2_048),
          path: z
            .object({
              cwd: z.string().trim().min(1),
              projectRoot: z.string().trim().min(1).nullable()
            })
            .passthrough()
        })
        .passthrough()
    )
  })
  .passthrough();

const localProjectExecutionPath = async (
  koedHome: string | undefined,
  projectId: string
): Promise<string | null> => {
  if (!koedHome?.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await readFile(resolve(koedHome, "config", "projects.json"), "utf8")
    );
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw Object.assign(new Error("Local Project metadata is unavailable"), {
      statusCode: 503,
      cause: error
    });
  }
  const store = localProjectStoreSchema.safeParse(parsed);
  if (!store.success) {
    throw Object.assign(new Error("Local Project metadata is malformed"), {
      statusCode: 503
    });
  }
  const project = store.data.projects.find(
    (candidate) => candidate.localProjectId === projectId
  );
  if (!project) return null;
  try {
    return await realpath(project.path.projectRoot ?? project.path.cwd);
  } catch (error) {
    throw Object.assign(
      new Error("Project has no verified local execution path"),
      { statusCode: 409, cause: error }
    );
  }
};

const protocolDeploymentId = (
  metadata: Record<string, unknown>
): string | null => {
  const value = metadata.protocolDeploymentId;
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    )
    ? value
    : null;
};

const publicExecution = (
  execution: {
    id: string;
    projectId: string;
    provider: string;
    state: string;
    stateVersion: number;
    executionGeneration: number;
    logicalSessionId: string | null;
    providerThreadId: string | null;
    providerCliVersion: string | null;
    lastErrorCode: string | null;
    createdAt: string;
    updatedAt: string;
    startedAt: string | null;
    quiescedAt: string | null;
    stoppedAt: string | null;
  },
  localSessionId: string | null = null
) => ({
  id: execution.id,
  projectId: execution.projectId,
  provider: execution.provider,
  state: execution.state,
  stateVersion: execution.stateVersion,
  executionGeneration: execution.executionGeneration,
  sessionId: localSessionId,
  logicalSessionId: execution.logicalSessionId,
  providerThreadId: execution.providerThreadId,
  providerCliVersion: execution.providerCliVersion,
  lastErrorCode: execution.lastErrorCode,
  createdAt: execution.createdAt,
  updatedAt: execution.updatedAt,
  startedAt: execution.startedAt,
  quiescedAt: execution.quiescedAt,
  stoppedAt: execution.stoppedAt
});

const publicHandoff = (handoff: {
  id: string;
  executionId: string;
  operationId: string;
  state: string;
  stateVersion: number;
  sourceExecutionGeneration: number;
  nextExecutionGeneration: number;
  sourceDeploymentId: string;
  sourceDeviceId: string;
  targetDeploymentId: string;
  targetDeviceId: string;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
  transferredAt: string | null;
  completedAt: string | null;
}) => ({
  id: handoff.id,
  executionId: handoff.executionId,
  operationId: handoff.operationId,
  state: handoff.state,
  stateVersion: handoff.stateVersion,
  sourceExecutionGeneration: handoff.sourceExecutionGeneration,
  nextExecutionGeneration: handoff.nextExecutionGeneration,
  sourceDeploymentId: handoff.sourceDeploymentId,
  sourceDeviceId: handoff.sourceDeviceId,
  targetDeploymentId: handoff.targetDeploymentId,
  targetDeviceId: handoff.targetDeviceId,
  failureCode: handoff.failureCode,
  createdAt: handoff.createdAt,
  updatedAt: handoff.updatedAt,
  transferredAt: handoff.transferredAt,
  completedAt: handoff.completedAt
});

const publicFork = (fork: {
  id: string;
  operationId: string;
  state: string;
  stateVersion: number;
  parentExecutionId: string;
  parentExecutionGeneration: number;
  sourceDeploymentId: string;
  sourceDeviceId: string;
  targetDeploymentId: string;
  targetDeviceId: string;
  childExecutionId: string | null;
  childLogicalSessionId: string | null;
  reason: string;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}) => ({
  id: fork.id,
  operationId: fork.operationId,
  state: fork.state,
  stateVersion: fork.stateVersion,
  parentExecutionId: fork.parentExecutionId,
  parentExecutionGeneration: fork.parentExecutionGeneration,
  sourceDeploymentId: fork.sourceDeploymentId,
  sourceDeviceId: fork.sourceDeviceId,
  targetDeploymentId: fork.targetDeploymentId,
  targetDeviceId: fork.targetDeviceId,
  childExecutionId: fork.childExecutionId,
  childLogicalSessionId: fork.childLogicalSessionId,
  reason: fork.reason,
  failureCode: fork.failureCode,
  createdAt: fork.createdAt,
  updatedAt: fork.updatedAt,
  completedAt: fork.completedAt
});

const assertAvailable = (context: ApiRouteContext): void => {
  if (!context.encryption.envelopeEncryptionProvider) {
    throw Object.assign(new Error("Managed Conversations are unavailable"), {
      statusCode: 404
    });
  }
};

export const registerManagedConversationRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
): void => {
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
    if (
      !backend ||
      backend.routePolicy.managedExecution !== "enabled" ||
      !upstreamAdvertisesCapability(backend, "memory.managedConversations")
    ) {
      return null;
    }
    const authorization =
      context.localEdge.resolveUpstreamAuthorization(backend);
    if (!authorization) {
      throw Object.assign(
        new Error("Managed Conversation upstream is not enrolled"),
        { statusCode: 503 }
      );
    }
    return { backend, authorization };
  };

  const proxyManaged = async (
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    options: {
      actionGrant?: string;
      expectedBackendId?: string;
      query?: URLSearchParams;
    } = {}
  ): Promise<{ status: number; payload: Record<string, unknown> } | null> => {
    const authority = remoteAuthority();
    if (!authority) return null;
    if (
      options.expectedBackendId &&
      authority.backend.id !== options.expectedBackendId
    ) {
      throw Object.assign(
        new Error(
          "Managed Conversation authority changed during authorization"
        ),
        { statusCode: 409 }
      );
    }
    assertUpstreamOperationPathAllowed("managed_execution", method, path);
    const upstreamUrl = upstreamApiUrl(authority.backend.baseUrl, path);
    if (options.query) {
      upstreamUrl.search = options.query.toString();
    }
    const { response, payload } = await fetchBoundedJsonObject(
      context.localEdge.fetch,
      upstreamUrl,
      {
        method,
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: authority.authorization,
          ...(options.actionGrant
            ? { "x-koed-action-grant": options.actionGrant }
            : {}),
          ...(method === "POST" ? { "content-type": "application/json" } : {})
        },
        ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {})
      },
      {
        timeoutMs: 60_000,
        maxBytes: 4 * 1024 * 1024,
        readErrorBody: true
      }
    );
    if (!response.ok) {
      const message =
        typeof payload.error === "string"
          ? payload.error
          : `Managed Conversation upstream returned HTTP ${response.status}`;
      throw Object.assign(new Error(message), {
        statusCode: response.status >= 500 ? 502 : response.status
      });
    }
    return { status: response.status, payload };
  };

  const remoteTransferAuthority = async () => {
    const authority = remoteAuthority();
    if (!authority) return null;
    const { response, payload } = await fetchBoundedJsonObject(
      context.localEdge.fetch,
      upstreamApiUrl(
        authority.backend.baseUrl,
        "/v1/local-edge/device-credentials/status"
      ),
      {
        method: "GET",
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: authority.authorization
        }
      },
      {
        timeoutMs: 30_000,
        maxBytes: 64 * 1_024,
        readErrorBody: true
      }
    );
    if (!response.ok) {
      throw Object.assign(
        new Error("Managed Conversation upstream identity is unavailable"),
        { statusCode: response.status >= 500 ? 502 : 403 }
      );
    }
    const status = remoteDeviceStatusSchema.parse(payload);
    if (!status.credential.operationFamilies.includes("managed_execution")) {
      throw Object.assign(
        new Error(
          "Enrolled Personal Device cannot authorize managed execution"
        ),
        { statusCode: 403 }
      );
    }
    return { ...authority, status };
  };

  const localizeExecutions = async (
    userId: string,
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>> => {
    const executionValues: unknown[] = Array.isArray(payload.executions)
      ? (payload.executions as unknown[])
      : payload.execution !== undefined
        ? [payload.execution]
        : [];
    const localized = await Promise.all(
      executionValues.map(async (value: unknown): Promise<unknown> => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return value;
        }
        const execution = value as Record<string, unknown>;
        if (typeof execution.id !== "string") return value;
        const binding = await context
          .requireRepository()
          .getManagedConversationRuntimeBinding({ userId }, execution.id);
        return binding
          ? {
              ...execution,
              sessionId: binding.localSessionId,
              providerThreadId:
                binding.providerThreadId ?? execution.providerThreadId
            }
          : execution;
      })
    );
    return Array.isArray(payload.executions)
      ? { ...payload, executions: localized }
      : payload.execution
        ? { ...payload, execution: localized[0] }
        : payload;
  };

  const authenticateManaged = (request: FastifyRequest) =>
    localExecutionProfiles.has(context.config.deploymentProfile)
      ? context.auth.authenticate(request)
      : context.auth.authenticateSessionOrDeviceCredential(
          request,
          "managed_execution",
          {
            apiTokenError:
              "Session cookie or scoped device credential required for managed execution"
          }
        );

  const actionGrantHeader = (request: FastifyRequest): string | null => {
    const value = request.headers["x-koed-action-grant"];
    const token = Array.isArray(value) ? value[0] : value;
    return token?.trim() || null;
  };

  type ManagedTransferActor =
    | {
        kind: "local_edge";
        user: Awaited<ReturnType<typeof context.auth.authenticate>>;
      }
    | {
        kind: "browser";
        user: Awaited<
          ReturnType<typeof context.auth.authenticateSessionContext>
        >["user"];
      }
    | {
        kind: "device";
        user: DeviceCredentialAuthContext["user"];
        auth: DeviceCredentialAuthContext;
        actionGrant: string;
      };

  const authenticateManagedTransfer = async (
    request: FastifyRequest
  ): Promise<ManagedTransferActor> => {
    if (localExecutionProfiles.has(context.config.deploymentProfile)) {
      return {
        kind: "local_edge",
        user: await context.auth.authenticate(request)
      };
    }
    const authorization = request.headers.authorization?.trim() ?? "";
    if (/^Bearer(?:\s|$)/i.test(authorization)) {
      throw Object.assign(
        new Error(
          "Personal API Tokens cannot authorize managed Conversation transfer"
        ),
        { statusCode: 403 }
      );
    }
    if (/^Koed-Device(?:\s|$)/i.test(authorization)) {
      const auth = await context.auth.authenticateDeviceCredential(request);
      if (!auth.credential.operationFamilies.includes("managed_execution")) {
        throw Object.assign(
          new Error(
            "Device credential is not allowed for managed execution transfer"
          ),
          { statusCode: 403 }
        );
      }
      const actionGrant = actionGrantHeader(request);
      if (!actionGrant) {
        throw Object.assign(new Error("One-time action grant required"), {
          statusCode: 403
        });
      }
      return { kind: "device", user: auth.user, auth, actionGrant };
    }
    const session = await context.auth.authenticateSessionContext(request);
    const ageMs = Date.now() - session.createdAt.getTime();
    if (
      !Number.isFinite(ageMs) ||
      ageMs < 0 ||
      ageMs > defaultFreshAuthenticationMaxAgeMs
    ) {
      throw Object.assign(
        new Error("Fresh browser authentication is required"),
        { statusCode: 403 }
      );
    }
    return { kind: "browser", user: session.user };
  };

  const resolveLocalTransferGrant = async (input: {
    actor: Extract<ManagedTransferActor, { kind: "local_edge" }>;
    actionGrantId: string | undefined;
    executionId: string;
    operation:
      | {
          kind: "handoff";
          operationId: string;
          targetDeviceId: string;
        }
      | {
          kind: "fork";
          operationId: string;
          targetDeviceId: string;
          reason:
            | "user_requested"
            | "incompatible_provider"
            | "origin_unavailable"
            | "independent_work";
        };
  }) => {
    if (!input.actionGrantId) {
      throw Object.assign(
        new Error("Approved Action Grant reference required"),
        { statusCode: 403 }
      );
    }
    const authority = await remoteTransferAuthority();
    const control = context.collaboration.actionGrantControl;
    if (!authority || !control) {
      throw Object.assign(
        new Error("Managed Conversation transfer authority is unavailable"),
        { statusCode: 503 }
      );
    }
    const intent =
      input.operation.kind === "handoff"
        ? ({
            intent: "collaboration.managed_conversation_handoff",
            commandRequestId: input.operation.operationId,
            executionId: input.executionId,
            operationId: input.operation.operationId,
            targetDeviceId: input.operation.targetDeviceId
          } as const)
        : ({
            intent: "collaboration.managed_conversation_fork",
            commandRequestId: input.operation.operationId,
            executionId: input.executionId,
            operationId: input.operation.operationId,
            targetDeviceId: input.operation.targetDeviceId,
            reason: input.operation.reason
          } as const);
    const secret = await control.resolveSecret({
      reference: { id: input.actionGrantId },
      intent,
      context: {
        backend: authority.backend,
        localOwnerUserId: input.actor.user.id,
        principalUserId: authority.status.user.id,
        upstreamDeviceCredentialId: authority.status.credential.id,
        upstreamDeviceAuthorization: authority.authorization,
        operationFamilies: new Set(["managed_execution"])
      }
    });
    if (!secret || !/^hrg_[A-Za-z0-9_-]{20,124}$/.test(secret)) {
      throw Object.assign(
        new Error("Action Grant is invalid, expired, or does not match"),
        { statusCode: 403 }
      );
    }
    return {
      actionGrant: secret,
      backendId: authority.backend.id
    };
  };

  const runnerIdentity = async (
    request: FastifyRequest
  ): Promise<{ deploymentId: string; deviceId: string }> => {
    const authorization = request.headers.authorization?.trim() ?? "";
    if (/^Koed-Device\s/i.test(authorization)) {
      const authenticated =
        await context.auth.authenticateDeviceCredential(request);
      if (
        !authenticated.credential.operationFamilies.includes(
          "managed_execution"
        )
      ) {
        throw Object.assign(
          new Error("Device credential is not allowed for managed execution"),
          { statusCode: 403 }
        );
      }
      const deploymentId = protocolDeploymentId(
        authenticated.credential.metadata
      );
      if (!deploymentId) {
        throw Object.assign(
          new Error("Device credential has no verified deployment identity"),
          { statusCode: 409 }
        );
      }
      return {
        deploymentId,
        deviceId: authenticated.credential.deviceInstanceId
      };
    }
    if (!localExecutionProfiles.has(context.config.deploymentProfile)) {
      throw Object.assign(
        new Error(
          "A scoped Personal Device credential is required to select an execution runner"
        ),
        { statusCode: 403 }
      );
    }
    const identity = context.deploymentIdentity.inspect();
    if (
      identity.health !== "healthy" ||
      !identity.deploymentId ||
      !identity.deviceInstanceId
    ) {
      throw Object.assign(
        new Error("Verified local device identity is required"),
        { statusCode: 503 }
      );
    }
    return {
      deploymentId: identity.deploymentId,
      deviceId: identity.deviceInstanceId
    };
  };

  const requestingDeviceId = async (
    request: FastifyRequest
  ): Promise<string | undefined> =>
    /^Koed-Device\s/i.test(request.headers.authorization?.trim() ?? "")
      ? (await runnerIdentity(request)).deviceId
      : (context.deploymentIdentity.inspect().deviceInstanceId ?? undefined);

  const publicExecutionFor = async (
    userId: string,
    execution: Parameters<typeof publicExecution>[0]
  ) => {
    const binding = localExecutionProfiles.has(context.config.deploymentProfile)
      ? await context
          .requireRepository()
          .getManagedConversationRuntimeBinding({ userId }, execution.id)
      : null;
    return publicExecution(execution, binding?.localSessionId ?? null);
  };

  const targetDevices = async (
    repository: Pick<
      MemorySourceRepository,
      "listPersonalDeviceGroups" | "listDeviceCredentials"
    >,
    userId: string,
    currentDeviceId?: string
  ): Promise<
    Array<{
      deviceId: string;
      deploymentId: string;
      label: string | null;
    }>
  > => {
    const [groups, credentials] = await Promise.all([
      repository.listPersonalDeviceGroups(userId),
      repository.listDeviceCredentials({ userId })
    ]);
    const activeMembers = new Set(
      groups.flatMap((group) =>
        group.state === "active" && group.policy.enabled
          ? group.members
              .filter((member) => member.status === "active")
              .map((member) => member.deviceId)
          : []
      )
    );
    const byDevice = new Map<
      string,
      { deploymentId: string; label: string | null } | null
    >();
    const now = Date.now();
    for (const credential of credentials) {
      if (
        credential.deviceInstanceId === currentDeviceId ||
        !activeMembers.has(credential.deviceInstanceId) ||
        !credential.operationFamilies.includes("sync") ||
        !credential.operationFamilies.includes("managed_execution") ||
        (credential.expiresAt !== null &&
          Date.parse(credential.expiresAt) <= now)
      ) {
        continue;
      }
      const deploymentId = protocolDeploymentId(credential.metadata);
      if (!deploymentId) continue;
      const existing = byDevice.get(credential.deviceInstanceId);
      if (existing && existing.deploymentId !== deploymentId) {
        byDevice.set(credential.deviceInstanceId, null);
        continue;
      }
      if (existing === null) continue;
      byDevice.set(credential.deviceInstanceId, {
        deploymentId,
        label: credential.deviceLabel
      });
    }
    return [...byDevice.entries()]
      .filter(
        (
          entry
        ): entry is [string, { deploymentId: string; label: string | null }] =>
          entry[1] !== null
      )
      .map(([deviceId, target]) => ({ deviceId, ...target }))
      .sort((left, right) => left.deviceId.localeCompare(right.deviceId));
  };

  const requestHandoff = async (
    repository: Pick<
      MemorySourceRepository,
      | "getManagedConversationExecution"
      | "listPersonalDeviceGroups"
      | "listDeviceCredentials"
      | "requestManagedConversationHandoff"
    >,
    userId: string,
    executionId: string,
    input: { operationId: string; targetDeviceId: string }
  ) => {
    const execution = await repository.getManagedConversationExecution(
      { userId },
      executionId
    );
    if (!execution) {
      throw Object.assign(new Error("Managed Conversation not found"), {
        statusCode: 404
      });
    }
    const target = (await targetDevices(repository, userId)).find(
      (candidate) => candidate.deviceId === input.targetDeviceId
    );
    if (!target) {
      throw Object.assign(
        new Error("Target Personal Device is not active for synchronization"),
        { statusCode: 403 }
      );
    }
    return repository.requestManagedConversationHandoff(
      { userId },
      {
        executionId,
        operationId: input.operationId,
        sourceDeploymentId: execution.runnerDeploymentId,
        sourceDeviceId: execution.runnerDeviceId,
        targetDeploymentId: target.deploymentId,
        targetDeviceId: input.targetDeviceId
      }
    );
  };

  const requestFork = async (
    repository: Pick<
      MemorySourceRepository,
      | "getManagedConversationExecution"
      | "listPersonalDeviceGroups"
      | "listDeviceCredentials"
      | "requestManagedConversationFork"
    >,
    userId: string,
    executionId: string,
    input: {
      operationId: string;
      targetDeviceId: string;
      reason:
        | "user_requested"
        | "incompatible_provider"
        | "origin_unavailable"
        | "independent_work";
    }
  ) => {
    const execution = await repository.getManagedConversationExecution(
      { userId },
      executionId
    );
    if (!execution) {
      throw Object.assign(new Error("Managed Conversation not found"), {
        statusCode: 404
      });
    }
    if (execution.runnerDeviceId === input.targetDeviceId) {
      throw Object.assign(
        new Error("Fork target must be a different Personal Device"),
        { statusCode: 400 }
      );
    }
    const target = (await targetDevices(repository, userId)).find(
      (candidate) => candidate.deviceId === input.targetDeviceId
    );
    if (!target) {
      throw Object.assign(
        new Error("Target Personal Device is not active for synchronization"),
        { statusCode: 403 }
      );
    }
    return repository.requestManagedConversationFork(
      { userId },
      {
        parentExecutionId: executionId,
        operationId: input.operationId,
        reason: input.reason,
        sourceDeploymentId: execution.runnerDeploymentId,
        sourceDeviceId: execution.runnerDeviceId,
        targetDeploymentId: target.deploymentId,
        targetDeviceId: input.targetDeviceId
      }
    );
  };

  app.get(
    "/v1/managed-conversations/target-devices",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      assertAvailable(context);
      const user = await authenticateManaged(request);
      const proxied = await proxyManaged(
        "GET",
        "/v1/managed-conversations/target-devices"
      );
      if (proxied) return proxied.payload;
      return {
        devices: await targetDevices(
          context.requireRepository(),
          user.id,
          await requestingDeviceId(request)
        )
      };
    }
  );

  app.post(
    "/v1/managed-conversations",
    { preHandler: context.rateLimit.memoryWrite },
    async (request, reply) => {
      assertAvailable(context);
      const user = await authenticateManaged(request);
      const input = (
        localExecutionProfiles.has(context.config.deploymentProfile)
          ? startSchema
          : authorityStartSchema
      ).parse(request.body);
      if (
        "deferUntilRuntimeBinding" in input &&
        input.deferUntilRuntimeBinding === true &&
        !/^Koed-Device\s/i.test(request.headers.authorization?.trim() ?? "")
      ) {
        throw Object.assign(
          new Error(
            "A scoped Personal Device credential is required to defer managed execution"
          ),
          { statusCode: 403 }
        );
      }
      const repository = context.requireRepository();
      const runner = await runnerIdentity(request);
      const localExecution = localExecutionProfiles.has(
        context.config.deploymentProfile
      );
      const deferred =
        "deferUntilRuntimeBinding" in input &&
        input.deferUntilRuntimeBinding === true;
      const projects =
        localExecution || !deferred
          ? await repository.listLcmGraphThreads(
              { userId: user.id },
              { projectId: input.projectId, limit: 1 }
            )
          : [];
      const project = projects.find(
        (candidate) => candidate.id === input.projectId
      );
      const projectPath = localExecution
        ? ((await localProjectExecutionPath(
            context.config.koedHome,
            input.projectId
          )) ?? project?.path?.trim())
        : project?.path?.trim();
      if (!localExecution && !deferred && !project) {
        throw Object.assign(
          new Error("Project is not available to this Personal Memory"),
          { statusCode: 409 }
        );
      }
      if (localExecution && !projectPath) {
        throw Object.assign(
          new Error("Project has no verified local execution path"),
          { statusCode: 409 }
        );
      }
      const proxied = await proxyManaged("POST", "/v1/managed-conversations", {
        ...input,
        deferUntilRuntimeBinding: true
      });
      if (proxied) {
        const parsed = proxiedStartResponseSchema.safeParse(proxied.payload);
        if (!parsed.success) {
          throw Object.assign(
            new Error(
              "Managed Conversation authority returned an invalid start response"
            ),
            { statusCode: 502 }
          );
        }
        if (
          parsed.data.execution.projectId !== input.projectId ||
          !projectPath
        ) {
          throw Object.assign(
            new Error("Managed Conversation authority returned wrong Project"),
            { statusCode: 502 }
          );
        }
        await repository.upsertManagedConversationRuntimeBinding(
          { userId: user.id },
          {
            executionId: parsed.data.execution.id,
            deploymentId: runner.deploymentId,
            deviceId: runner.deviceId,
            executionGeneration: parsed.data.execution.executionGeneration,
            projectPath
          }
        );
        try {
          const readiness = await proxyManaged(
            "POST",
            `/v1/managed-conversation-runner/executions/${encodeURIComponent(
              parsed.data.execution.id
            )}/runtime-binding-ready`,
            {
              executionGeneration: parsed.data.execution.executionGeneration
            }
          );
          if (!readiness) {
            throw Object.assign(
              new Error(
                "Managed Conversation authority changed before runtime readiness"
              ),
              { statusCode: 503 }
            );
          }
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            "statusCode" in error &&
            typeof error.statusCode === "number" &&
            error.statusCode < 500
          ) {
            await repository
              .clearManagedConversationRuntimeBinding(
                { userId: user.id },
                parsed.data.execution.id
              )
              .catch(() => undefined);
          }
          throw error;
        }
        return reply
          .status(proxied.status)
          .send(await localizeExecutions(user.id, parsed.data));
      }
      const created = await repository.createManagedConversation(
        { userId: user.id },
        {
          projectId: input.projectId,
          provider: input.provider,
          runnerDeploymentId: runner.deploymentId,
          runnerDeviceId: runner.deviceId,
          idempotencyKey: input.idempotencyKey,
          ...("deferUntilRuntimeBinding" in input &&
          input.deferUntilRuntimeBinding === true
            ? { deferUntilRuntimeBinding: true }
            : {})
        }
      );
      if (projectPath) {
        await repository.upsertManagedConversationRuntimeBinding(
          { userId: user.id },
          {
            executionId: created.execution.id,
            deploymentId: runner.deploymentId,
            deviceId: runner.deviceId,
            executionGeneration: created.execution.executionGeneration,
            projectPath
          }
        );
      }
      return reply.status(202).send({
        execution: await publicExecutionFor(user.id, created.execution),
        command: {
          id: created.command.id,
          state: created.command.state
        }
      });
    }
  );

  app.get(
    "/v1/managed-conversations",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      assertAvailable(context);
      const user = await authenticateManaged(request);
      const query = listSchema.parse(request.query);
      const proxied = await proxyManaged(
        "GET",
        "/v1/managed-conversations",
        undefined,
        {
          query: new URLSearchParams({
            limit: String(query.limit),
            ...(query.projectId ? { projectId: query.projectId } : {})
          })
        }
      );
      if (proxied) return await localizeExecutions(user.id, proxied.payload);
      const executions = await context
        .requireRepository()
        .listManagedConversationExecutions({ userId: user.id }, query);
      return {
        executions: await Promise.all(
          executions.map((execution) => publicExecutionFor(user.id, execution))
        )
      };
    }
  );

  app.get(
    "/v1/managed-conversations/:executionId",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      assertAvailable(context);
      const user = await authenticateManaged(request);
      const { executionId } = executionParamsSchema.parse(request.params);
      const proxied = await proxyManaged(
        "GET",
        `/v1/managed-conversations/${encodeURIComponent(executionId)}`
      );
      if (proxied) return await localizeExecutions(user.id, proxied.payload);
      const execution = await context
        .requireRepository()
        .getManagedConversationExecution({ userId: user.id }, executionId);
      if (!execution) {
        throw Object.assign(new Error("Managed Conversation not found"), {
          statusCode: 404
        });
      }
      return { execution: await publicExecutionFor(user.id, execution) };
    }
  );

  app.post(
    "/v1/managed-conversations/:executionId/prompts",
    { preHandler: context.rateLimit.memoryWrite },
    async (request, reply) => {
      assertAvailable(context);
      const user = await authenticateManaged(request);
      const { executionId } = executionParamsSchema.parse(request.params);
      const input = promptSchema.parse(request.body);
      const proxied = await proxyManaged(
        "POST",
        `/v1/managed-conversations/${encodeURIComponent(executionId)}/prompts`,
        input
      );
      if (proxied) return reply.status(proxied.status).send(proxied.payload);
      const command = await context
        .requireRepository()
        .enqueueManagedConversationPrompt(
          { userId: user.id },
          {
            executionId,
            executionGeneration: input.executionGeneration,
            idempotencyKey: input.idempotencyKey,
            prompt: input.prompt
          }
        );
      return reply.status(202).send({
        command: {
          id: command.id,
          state: command.state,
          executionId: command.executionId,
          executionGeneration: command.executionGeneration,
          clientUserMessageId: command.clientUserMessageId,
          createdAt: command.createdAt
        }
      });
    }
  );

  app.post(
    "/v1/managed-conversations/:executionId/handoffs",
    { preHandler: context.rateLimit.memoryWrite },
    async (request, reply) => {
      assertAvailable(context);
      const actor = await authenticateManagedTransfer(request);
      const { executionId } = executionParamsSchema.parse(request.params);
      const input = handoffSchema.parse(request.body);
      const body = {
        operationId: input.operationId,
        targetDeviceId: input.targetDeviceId
      };
      const path = `/v1/managed-conversations/${encodeURIComponent(
        executionId
      )}/handoffs`;
      if (actor.kind === "local_edge") {
        const grant = await resolveLocalTransferGrant({
          actor,
          actionGrantId: input.actionGrantId,
          executionId,
          operation: { kind: "handoff", ...body }
        });
        const proxied = await proxyManaged("POST", path, body, {
          actionGrant: grant.actionGrant,
          expectedBackendId: grant.backendId
        });
        if (!proxied) {
          throw Object.assign(
            new Error("Managed Conversation transfer authority is unavailable"),
            { statusCode: 503 }
          );
        }
        return reply.status(proxied.status).send(proxied.payload);
      }
      if (input.actionGrantId !== undefined) {
        throw Object.assign(
          new Error("Action Grant references are accepted only by local edge"),
          { statusCode: 400 }
        );
      }
      if (actor.kind === "browser") {
        const handoff = await requestHandoff(
          context.requireRepository(),
          actor.user.id,
          executionId,
          body
        );
        return reply.status(202).send({ handoff: publicHandoff(handoff) });
      }
      const result = await context.requireRepository().executeActionGrant({
        actionGrant: actor.actionGrant,
        ownerUserId: actor.user.id,
        deviceCredentialId: actor.auth.credential.id,
        upstreamBackendId: actor.auth.credential.upstreamBackendId,
        teamId: null,
        operationFamily: "managed_execution",
        action: "managed_conversation.handoff",
        targetId: executionId,
        scopeHash: managedConversationTransferScopeHash({
          action: "managed_conversation.handoff",
          executionId
        }),
        requestHash: managedConversationTransferRequestHash({
          method: "POST",
          path,
          body
        }),
        execute: async ({ managedConversation }) => {
          const handoff = await requestHandoff(
            managedConversation,
            actor.user.id,
            executionId,
            body
          );
          return {
            statusCode: 202,
            body: { handoff: publicHandoff(handoff) }
          };
        }
      });
      if (!result) {
        throw Object.assign(
          new Error("Action grant is invalid or has already been consumed"),
          { statusCode: 403 }
        );
      }
      return reply.status(result.statusCode).send(result.body);
    }
  );

  app.get(
    "/v1/managed-conversations/:executionId/handoffs/active",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      assertAvailable(context);
      const user = await authenticateManaged(request);
      const { executionId } = executionParamsSchema.parse(request.params);
      const proxied = await proxyManaged(
        "GET",
        `/v1/managed-conversations/${encodeURIComponent(
          executionId
        )}/handoffs/active`
      );
      if (proxied) return proxied.payload;
      const handoff = await context
        .requireRepository()
        .getActiveManagedConversationHandoffForExecution(
          { userId: user.id },
          executionId
        );
      return { handoff: handoff ? publicHandoff(handoff) : null };
    }
  );

  app.post(
    "/v1/managed-conversations/:executionId/forks",
    { preHandler: context.rateLimit.memoryWrite },
    async (request, reply) => {
      assertAvailable(context);
      const actor = await authenticateManagedTransfer(request);
      const { executionId } = executionParamsSchema.parse(request.params);
      const input = forkSchema.parse(request.body);
      const body = {
        operationId: input.operationId,
        reason: input.reason,
        targetDeviceId: input.targetDeviceId
      };
      const path = `/v1/managed-conversations/${encodeURIComponent(
        executionId
      )}/forks`;
      if (actor.kind === "local_edge") {
        const grant = await resolveLocalTransferGrant({
          actor,
          actionGrantId: input.actionGrantId,
          executionId,
          operation: { kind: "fork", ...body }
        });
        const proxied = await proxyManaged("POST", path, body, {
          actionGrant: grant.actionGrant,
          expectedBackendId: grant.backendId
        });
        if (!proxied) {
          throw Object.assign(
            new Error("Managed Conversation transfer authority is unavailable"),
            { statusCode: 503 }
          );
        }
        return reply.status(proxied.status).send(proxied.payload);
      }
      if (input.actionGrantId !== undefined) {
        throw Object.assign(
          new Error("Action Grant references are accepted only by local edge"),
          { statusCode: 400 }
        );
      }
      if (actor.kind === "browser") {
        const fork = await requestFork(
          context.requireRepository(),
          actor.user.id,
          executionId,
          body
        );
        return reply.status(202).send({ fork: publicFork(fork) });
      }
      const result = await context.requireRepository().executeActionGrant({
        actionGrant: actor.actionGrant,
        ownerUserId: actor.user.id,
        deviceCredentialId: actor.auth.credential.id,
        upstreamBackendId: actor.auth.credential.upstreamBackendId,
        teamId: null,
        operationFamily: "managed_execution",
        action: "managed_conversation.fork",
        targetId: executionId,
        scopeHash: managedConversationTransferScopeHash({
          action: "managed_conversation.fork",
          executionId
        }),
        requestHash: managedConversationTransferRequestHash({
          method: "POST",
          path,
          body
        }),
        execute: async ({ managedConversation }) => {
          const fork = await requestFork(
            managedConversation,
            actor.user.id,
            executionId,
            body
          );
          return {
            statusCode: 202,
            body: { fork: publicFork(fork) }
          };
        }
      });
      if (!result) {
        throw Object.assign(
          new Error("Action grant is invalid or has already been consumed"),
          { statusCode: 403 }
        );
      }
      return reply.status(result.statusCode).send(result.body);
    }
  );

  app.get(
    "/v1/managed-conversations/:executionId/forks/active",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      assertAvailable(context);
      const user = await authenticateManaged(request);
      const { executionId } = executionParamsSchema.parse(request.params);
      const proxied = await proxyManaged(
        "GET",
        `/v1/managed-conversations/${encodeURIComponent(
          executionId
        )}/forks/active`
      );
      if (proxied) return proxied.payload;
      const fork = await context
        .requireRepository()
        .getActiveManagedConversationForkForParent(
          { userId: user.id },
          executionId
        );
      return { fork: fork ? publicFork(fork) : null };
    }
  );

  app.get(
    "/v1/managed-conversations/:executionId/transfers/latest",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      assertAvailable(context);
      const user = await authenticateManaged(request);
      const { executionId } = executionParamsSchema.parse(request.params);
      const path = `/v1/managed-conversations/${encodeURIComponent(
        executionId
      )}/transfers/latest`;
      const proxied = await proxyManaged("GET", path);
      if (proxied) return proxied.payload;
      const [handoff, fork] = await Promise.all([
        context
          .requireRepository()
          .getLatestManagedConversationHandoffForExecution(
            { userId: user.id },
            executionId
          ),
        context
          .requireRepository()
          .getLatestManagedConversationForkForParent(
            { userId: user.id },
            executionId
          )
      ]);
      return {
        handoff: handoff ? publicHandoff(handoff) : null,
        fork: fork ? publicFork(fork) : null
      };
    }
  );
};
