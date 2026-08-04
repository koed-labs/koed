import type { DeviceCredentialRecord } from "@koed/db";
import { verifyLocalEdgeClientCredentialAuthorization } from "@koed/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ApiRouteContext } from "../server/context.js";
import { enforceCollaborationAdmission } from "../collaboration/admission.js";
import {
  localEdgeDeploymentModes,
  type RouteDeploymentMode
} from "../server/route-identity.js";
import {
  approveDeviceEnrollmentChallengeSchema,
  createDeviceEnrollmentChallengeSchema,
  deviceEnrollmentChallengeParamsSchema,
  deviceCredentialParamsSchema,
  localEdgeRouteDecisionSchema,
  localEdgeTeamMemoryAnswerSchema,
  localEdgeTeamMemoryExpandSchema,
  localEdgeTeamMemorySearchSchema,
  localEdgeUpstreamOperationSchema,
  listDeviceCredentialsQuerySchema,
  redeemDeviceEnrollmentChallengeSchema,
  revokeDeviceCredentialSchema
} from "./schemas.js";
import {
  assertUpstreamOperationPathAllowed,
  readLocalEdgeUpstreamRegistry,
  resolveLocalEdgeRouteDecision,
  safeUpstreamProxyUrl,
  upstreamBackendById,
  type LocalEdgeOperationFamily,
  type LocalEdgeRouteDecision
} from "./upstream-routing.js";
import { registerCollaborationCommandRoute } from "./collaboration-command.js";

const publicDeviceCredential = (credential: DeviceCredentialRecord) => ({
  id: credential.id,
  ownerUserId: credential.ownerUserId,
  enrollmentChallengeId: credential.enrollmentChallengeId,
  credentialKeyId: credential.credentialKeyId,
  upstreamBackendId: credential.upstreamBackendId,
  deviceInstanceId: credential.deviceInstanceId,
  deviceLabel: credential.deviceLabel,
  credentialVersion: credential.credentialVersion,
  verifierKind: credential.verifierKind,
  operationFamilies: credential.operationFamilies,
  metadata: redactMetadataSecrets(credential.metadata),
  createdAt: credential.createdAt,
  updatedAt: credential.updatedAt,
  lastUsedAt: credential.lastUsedAt,
  lastValidatedAt: credential.lastValidatedAt,
  expiresAt: credential.expiresAt,
  revokedAt: credential.revokedAt,
  revokedByUserId: credential.revokedByUserId,
  revocationReason: credential.revocationReason
});

const pendingDeviceCredentialMetadataKey = "__koedPendingDeviceCredential";

type PendingDeviceCredential = {
  credentialKeyId: string;
  verifierKind: "secret_hash";
  verifierHash: string;
  operationFamilies?: string[];
  expiresAt?: Date | null;
};

const publicDeviceEnrollmentChallenge = (challenge: {
  id: string;
  upstreamBackendId: string;
  deviceInstanceId: string | null;
  deviceLabel: string | null;
  requestedOperationFamilies: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
  boundAt: string | null;
  redeemedAt: string | null;
}) => {
  const metadata = redactMetadataSecrets(challenge.metadata);
  delete metadata[pendingDeviceCredentialMetadataKey];
  const now = Date.now();
  const denied = metadata.enrollmentDecision === "denied";
  const expired = Date.parse(challenge.expiresAt) <= now;
  const status = denied
    ? "denied"
    : challenge.redeemedAt
      ? "approved"
      : expired
        ? "expired"
        : "pending";

  return {
    id: challenge.id,
    status,
    upstreamBackendId: challenge.upstreamBackendId,
    deviceInstanceId: challenge.deviceInstanceId,
    deviceLabel: challenge.deviceLabel,
    requestedOperationFamilies: challenge.requestedOperationFamilies,
    metadata,
    createdAt: challenge.createdAt,
    expiresAt: challenge.expiresAt,
    approvedAt: denied ? null : challenge.boundAt,
    deniedAt: denied ? challenge.boundAt : null
  };
};

const deviceCredentialIsActive = (
  credential: DeviceCredentialRecord,
  now = new Date()
): boolean =>
  !credential.revokedAt &&
  (!credential.expiresAt || Date.parse(credential.expiresAt) > now.getTime());

