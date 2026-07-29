import {
  defaultFreshAuthenticationMaxAgeMs,
  type DeviceCredentialAuthContext,
  type MemorySourceRepository,
  type PurgeJobRecord,
  type RetentionLifecycleRepository,
  type UserSessionContext
} from "@koed/db";
import {
  highRiskActionGrantCanonicalHash,
  HIGH_RISK_ACTION_GRANT_HASH_DOMAINS
} from "@koed/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AuthHelpers } from "../auth/session.js";
import type { RateLimitHandler } from "../infra/rate-limit.js";
import {
  confirmRetentionPolicyShorteningSchema,
  confirmLegalHoldReleaseSchema,
  legalHoldParamsSchema,
  ownerPrivateReplicaPurgeRequestSchema,
  placeLegalHoldSchema,
  previewRetentionPolicyShorteningSchema,
  retentionPolicyParamsSchema,
  retentionPolicyPreviewParamsSchema,
  retentionOwnerPrivateReplicaParamsSchema,
  retentionTeamParamsSchema,
  rootTeamDeletionRequestSchema,
  userErasureRequestSchema,
  versionRetentionPolicySchema
} from "./schemas.js";

type HighRiskRepository = Pick<
  MemorySourceRepository,
  "executeActionGrant" | "lookupLegalHoldTeamId"
>;

export interface RetentionRouteContext {
  requireRetentionRepository(): RetentionLifecycleRepository;
  requireHighRiskRepository(): HighRiskRepository;
  authenticateSessionContext: AuthHelpers["authenticateSessionContext"];
  authenticateDeviceCredential: AuthHelpers["authenticateDeviceCredential"];
  writeRateLimit: RateLimitHandler;
}

const forbidden = (message = "Retention operation is not authorized") =>
  Object.assign(new Error(message), { statusCode: 403 });

const conflict = (message = "Retention operation conflict") =>
  Object.assign(new Error(message), { statusCode: 409 });

const isBearerRequest = (request: FastifyRequest): boolean =>
  /^Bearer(?:\s|$)/i.test(request.headers.authorization?.trim() ?? "");

const isDeviceRequest = (request: FastifyRequest): boolean =>
  /^Koed-Device(?:\s|$)/i.test(request.headers.authorization?.trim() ?? "");

const rejectApiToken = (request: FastifyRequest): void => {
  if (isBearerRequest(request)) {
    throw forbidden("API Tokens cannot authorize retention operations");
  }
};

export const retentionAdminScopeHash = (input: {
  action: string;
  teamId: string | null;
  targetId: string | null;
}): string =>
  highRiskActionGrantCanonicalHash(
    HIGH_RISK_ACTION_GRANT_HASH_DOMAINS.retentionAdminScope,
    {
      operationFamily: "admin",
      action: input.action,
      teamId: input.teamId,
      targetId: input.targetId
    }
  );

export const retentionAdminRequestHash = (input: {
  method: string;
  path: string;
  body: unknown;
}): string =>
  highRiskActionGrantCanonicalHash(
    HIGH_RISK_ACTION_GRANT_HASH_DOMAINS.retentionAdminRequest,
    input
  );

const actionGrantHeader = (request: FastifyRequest): string | null => {
  const value = request.headers["x-koed-action-grant"];
  const token = Array.isArray(value) ? value[0] : value;
  return token?.trim() || null;
};

const requestPath = (request: FastifyRequest): string =>
  new URL(request.url, "http://koed.local").pathname;

const requireFreshSession = async (
  request: FastifyRequest,
  context: RetentionRouteContext
): Promise<UserSessionContext> => {
  rejectApiToken(request);
  const session = await context.authenticateSessionContext(request);
  const ageMs = Date.now() - session.createdAt.getTime();
  if (
    !Number.isFinite(ageMs) ||
    ageMs < 0 ||
    ageMs > defaultFreshAuthenticationMaxAgeMs
  ) {
    throw forbidden("Fresh browser authentication is required");
  }
  return session;
};

