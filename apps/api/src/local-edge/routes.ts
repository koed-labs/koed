import type { DeviceCredentialRecord } from "@koed/db";
import type { FastifyInstance } from "fastify";
import type { ApiRouteContext } from "../server/context.js";
import {
  localEdgeDeploymentModes,
  type RouteDeploymentMode
} from "../server/route-identity.js";
import {
  createDeviceEnrollmentChallengeSchema,
  deviceCredentialParamsSchema,
  localEdgeRouteDecisionSchema,
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
): boolean =>
  credential.operationFamilies.includes(operationFamily) ||
  credential.operationFamilies.includes("*");

const secretMetadataKeyParts = [
  "token",
  "secret",
  "password",
  "cookie",
  "authorization",
  "apikey",
  "privatekey",
  "clientsecret",
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
): Record<string, unknown> | undefined =>
  value === undefined ? undefined : redactMetadataSecrets(value);

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

export const registerLocalEdgeRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
) => {
  const {
    requireRepository,
    auth: { authenticateSession, authenticateDeviceCredential, hashSecret },
    rateLimit: {
      memoryRead: memoryReadRateLimit,
      memoryWrite: memoryWriteRateLimit
    },
    capture: { resolveCapturePolicyForRequest },
    localEdge: {
      upstreamBackendsPath,
      fetch: upstreamFetch,
      resolveUpstreamAuthorization
    }
  } = context;

  const upstreamRegistry = () =>
    readLocalEdgeUpstreamRegistry(upstreamBackendsPath);

  app.post(
    "/v1/local-edge/device-enrollments/challenges",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      const repo = requireRepository();
      await authenticateSession(request);
      const input = createDeviceEnrollmentChallengeSchema.parse(request.body);
      const challenge = await repo.createDeviceEnrollmentChallenge({
        challengeHash: input.challenge_hash,
        upstreamBackendId: input.upstream_backend_id,
        deviceInstanceId: input.device_instance_id,
        deviceLabel: input.device_label,
        requestedOperationFamilies: input.requested_operation_families,
        metadata: redactOptionalMetadata(input.metadata),
        expiresAt: new Date(Date.now() + input.ttl_seconds * 1000)
      });

      return { challenge };
    }
  );

  app.post(
    "/v1/local-edge/device-enrollments/credentials",
    { preHandler: memoryWriteRateLimit },
    async (request) => {
      const repo = requireRepository();
      const user = await authenticateSession(request);
      const input = redeemDeviceEnrollmentChallengeSchema.parse(request.body);
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
      assertLocalEdgeRuntimeProfile(context.config.deploymentProfile);
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
                workspaceId: input.capture_context?.workspace_id,
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
    "/v1/local-edge/upstream-operations",
    { preHandler: memoryWriteRateLimit },
    async (request, reply) => {
      assertLocalEdgeRuntimeProfile(context.config.deploymentProfile);
      const repo = requireRepository();
      const authContext = await authenticateDeviceCredential(request);
      const input = localEdgeUpstreamOperationSchema.parse(request.body);
      const registry = upstreamRegistry();
      const upstreamBackend = upstreamBackendById(
        registry,
        input.upstream_backend_id
      );
      const capturePolicy =
        input.operation_family === "capture_writes"
          ? await resolveCapturePolicyForRequest(
              repo,
              { userId: authContext.user.id },
              {
                workspaceId: input.capture_context?.workspace_id,
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