const activeDeviceCredentialForDecision = (
  credentials: DeviceCredentialRecord[],
  input: {
    upstreamBackendId?: string | null;
    operationFamily: LocalEdgeOperationFamily;
  }
): DeviceCredentialRecord | null => {
  const now = new Date();
  return (
    credentials.find(
      (credential) =>
        deviceCredentialIsActive(credential, now) &&
        credential.upstreamBackendId === input.upstreamBackendId &&
        credentialAllowsOperation(credential, input.operationFamily)
    ) ?? null
  );
};

const credentialAllowsOperation = (
  credential: DeviceCredentialRecord,
  operationFamily: LocalEdgeOperationFamily
): boolean => credential.operationFamilies.includes(operationFamily);

const secretMetadataKeyParts = [
  "token",
  "secret",
  "password",
  "cookie",
  "authorization",
  "apikey",
  "privatekey",
  "publickey",
  "clientsecret",
  "credential",
  "verifierhash",
  "challengehash"
];

const isSecretMetadataKey = (key: string): boolean => {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return secretMetadataKeyParts.some((part) => normalized.includes(part));
};

const redactMetadataSecrets = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      isSecretMetadataKey(key) ? "[redacted]" : redactMetadataValue(entry)
    ])
  );
};

const redactOptionalMetadata = (
  value: Record<string, unknown> | undefined
): Record<string, unknown> | undefined => {
  if (value === undefined) return undefined;
  const metadata = redactMetadataSecrets(value);
  delete metadata.enrollmentDecision;
  return metadata;
};

const assertLocalEdgeRuntimeProfile = (
  profile: RouteDeploymentMode,
  allowed: readonly RouteDeploymentMode[] = localEdgeDeploymentModes
) => {
  if (!allowed.includes(profile)) {
    throw Object.assign(
      new Error("Local edge route is unavailable for this deployment profile"),
      { statusCode: 404 }
    );
  }
};

const redactMetadataValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(redactMetadataValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return redactMetadataSecrets(value);
};

const pendingDeviceCredentialFromInput = (
  value: NonNullable<
    ReturnType<typeof createDeviceEnrollmentChallengeSchema.parse>
  >["pending_credential"],
  hashSecret: (secret: string) => string
): PendingDeviceCredential | null => {
  if (!value) {
    return null;
  }
  return {
    credentialKeyId: value.credential_key_id,
    verifierKind: value.verifier_kind,
    verifierHash: hashSecret(value.verifier_secret),
    operationFamilies: value.operation_families,
    expiresAt: value.expires_at
  };
};

const pendingDeviceCredentialFromMetadata = (
  metadata: Record<string, unknown>
): PendingDeviceCredential | null => {
  const value = metadata[pendingDeviceCredentialMetadataKey];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const verifierKind = candidate.verifierKind;
  const credentialKeyId = candidate.credentialKeyId;
  if (typeof credentialKeyId !== "string" || verifierKind !== "secret_hash") {
    return null;
  }
  const verifierHash =
    typeof candidate.verifierHash === "string"
      ? candidate.verifierHash
      : undefined;
  if (!verifierHash) {
    return null;
  }
  return {
    credentialKeyId,
    verifierKind,
    verifierHash,
    operationFamilies: Array.isArray(candidate.operationFamilies)
      ? candidate.operationFamilies.filter(
          (family): family is string => typeof family === "string"
        )
      : undefined,
    expiresAt:
      typeof candidate.expiresAt === "string"
        ? new Date(candidate.expiresAt)
        : null
  };
};

const stripInternalChallengeMetadata = (
  metadata: Record<string, unknown>
): Record<string, unknown> => {
  const safe = { ...metadata };
  delete safe[pendingDeviceCredentialMetadataKey];
  return redactMetadataSecrets(safe);
};