const requireBrowserPolicyManager = async (
  request: FastifyRequest,
  context: RetentionRouteContext
): Promise<UserSessionContext> => {
  if (isDeviceRequest(request)) {
    throw forbidden("Retention policy changes require a fresh browser session");
  }
  return requireFreshSession(request, context);
};

const authenticateHighRiskActor = async (
  request: FastifyRequest,
  context: RetentionRouteContext
) => {
  rejectApiToken(request);
  if (!isDeviceRequest(request)) {
    const session = await requireFreshSession(request, context);
    return {
      kind: "browser" as const,
      user: session.user,
      session
    };
  }

  const device: DeviceCredentialAuthContext =
    await context.authenticateDeviceCredential(request);
  if (!device.credential.operationFamilies.includes("action_grant")) {
    throw forbidden(
      "Device credential is not allowed for retention operations"
    );
  }
  const actionGrant = actionGrantHeader(request);
  if (!actionGrant) throw forbidden("One-time action grant required");
  return { kind: "device" as const, device, actionGrant };
};

const mapVersionError = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "STALE_VERSION"
    ) {
      throw conflict("Stale version");
    }
    throw error;
  }
};

const teamIdForHoldBody = (body: unknown): string | null => {
  const parsed = placeLegalHoldSchema.parse(body);
  return "teamId" in parsed.target ? parsed.target.teamId : null;
};

const runHighRiskRetentionWrite = async <TBody>(
  request: FastifyRequest,
  context: RetentionRouteContext,
  actor: Awaited<ReturnType<typeof authenticateHighRiskActor>>,
  input: {
    action: string;
    teamId: string | null;
    targetId: string | null;
    body: unknown;
  },
  execute: (
    repository: RetentionLifecycleRepository
  ) => Promise<{ statusCode: number; body: TBody } | null>
): Promise<{ statusCode: number; body: TBody }> => {
  if (actor.kind === "browser") {
    const result = await execute(context.requireRetentionRepository());
    if (!result) throw forbidden();
    return result;
  }
  const result = await context.requireHighRiskRepository().executeActionGrant({
    actionGrant: actor.actionGrant,
    ownerUserId: actor.device.user.id,
    deviceCredentialId: actor.device.credential.id,
    upstreamBackendId: actor.device.credential.upstreamBackendId,
    teamId: input.teamId,
    operationFamily: "admin",
    action: input.action,
    targetId: input.targetId,
    scopeHash: retentionAdminScopeHash(input),
    requestHash: retentionAdminRequestHash({
      method: request.method.toUpperCase(),
      path: requestPath(request),
      body: input.body
    }),
    execute: async ({ retention }) => execute(retention)
  });
  if (!result) {
    throw forbidden("Action grant is invalid or has already been consumed");
  }
  return result;
};