export const registerLocalEdgeRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
) => {
  const {
    requireRepository,
    auth: {
      authenticateSession,
      authenticateApiToken,
      authenticateDeviceCredential,
      hashSecret
    },
    rateLimit: {
      memoryRead: memoryReadRateLimit,
      memoryWrite: memoryWriteRateLimit
    },
    capture: { resolveCapturePolicyForRequest },
    collaboration: { admission: collaborationAdmission },
    localEdge: {
      upstreamBackendsPath,
      remoteOperationsAllowed,
      fetch: upstreamFetch,
      resolveUpstreamAuthorization
    }
  } = context;

  const upstreamRegistry = () =>
    readLocalEdgeUpstreamRegistry(upstreamBackendsPath);

  const authorizeLocalTeamMemoryRequest = (request: FastifyRequest) => {
    assertLocalEdgeRuntimeProfile(context.config.deploymentProfile);
    const body = request.body;
    const upstreamBackendId =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>).upstream_backend_id
        : undefined;
    const localCredential =
      typeof upstreamBackendId === "string"
        ? verifyLocalEdgeClientCredentialAuthorization(
            context.config.koedHome,
            request.headers.authorization,
            {
              backendId: upstreamBackendId,
              operationFamily: "team_workspace_read"
            }
          )
        : null;
    if (!localCredential) {
      throw Object.assign(
        new Error(
          "Scoped local-edge client credential required for Team Memory"
        ),
        { statusCode: 401 }
      );
    }
    return localCredential;
  };

  const relayTeamMemoryRequest = async (
    reply: FastifyReply,
    input: {
      upstreamBackendId: string;
      method: "GET" | "POST";
      path: string;
      body?: Record<string, unknown>;
    },
    localCredential: ReturnType<typeof authorizeLocalTeamMemoryRequest>
  ) => {
    const backend = upstreamBackendById(
      upstreamRegistry(),
      input.upstreamBackendId
    );
    const upstreamAuthorization = backend
      ? resolveUpstreamAuthorization(backend)
      : null;
    const decision = resolveLocalEdgeRouteDecision({
      operationFamily: "team_workspace_read",
      requestedMode: "live_upstream_proxy",
      upstreamBackend: backend,
      upstreamBackendId: input.upstreamBackendId,
      deviceCredential: {
        upstreamBackendId: localCredential.backendId,
        operationFamilies: localCredential.operationFamilies
      },
      upstreamCredentialAvailable: Boolean(upstreamAuthorization)
    });
    assertLiveProxyDecision(decision);
    if (!backend) {
      throw Object.assign(new Error("upstream_not_registered"), {
        statusCode: 424
      });
    }
    if (!upstreamAuthorization) {
      throw Object.assign(new Error("upstream_credential_missing"), {
        statusCode: 424
      });
    }
    const upstreamResponse = await upstreamFetch(
      safeUpstreamProxyUrl(backend, input.path),
      {
        method: input.method,
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: upstreamAuthorization,
          ...(input.method === "POST"
            ? { "content-type": "application/json" }
            : {})
        },
        body:
          input.method === "POST" ? JSON.stringify(input.body ?? {}) : undefined
      }
    );
    reply.header("x-koed-upstream-backend-id", backend.id);
    reply.status(upstreamResponse.status);
    if (upstreamResponse.status === 204) return reply.send();
    const text = await upstreamResponse.text();
    const contentType = upstreamResponse.headers.get("content-type") ?? "";
    return contentType.includes("application/json")
      ? text
        ? (JSON.parse(text) as unknown)
        : {}
      : { upstreamStatus: upstreamResponse.status, body: text };
  };

  registerCollaborationCommandRoute(app, {
    deploymentProfile: context.config.deploymentProfile,
    resolveVerifiedLocalDeploymentId: () => {
      const identity = context.deploymentIdentity.inspect();
      if (
        identity.health !== "healthy" ||
        !identity.remoteOperationsAllowed ||
        !identity.deploymentId
      ) {
        throw Object.assign(
          new Error("Local deployment identity is not verified"),
          { statusCode: 424 }
        );
      }
      return identity.deploymentId;
    },
    teamCollaborationEnabled: context.config.teamCollaborationEnabled,
    koedHome: context.config.koedHome,
    upstreamBackendsPath,
    corsOrigins: context.config.corsOrigins,
    fetch: upstreamFetch,
    resolveUpstreamAuthorization,
    requireCollaborationRepository: requireRepository,
    resolveActiveLocalUser: (userId) => requireRepository().getUser(userId),
    actionGrantControl: context.collaboration.actionGrantControl,
    actionGrantLifecycle: context.collaboration.actionGrantLifecycle,
    sharedMemoryControl: context.collaboration.sharedMemoryControl,
    subscribeRemoteNavigationInvalidation:
      context.collaboration.subscribeNavigationInvalidation,
    readPreHandler: memoryReadRateLimit,
    writePreHandler: memoryWriteRateLimit
  });

  app.post(
    "/v1/local-edge/device-enrollments/challenges",
    { preHandler: memoryWriteRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      const input = createDeviceEnrollmentChallengeSchema.parse(request.body);
      await enforceCollaborationAdmission(
        reply,
        collaborationAdmission.admitConnectionFailure({
          deviceId: input.device_instance_id ?? input.challenge_hash,
          origin: request.headers.origin ?? request.ip
        })
      );
      let rotationLineageId: string | null = null;
      let rotationOwnerUserId: string | null = null;
      let rotationCredentialId: string | null = null;
      let deviceInstanceId = input.device_instance_id;
      if (input.rotate_credential_id) {
        const rotation = await authenticateDeviceCredential(request);
        if (
          rotation.credential.id !== input.rotate_credential_id ||
          rotation.credential.upstreamBackendId !== input.upstream_backend_id ||
          (input.device_instance_id !== undefined &&
            rotation.credential.deviceInstanceId !== input.device_instance_id)
        ) {
          throw Object.assign(
            new Error("Device credential rotation is invalid"),
            {
              statusCode: 403
            }
          );
        }
        rotationLineageId = rotation.credential.lineageId;
        rotationOwnerUserId = rotation.credential.ownerUserId;
        rotationCredentialId = rotation.credential.id;
        deviceInstanceId = rotation.credential.deviceInstanceId;
      }
      const pendingCredential = pendingDeviceCredentialFromInput(
        input.pending_credential,
        hashSecret
      );
      const requestedOperationFamilies =
        input.requested_operation_families ??
        pendingCredential?.operationFamilies;
      if (!requestedOperationFamilies) {
        throw Object.assign(
          new Error("At least one requested operation family is required"),
          { statusCode: 400 }
        );
      }
      const requestedFamilySet = new Set(requestedOperationFamilies);
      if (
        pendingCredential?.operationFamilies?.some(
          (family) => !requestedFamilySet.has(family)
        )
      ) {
        throw Object.assign(
          new Error(
            "Pending credential operation families exceed enrollment challenge"
          ),
          { statusCode: 400 }
        );
      }
      const metadata = redactOptionalMetadata(input.metadata) ?? {};
      metadata.protocolDeploymentId = input.protocol_deployment_id;
      if (pendingCredential) {
        metadata[pendingDeviceCredentialMetadataKey] = pendingCredential;
      }
      const challenge = await repo.createDeviceEnrollmentChallenge({
        challengeHash: input.challenge_hash,
        upstreamBackendId: input.upstream_backend_id,
        deviceInstanceId,
        rotationLineageId,
        rotationOwnerUserId,
        rotationCredentialId,
        deviceLabel: input.device_label,
        requestedOperationFamilies,
        metadata,
        expiresAt: new Date(Date.now() + input.ttl_seconds * 1000)
      });

      const publicChallenge = publicDeviceEnrollmentChallenge(challenge);
      return {
        challenge: publicChallenge,
        ...(context.config.explorerPublicUrl
          ? {
              activationUrl: new URL(
                `device-enrollment/${encodeURIComponent(publicChallenge.id)}`,
                `${context.config.explorerPublicUrl}/`
              ).toString()
            }
          : {})
      };
    }
  );

  app.get(
    "/v1/local-edge/device-enrollments/challenges/:challengeId",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const repo = requireRepository();
      const params = deviceEnrollmentChallengeParamsSchema.parse(
        request.params
      );
      const challenge = await repo.getDeviceEnrollmentChallenge(
        params.challengeId
      );
      if (!challenge) {
        throw Object.assign(
          new Error("Device enrollment challenge not found"),
          {
            statusCode: 404
          }
        );
      }

      return { challenge: publicDeviceEnrollmentChallenge(challenge) };
    }
  );

  app.post(
    "/v1/local-edge/device-enrollments/challenges/:challengeId/approval",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateSession(request);
      const params = deviceEnrollmentChallengeParamsSchema.parse(
        request.params
      );
      const input = approveDeviceEnrollmentChallengeSchema.parse(request.body);
      const challenge = await repo.getDeviceEnrollmentChallenge(
        params.challengeId
      );
      if (!challenge) {
        throw Object.assign(
          new Error("Device enrollment challenge not found"),
          {
            statusCode: 404
          }
        );
      }

      if (input.decision === "deny") {
        const denied = await repo.denyDeviceEnrollmentChallenge(
          { userId: user.id },
          params.challengeId
        );
        if (!denied) {
          const current = await repo.getDeviceEnrollmentChallenge(
            params.challengeId
          );
          return {
            challenge: current
              ? publicDeviceEnrollmentChallenge(current)
              : publicDeviceEnrollmentChallenge(challenge)
          };
        }
        return { challenge: publicDeviceEnrollmentChallenge(denied) };
      }

      const pendingCredential = pendingDeviceCredentialFromMetadata(
        challenge.metadata
      );
      if (!pendingCredential) {
        throw Object.assign(
          new Error("Device enrollment challenge cannot be approved"),
          { statusCode: 400 }
        );
      }
      const credential = await repo.approveDeviceEnrollmentChallenge(
        { userId: user.id },
        params.challengeId,
        {
          credentialKeyId: pendingCredential.credentialKeyId,
          verifierKind: pendingCredential.verifierKind,
          verifierHash: pendingCredential.verifierHash,
          publicKeyJwk: null,
          operationFamilies: pendingCredential.operationFamilies,
          metadata: stripInternalChallengeMetadata(challenge.metadata),
          expiresAt: pendingCredential.expiresAt
        }
      );
      if (!credential) {
        const current = await repo.getDeviceEnrollmentChallenge(
          params.challengeId
        );
        return {
          challenge: current
            ? publicDeviceEnrollmentChallenge(current)
            : publicDeviceEnrollmentChallenge(challenge)
        };
      }

      return {
        challenge: {
          ...publicDeviceEnrollmentChallenge({
            ...challenge,
            boundAt: credential.createdAt,
            redeemedAt: credential.createdAt
          }),
          status: "approved"
        },
        credential: publicDeviceCredential(credential)
      };
    }
  );

  app.post(
    "/v1/local-edge/device-enrollments/credentials",
    { preHandler: memoryWriteRateLimit },
    async (request, reply) => {
      const repo = requireRepository();
      const user = await authenticateSession(request);
      const input = redeemDeviceEnrollmentChallengeSchema.parse(request.body);
      await enforceCollaborationAdmission(
        reply,
        collaborationAdmission.admitConnectionFailure({
          deviceId: input.credential_key_id,
          origin: request.headers.origin ?? request.ip
        })
      );
      const credential = await repo.redeemDeviceEnrollmentChallenge(
        { userId: user.id },
        {
          challengeHash: input.challenge_hash,
          credentialKeyId: input.credential_key_id,
          verifierKind: input.verifier_kind,
          verifierHash: input.verifier_secret
            ? hashSecret(input.verifier_secret)
            : null,
          publicKeyJwk: null,
          operationFamilies: input.operation_families,
          metadata: redactOptionalMetadata(input.metadata),
          expiresAt: input.expires_at
        }
      );
      if (!credential) {
        throw Object.assign(new Error("Device enrollment challenge invalid"), {
          statusCode: 404
        });
      }

      return { credential: publicDeviceCredential(credential) };
    }
  );

  app.get(
    "/v1/local-edge/device-credentials",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateSession(request);
      const query = listDeviceCredentialsQuerySchema.parse(request.query);
      const credentials = await repo.listDeviceCredentials(
        { userId: user.id },
        { upstreamBackendId: query.upstream_backend_id }
      );

      return { credentials: credentials.map(publicDeviceCredential) };
    }
  );

  app.delete(
    "/v1/local-edge/device-credentials/current",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      const repo = requireRepository();
      const authContext = await authenticateDeviceCredential(request);
      const revoked = await repo.revokeDeviceCredential(
        { userId: authContext.user.id },
        authContext.credential.id,
        "local_edge_disconnected"
      );
      if (!revoked) {
        throw Object.assign(new Error("Device credential not found"), {
          statusCode: 404
        });
      }

      return { revoked: true };
    }
  );

  app.delete(
    "/v1/local-edge/device-credentials/:credentialId",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateSession(request);
      const params = deviceCredentialParamsSchema.parse(request.params);
      const input = revokeDeviceCredentialSchema.parse(request.body ?? {});
      const revoked = await repo.revokeDeviceCredential(
        { userId: user.id },
        params.credentialId,
        input.reason
      );
      if (!revoked) {
        throw Object.assign(new Error("Device credential not found"), {
          statusCode: 404
        });
      }

      return { revoked: true };
    }
  );

  app.get(
    "/v1/local-edge/device-credentials/status",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      const authContext = await authenticateDeviceCredential(request);

      return {
        ok: true,
        auth: "device_credential",
        user: {
          id: authContext.user.id,
          email: authContext.user.email,
          displayName: authContext.user.displayName
        },
        credential: publicDeviceCredential(authContext.credential)
      };
    }
  );

  app.post(
    "/v1/local-edge/route-decisions",
    { preHandler: memoryReadRateLimit },
    async (request) => {
      assertLocalEdgeRuntimeProfile(context.config.deploymentProfile);
      const repo = requireRepository();
      const user = await authenticateSession(request);
      const input = localEdgeRouteDecisionSchema.parse(request.body);
      const registry = upstreamRegistry();
      const upstreamBackend = input.upstream_backend_id
        ? upstreamBackendById(registry, input.upstream_backend_id)
        : null;
      const credentials = input.upstream_backend_id
        ? await repo.listDeviceCredentials(
            { userId: user.id },
            { upstreamBackendId: input.upstream_backend_id }
          )
        : [];
      const capturePolicy =
        input.operation_family === "capture_writes"
          ? await resolveCapturePolicyForRequest(
              repo,
              { userId: user.id },
              {
                projectId: input.capture_context?.project_id,
                sessionId: input.capture_context?.session_id,
                threadId: input.capture_context?.thread_id
              }
            )
          : null;
      const decision = resolveLocalEdgeRouteDecision({
        operationFamily: input.operation_family,
        requestedMode: input.requested_mode,
        upstreamBackend,
        upstreamBackendId: input.upstream_backend_id,
        deviceCredential: activeDeviceCredentialForDecision(credentials, {
          upstreamBackendId: input.upstream_backend_id,
          operationFamily: input.operation_family
        }),
        upstreamCredentialAvailable: upstreamBackend
          ? Boolean(resolveUpstreamAuthorization(upstreamBackend))
          : false,
        capturePolicy
      });

      return { decision };
    }
  );

  app.post(
    "/v1/local-edge/team-memory/search",
    { preHandler: memoryReadRateLimit },
    async (request, reply) => {
      const localCredential = authorizeLocalTeamMemoryRequest(request);
      const input = localEdgeTeamMemorySearchSchema.parse(request.body);
      return relayTeamMemoryRequest(
        reply,
        {
          upstreamBackendId: input.upstream_backend_id,
          method: "POST",
          path: "/v1/memory/search",
          body: input.input
        },
        localCredential
      );
    }
  );

  app.post(
    "/v1/local-edge/team-memory/answer",
    { preHandler: memoryReadRateLimit },
    async (request, reply) => {
      const localCredential = authorizeLocalTeamMemoryRequest(request);
      const input = localEdgeTeamMemoryAnswerSchema.parse(request.body);
      return relayTeamMemoryRequest(
        reply,
        {
          upstreamBackendId: input.upstream_backend_id,
          method: "POST",
          path: "/v1/memory/answer",
          body: input.input
        },
        localCredential
      );
    }
  );

  app.post(
    "/v1/local-edge/team-memory/expand",
    { preHandler: memoryReadRateLimit },
    async (request, reply) => {
      const localCredential = authorizeLocalTeamMemoryRequest(request);
      const input = localEdgeTeamMemoryExpandSchema.parse(request.body);
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(input.input)) {
        if (value === undefined) continue;
        query.set(
          key,
          value instanceof Date ? value.toISOString() : String(value)
        );
      }
      return relayTeamMemoryRequest(
        reply,
        {
          upstreamBackendId: input.upstream_backend_id,
          method: "GET",
          path: `/v1/memory/nodes/${encodeURIComponent(input.node_id)}/expand?${query.toString()}`
        },
        localCredential
      );
    }
  );

  app.post(
    "/v1/local-edge/upstream-operations",
    { preHandler: memoryWriteRateLimit },
    async (request, reply) => {
      assertLocalEdgeRuntimeProfile(context.config.deploymentProfile);
      const repo = requireRepository();
      const input = localEdgeUpstreamOperationSchema.parse(request.body);
      const authHeader = request.headers.authorization?.trim() ?? "";
      const authScheme = authHeader.split(/\s+/, 1)[0]?.toLowerCase();
      let authContext:
        | Awaited<ReturnType<typeof authenticateDeviceCredential>>
        | {
            user: Awaited<ReturnType<typeof authenticateApiToken>>;
            credential: null;
          }
        | {
            user: null;
            credential: {
              upstreamBackendId: string;
              operationFamilies: string[];
            };
          };
      if (authScheme === "bearer") {
        const user = await authenticateApiToken(request);
        if (
          input.operation_family !== "personal_memory_read" &&
          input.operation_family !== "capture_writes"
        ) {
          throw Object.assign(
            new Error(
              "Scoped local-edge client credential required for Team upstream operations"
            ),
            { statusCode: 403 }
          );
        }
        authContext = { user, credential: null };
      } else if (authScheme === "koed-device") {
        const localClientCredential =
          verifyLocalEdgeClientCredentialAuthorization(
            context.config.koedHome,
            authHeader,
            {
              backendId: input.upstream_backend_id,
              operationFamily: input.operation_family
            }
          );
        authContext = localClientCredential
          ? {
              user: null,
              credential: {
                upstreamBackendId: localClientCredential.backendId,
                operationFamilies: localClientCredential.operationFamilies
              }
            }
          : await authenticateDeviceCredential(request);
      } else {
        throw Object.assign(
          new Error(
            "Scoped local-edge client or device credential required for upstream operations"
          ),
          { statusCode: 401 }
        );
      }
      const registry = upstreamRegistry();
      const upstreamBackend = upstreamBackendById(
        registry,
        input.upstream_backend_id
      );
      const capturePolicy =
        input.operation_family === "capture_writes"
          ? await resolveCapturePolicyForRequest(
              repo,
              { userId: authContext.user!.id },
              {
                projectId: input.capture_context?.project_id,
                sessionId: input.capture_context?.session_id,
                threadId: input.capture_context?.thread_id
              }
            )
          : null;
      const decision = resolveLocalEdgeRouteDecision({
        operationFamily: input.operation_family,
        requestedMode: input.requested_mode,
        upstreamBackend,
        upstreamBackendId: input.upstream_backend_id,
        deviceCredential: authContext.credential,
        upstreamCredentialAvailable: upstreamBackend
          ? Boolean(resolveUpstreamAuthorization(upstreamBackend))
          : false,
        identityRemoteOperationsAllowed: remoteOperationsAllowed(),
        capturePolicy
      });
      assertLiveProxyDecision(decision);
      assertUpstreamOperationPathAllowed(
        input.operation_family,
        input.method,
        input.path
      );
      if (!upstreamBackend) {
        throw Object.assign(new Error("upstream_not_registered"), {
          statusCode: 424
        });
      }
      const url = safeUpstreamProxyUrl(upstreamBackend, input.path);
      const upstreamAuthorization =
        resolveUpstreamAuthorization(upstreamBackend);
      if (!upstreamAuthorization) {
        throw Object.assign(new Error("upstream_credential_missing"), {
          statusCode: 424
        });
      }
      const upstreamResponse = await upstreamFetch(url, {
        method: input.method,
        redirect: "error",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: upstreamAuthorization
        },
        body:
          input.method === "GET" ? undefined : JSON.stringify(input.body ?? {})
      });
      reply.header("x-koed-upstream-backend-id", upstreamBackend.id);
      reply.status(upstreamResponse.status);
      if (upstreamResponse.status === 204) {
        return reply.send();
      }
      const text = await upstreamResponse.text();
      const contentType = upstreamResponse.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        return text ? JSON.parse(text) : {};
      }
      return { upstreamStatus: upstreamResponse.status, body: text };
    }
  );
};

const assertLiveProxyDecision = (decision: LocalEdgeRouteDecision): void => {
  if (decision.action === "live_upstream_proxy") {
    return;
  }
  throw Object.assign(new Error(decision.reason), {
    statusCode:
      decision.reason === "capture_disabled" ||
      decision.reason === "unsupported_capture_visibility"
        ? 403
        : 424
  });
};