export const registerRetentionRoutes = (
  app: FastifyInstance,
  context: RetentionRouteContext
): void => {
  app.post(
    "/v1/retention/teams/:teamId/policies/:policyId/versions",
    { preHandler: context.writeRateLimit },
    async (request, reply) => {
      const session = await requireBrowserPolicyManager(request, context);
      const params = retentionPolicyParamsSchema.parse(request.params);
      const input = versionRetentionPolicySchema.parse(request.body);
      const policy = await context.requireRetentionRepository().versionPolicy({
        policyId: params.policyId,
        retentionSeconds: input.retentionSeconds,
        deletionGraceSeconds: input.deletionGraceSeconds,
        backupRetentionSeconds: input.backupRetentionSeconds,
        effectiveAt: input.effectiveAt,
        actorUserId: session.user.id,
        expectedTeamId: params.teamId
      });
      return reply.status(201).send({ policy });
    }
  );

  app.post(
    "/v1/retention/teams/:teamId/policies/:policyId/shortening-previews",
    { preHandler: context.writeRateLimit },
    async (request, reply) => {
      const session = await requireBrowserPolicyManager(request, context);
      const params = retentionPolicyParamsSchema.parse(request.params);
      const input = previewRetentionPolicyShorteningSchema.parse(request.body);
      const preview = await context
        .requireRetentionRepository()
        .previewPolicyShortening({
          policyId: params.policyId,
          policyVersion: input.policyVersion,
          actorUserId: session.user.id,
          expectedTeamId: params.teamId,
          graceSeconds: input.graceSeconds
        });
      return reply.status(201).send({ preview });
    }
  );

  app.post(
    "/v1/retention/teams/:teamId/policies/:policyId/shortening-previews/:previewId/confirmation",
    { preHandler: context.writeRateLimit },
    async (request) => {
      const session = await requireBrowserPolicyManager(request, context);
      const params = retentionPolicyPreviewParamsSchema.parse(request.params);
      const input = confirmRetentionPolicyShorteningSchema.parse(request.body);
      const confirmation = await context
        .requireRetentionRepository()
        .confirmPolicyShortening({
          previewId: params.previewId,
          previewHash: input.previewHash,
          expectedAffectedScopeCount: input.expectedAffectedScopeCount,
          actorUserId: session.user.id,
          expectedTeamId: params.teamId,
          expectedPolicyId: params.policyId
        });
      return { confirmation };
    }
  );

  app.post(
    "/v1/retention/teams/:teamId/deletion-request",
    { preHandler: context.writeRateLimit },
    async (request, reply) => {
      const actor = await authenticateHighRiskActor(request, context);
      const params = retentionTeamParamsSchema.parse(request.params);
      const input = rootTeamDeletionRequestSchema.parse(request.body);
      return reply.status(201).send(
        (
          await mapVersionError(() =>
            runHighRiskRetentionWrite(
              request,
              context,
              actor,
              {
                action: "team.retention.delete_request",
                teamId: params.teamId,
                targetId: params.teamId,
                body: request.body
              },
              async (repo) => {
                const result = await repo.requestRootTeamDeletion({
                  teamId: params.teamId,
                  actorUserId:
                    actor.kind === "browser"
                      ? actor.user.id
                      : actor.device.user.id,
                  expectedVersion: input.expectedVersion,
                  idempotencyKey: input.idempotencyKey
                });
                return result ? { statusCode: 201, body: result } : null;
              }
            )
          )
        ).body
      );
    }
  );

  app.post(
    "/v1/retention/owner-private-replicas/:ownerPrivateReplicaId/purge-request",
    { preHandler: context.writeRateLimit },
    async (request, reply) => {
      const actor = await authenticateHighRiskActor(request, context);
      const params = retentionOwnerPrivateReplicaParamsSchema.parse(
        request.params
      );
      const input = ownerPrivateReplicaPurgeRequestSchema.parse(request.body);
      return reply.status(201).send(
        (
          await mapVersionError(() =>
            runHighRiskRetentionWrite(
              request,
              context,
              actor,
              {
                action: "owner_private_replica.retention.purge_request",
                teamId: null,
                targetId: params.ownerPrivateReplicaId,
                body: request.body
              },
              async (repository) => {
                const result = await repository.requestOwnerPrivateReplicaPurge(
                  {
                    ownerPrivateReplicaId: params.ownerPrivateReplicaId,
                    actorUserId:
                      actor.kind === "browser"
                        ? actor.user.id
                        : actor.device.user.id,
                    expectedVersion: input.expectedVersion,
                    trigger: "source_purge",
                    idempotencyKey: input.idempotencyKey
                  }
                );
                return result ? { statusCode: 201, body: result } : null;
              }
            )
          )
        ).body
      );
    }
  );

  app.post(
    "/v1/retention/users/me/erasure-request",
    { preHandler: context.writeRateLimit },
    async (request, reply) => {
      if (isDeviceRequest(request)) {
        throw forbidden("User erasure requires a fresh browser session");
      }
      const session = await requireFreshSession(request, context);
      userErasureRequestSchema.parse(request.body);
      const repository = context.requireRetentionRepository();
      const replicas = await repository.listOwnerPrivateReplicasForUserErasure(
        session.user.id
      );
      const purgeJobs: PurgeJobRecord[] = [];
      for (const replica of replicas) {
        const result = await repository.requestOwnerPrivateReplicaPurge({
          ownerPrivateReplicaId: replica.id,
          actorUserId: session.user.id,
          expectedVersion: replica.version,
          trigger: "user_erasure",
          idempotencyKey: `user-erasure:${session.user.id}:${replica.id}:v1`
        });
        if (!result) throw forbidden();
        purgeJobs.push(result.purgeJob);
      }
      const tombstone = await repository.completeUserErasureTombstone({
        userId: session.user.id
      });
      if (!tombstone) throw forbidden();
      return reply.status(202).send({ tombstone, purgeJobs });
    }
  );

  app.post(
    "/v1/retention/legal-holds",
    { preHandler: context.writeRateLimit },
    async (request, reply) => {
      const actor = await authenticateHighRiskActor(request, context);
      const input = placeLegalHoldSchema.parse(request.body);
      return reply.status(201).send(
        (
          await runHighRiskRetentionWrite(
            request,
            context,
            actor,
            {
              action: "team.legal_hold.place",
              teamId: teamIdForHoldBody(request.body),
              targetId: "teamId" in input.target ? input.target.teamId : null,
              body: request.body
            },
            async (repo) => {
              const hold = await repo.placeLegalHold({
                target: input.target,
                actorUserId:
                  actor.kind === "browser"
                    ? actor.user.id
                    : actor.device.user.id,
                authority: "team.legal_hold.manage",
                reasonCode: input.reasonCode,
                reasonHash: input.reasonHash,
                freshlyAuthenticatedAt:
                  actor.kind === "browser"
                    ? actor.session.createdAt
                    : new Date()
              });
              return { statusCode: 201, body: { hold } };
            }
          )
        ).body
      );
    }
  );

  app.post(
    "/v1/retention/legal-holds/:holdId/release-request",
    { preHandler: context.writeRateLimit },
    async (request) => {
      const actor = await authenticateHighRiskActor(request, context);
      const params = legalHoldParamsSchema.parse(request.params);
      const teamId = await context
        .requireHighRiskRepository()
        .lookupLegalHoldTeamId(params.holdId);
      return (
        await runHighRiskRetentionWrite(
          request,
          context,
          actor,
          {
            action: "team.legal_hold.release_request",
            teamId,
            targetId: params.holdId,
            body: request.body ?? {}
          },
          async (repo) => {
            const hold = await repo.requestLegalHoldRelease({
              holdId: params.holdId,
              actorUserId:
                actor.kind === "browser" ? actor.user.id : actor.device.user.id
            });
            return { statusCode: 200, body: { hold } };
          }
        )
      ).body;
    }
  );

  app.post(
    "/v1/retention/legal-holds/:holdId/release-confirmation",
    { preHandler: context.writeRateLimit },
    async (request) => {
      const actor = await authenticateHighRiskActor(request, context);
      const params = legalHoldParamsSchema.parse(request.params);
      const input = confirmLegalHoldReleaseSchema.parse(request.body ?? {});
      const teamId = await context
        .requireHighRiskRepository()
        .lookupLegalHoldTeamId(params.holdId);
      return (
        await runHighRiskRetentionWrite(
          request,
          context,
          actor,
          {
            action: "team.legal_hold.release_confirm",
            teamId,
            targetId: params.holdId,
            body: request.body ?? {}
          },
          async (repo) => {
            const hold = await repo.confirmLegalHoldRelease({
              holdId: params.holdId,
              actorUserId:
                actor.kind === "browser" ? actor.user.id : actor.device.user.id,
              singleHolderReleaseException: input.singleHolderReleaseException
            });
            return { statusCode: 200, body: { hold } };
          }
        )
      ).body;
    }
  );
};
