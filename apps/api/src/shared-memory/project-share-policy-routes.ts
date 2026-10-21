import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  HighRiskActionRepository,
  ProjectSharePolicyRepository
} from "@koed/db";
import {
  ProjectSharePolicyConflictError,
  ProjectSharePolicyUnavailableError
} from "@koed/db";
import {
  prepareProjectShareManifestSchema,
  projectSharePolicyEnableSchema,
  projectSharePolicyRevokeSchema,
  projectSharePolicyInitialBundleSchema,
  projectSharePolicyFutureBundleSchema,
  projectSharePolicyExcludeSessionSchema,
  projectSharePolicyReceiptReadSchema,
  projectSharePolicyActionGrantBinding
} from "@koed/shared";
import { z } from "zod";
import type { ApiRouteContext } from "../server/context.js";

const params = z.object({ projectId: z.uuid() }).strict();
const forbidden = () =>
  Object.assign(new Error("Project share policy authority unavailable"), {
    statusCode: 403
  });
const handle = (error: unknown) => {
  if (error instanceof ProjectSharePolicyConflictError)
    return { statusCode: 409, message: error.message };
  if (error instanceof ProjectSharePolicyUnavailableError)
    return { statusCode: 403, message: error.message };
  throw error;
};
const grantHeader = (request: FastifyRequest) => {
  const raw = request.headers["x-koed-action-grant"];
  return (Array.isArray(raw) ? raw[0] : raw)?.trim() || null;
};

export const registerProjectSharePolicyRoutes = (
  app: FastifyInstance,
  input: {
    repository: ProjectSharePolicyRepository | null;
    requireHighRiskRepository(): Pick<
      HighRiskActionRepository,
      "executeActionGrant" | "reconcileActionGrantExecution"
    >;
    authenticateDeviceCredential: ApiRouteContext["auth"]["authenticateDeviceCredential"];
    writeRateLimit: ApiRouteContext["rateLimit"]["memoryWrite"];
  }
): void => {
  const repository = () => {
    if (!input.repository)
      throw Object.assign(new Error("Project sharing unavailable"), {
        statusCode: 503
      });
    return input.repository;
  };
  const actor = async (request: FastifyRequest) => {
    const authenticated = await input.authenticateDeviceCredential(request);
    if (
      !authenticated.credential.operationFamilies.includes(
        "share_grant_management"
      )
    )
      throw forbidden();
    return authenticated;
  };
  app.post(
    "/v1/workspace-projects/:projectId/share-policy/explicit-pending/read",
    { preHandler: input.writeRateLimit, bodyLimit: 8 * 1024 },
    async (request) => {
      const authenticated = await actor(request);
      const { projectId } = params.parse(request.params);
      const body = z
        .object({
          mutationId: z.uuid(),
          sessionId: z.uuid(),
          logicalMemoryId: z.uuid()
        })
        .strict()
        .parse(request.body);
      try {
        return await repository().explicitPendingStatus(
          {
            userId: authenticated.user.id,
            deviceCredentialId: authenticated.credential.id,
            upstreamBackendId: authenticated.credential.upstreamBackendId
          },
          { projectId, ...body }
        );
      } catch (error) {
        const safe = handle(error);
        throw Object.assign(new Error(safe.message), {
          statusCode: safe.statusCode
        });
      }
    }
  );
  app.post(
    "/v1/workspace-projects/:projectId/share-policy/explicit-pending/fence",
    { preHandler: input.writeRateLimit, bodyLimit: 8 * 1024 },
    async (request) => {
      const authenticated = await actor(request);
      const { projectId } = params.parse(request.params);
      const body = z
        .object({ mutationId: z.uuid(), sessionId: z.uuid() })
        .strict()
        .parse(request.body);
      try {
        return await repository().fenceExplicitOffer(
          {
            userId: authenticated.user.id,
            deviceCredentialId: authenticated.credential.id,
            upstreamBackendId: authenticated.credential.upstreamBackendId
          },
          { projectId, ...body }
        );
      } catch (error) {
        const safe = handle(error);
        throw Object.assign(new Error(safe.message), {
          statusCode: safe.statusCode
        });
      }
    }
  );
  app.get(
    "/v1/workspace-projects/:projectId/share-policy/status",
    async (request) => {
      const authenticated = await actor(request);
      const { projectId } = params.parse(request.params);
      return repository().getStatus(
        {
          userId: authenticated.user.id,
          deviceCredentialId: authenticated.credential.id,
          upstreamBackendId: authenticated.credential.upstreamBackendId
        },
        projectId
      );
    }
  );
  app.get(
    "/v1/workspace-projects/:projectId/share-policy/issues/:sessionId/status",
    async (request) => {
      const authenticated = await actor(request);
      const { projectId, sessionId } = z
        .object({ projectId: z.uuid(), sessionId: z.uuid() })
        .strict()
        .parse(request.params);
      const { policyVersion } = z
        .object({ policyVersion: z.coerce.number().int().positive() })
        .strict()
        .parse(request.query);
      return repository().getIssueStatus(
        {
          userId: authenticated.user.id,
          deviceCredentialId: authenticated.credential.id,
          upstreamBackendId: authenticated.credential.upstreamBackendId
        },
        { projectId, sessionId, policyVersion }
      );
    }
  );
  app.get(
    "/v1/workspace-projects/:projectId/share-policy/manifests/:manifestId/review",
    async (request, reply) => {
      const authenticated = await actor(request);
      const { projectId, manifestId } = z
        .object({ projectId: z.uuid(), manifestId: z.uuid() })
        .strict()
        .parse(request.params);
      const query = z
        .object({
          manifestHash: z.string().regex(/^[0-9a-f]{64}$/),
          expectedPolicyVersion: z.coerce.number().int().nonnegative()
        })
        .strict()
        .parse(request.query);
      try {
        const review = await repository().getReview(
          {
            userId: authenticated.user.id,
            deviceCredentialId: authenticated.credential.id,
            upstreamBackendId: authenticated.credential.upstreamBackendId
          },
          {
            projectId,
            manifestId,
            manifestHash: query.manifestHash,
            expectedPolicyVersion: query.expectedPolicyVersion
          }
        );
        if (!review) throw forbidden();
        return reply.send(review);
      } catch (error) {
        const safe = handle(error);
        return reply.code(safe.statusCode).send(safe);
      }
    }
  );
  app.post(
    "/v1/workspace-projects/:projectId/share-policy/initial-bundles",
    { preHandler: input.writeRateLimit, bodyLimit: 64 * 1024 },
    async (request, reply) => {
      const authenticated = await actor(request);
      const { projectId } = params.parse(request.params);
      const body = projectSharePolicyInitialBundleSchema.parse(request.body);
      try {
        const outcome = await repository().stageInitialBundle(
          {
            userId: authenticated.user.id,
            deviceCredentialId: authenticated.credential.id,
            upstreamBackendId: authenticated.credential.upstreamBackendId
          },
          { projectId, ...body }
        );
        return reply.code(outcome.state === "staged" ? 202 : 200).send(outcome);
      } catch (error) {
        const safe = handle(error);
        return reply.code(safe.statusCode).send(safe);
      }
    }
  );
  app.post(
    "/v1/workspace-projects/:projectId/share-policy/future-bundles",
    { preHandler: input.writeRateLimit, bodyLimit: 64 * 1024 },
    async (request, reply) => {
      const authenticated = await actor(request);
      const { projectId } = params.parse(request.params);
      const body = projectSharePolicyFutureBundleSchema.parse(request.body);
      try {
        const outcome = await repository().stageInitialBundle(
          {
            userId: authenticated.user.id,
            deviceCredentialId: authenticated.credential.id,
            upstreamBackendId: authenticated.credential.upstreamBackendId
          },
          { projectId, ...body }
        );
        return reply.code(outcome.state === "staged" ? 202 : 200).send(outcome);
      } catch (error) {
        const safe = handle(error);
        return reply.code(safe.statusCode).send(safe);
      }
    }
  );
  app.post(
    "/v1/workspace-projects/:projectId/share-policy/exclusions",
    { preHandler: input.writeRateLimit, bodyLimit: 8 * 1024 },
    async (request, reply) => {
      const authenticated = await actor(request);
      const { projectId } = params.parse(request.params);
      const body = projectSharePolicyExcludeSessionSchema.parse(request.body);
      try {
        const outcome = await repository().excludeSession(
          {
            userId: authenticated.user.id,
            deviceCredentialId: authenticated.credential.id,
            upstreamBackendId: authenticated.credential.upstreamBackendId
          },
          { projectId, ...body }
        );
        return reply.code(outcome.withdrawalRequired ? 202 : 200).send(outcome);
      } catch (error) {
        const safe = handle(error);
        return reply.code(safe.statusCode).send(safe);
      }
    }
  );
  app.post(
    "/v1/workspace-projects/:projectId/share-policy/execution-receipts/read",
    { preHandler: input.writeRateLimit, bodyLimit: 8 * 1024 },
    async (request) => {
      const authenticated = await actor(request);
      const { projectId } = params.parse(request.params);
      const body = projectSharePolicyReceiptReadSchema.parse(request.body);
      const binding = projectSharePolicyActionGrantBinding({
        action:
          body.action === "enable"
            ? "shared_memory.project_share_policy.enable"
            : "shared_memory.project_share_policy.revoke",
        teamId: body.teamId,
        projectId,
        referenceId: body.actionGrantId,
        expectedPolicyVersion: body.expectedPolicyVersion,
        ...(body.action === "enable"
          ? { manifestId: body.manifestId!, manifestHash: body.manifestHash! }
          : {})
      });
      const exact = await input
        .requireHighRiskRepository()
        .reconcileActionGrantExecution<unknown>({
          clientRequestId: body.actionGrantId,
          actionGrantId: body.actionGrantId,
          ownerUserId: authenticated.user.id,
          deviceCredentialId: authenticated.credential.id,
          upstreamBackendId: authenticated.credential.upstreamBackendId,
          teamId: body.teamId,
          operationFamily: binding.operationFamily,
          action: binding.action,
          targetId: binding.targetId,
          scopeHash: binding.scopeHash,
          requestHash: binding.requestHash
        });
      const grant = exact.grant;
      const terminalState = exact.receipt
        ? null
        : grant?.state === "denied" || grant?.state === "revoked"
          ? grant.state
          : grant?.state === "expired" ||
              (grant?.state === "approved" &&
                Date.parse(grant.expiresAt) <= exact.serverTime.getTime())
            ? "expired"
            : null;
      return {
        executed: Boolean(exact.receipt),
        receipt: exact.receipt,
        terminalState,
        serverTime: exact.serverTime.toISOString()
      };
    }
  );
  app.post(
    "/v1/workspace-projects/:projectId/share-policy/manifests",
    { preHandler: input.writeRateLimit, bodyLimit: 64 * 1024 },
    async (request, reply) => {
      const authenticated = await actor(request);
      const { projectId } = params.parse(request.params);
      const body = prepareProjectShareManifestSchema.parse(request.body);
      try {
        const receipt = await repository().prepareInitialManifest(
          {
            userId: authenticated.user.id,
            deviceCredentialId: authenticated.credential.id,
            upstreamBackendId: authenticated.credential.upstreamBackendId
          },
          { projectId, ...body }
        );
        return reply.code(201).send(receipt);
      } catch (error) {
        const safe = handle(error);
        return reply.code(safe.statusCode).send(safe);
      }
    }
  );
  app.post(
    "/v1/workspace-projects/:projectId/share-policy/enable",
    { preHandler: input.writeRateLimit, bodyLimit: 64 * 1024 },
    async (request, reply) => {
      const authenticated = await actor(request);
      const { projectId } = params.parse(request.params);
      const body = projectSharePolicyEnableSchema.parse(request.body);
      const grant = grantHeader(request);
      if (!grant) throw forbidden();
      const review = await repository().getReview(
        {
          userId: authenticated.user.id,
          deviceCredentialId: authenticated.credential.id,
          upstreamBackendId: authenticated.credential.upstreamBackendId
        },
        {
          projectId,
          expectedPolicyVersion: body.expectedPolicyVersion,
          manifestId: body.manifestId,
          manifestHash: body.manifestHash
        }
      );
      if (!review || review.status === "active") throw forbidden();
      const binding = projectSharePolicyActionGrantBinding({
        action: "shared_memory.project_share_policy.enable",
        teamId: review.teamId,
        projectId,
        referenceId: body.authority.referenceId,
        expectedPolicyVersion: body.expectedPolicyVersion,
        manifestId: body.manifestId,
        manifestHash: body.manifestHash
      });
      // The approved request includes the fixed manifest reference. The
      // currentEntries field is trusted local-edge evidence and must match that
      // immutable manifest inside the same consumption transaction.
      try {
        const result = await input
          .requireHighRiskRepository()
          .executeActionGrant({
            actionGrant: grant,
            ownerUserId: authenticated.user.id,
            deviceCredentialId: authenticated.credential.id,
            upstreamBackendId: authenticated.credential.upstreamBackendId,
            teamId: review.teamId,
            operationFamily: binding.operationFamily,
            action: binding.action,
            targetId: binding.targetId,
            scopeHash: binding.scopeHash,
            requestHash: binding.requestHash,
            execute: async ({ projectSharePolicy }) => ({
              statusCode: 200,
              body: await projectSharePolicy.enable(
                {
                  userId: authenticated.user.id,
                  deviceCredentialId: authenticated.credential.id,
                  upstreamBackendId: authenticated.credential.upstreamBackendId
                },
                {
                  projectId,
                  expectedPolicyVersion: body.expectedPolicyVersion,
                  manifestId: body.manifestId,
                  manifestHash: body.manifestHash,
                  signingPublicKey: body.signingPublicKey,
                  currentEntries: body.currentEntries
                }
              )
            })
          });
        if (!result) throw forbidden();
        return reply.code(result.statusCode).send(result.body);
      } catch (error) {
        const safe = handle(error);
        return reply.code(safe.statusCode).send(safe);
      }
    }
  );
  app.post(
    "/v1/workspace-projects/:projectId/share-policy/revoke",
    { preHandler: input.writeRateLimit },
    async (request, reply) => {
      const authenticated = await actor(request);
      const { projectId } = params.parse(request.params);
      const body = projectSharePolicyRevokeSchema.parse(request.body);
      const grant = grantHeader(request);
      if (!grant) throw forbidden();
      const review = await repository().getReview(
        {
          userId: authenticated.user.id,
          deviceCredentialId: authenticated.credential.id,
          upstreamBackendId: authenticated.credential.upstreamBackendId
        },
        { projectId, expectedPolicyVersion: body.expectedPolicyVersion }
      );
      if (!review || review.status !== "active") throw forbidden();
      const binding = projectSharePolicyActionGrantBinding({
        action: "shared_memory.project_share_policy.revoke",
        teamId: review.teamId,
        projectId,
        referenceId: body.authority.referenceId,
        expectedPolicyVersion: body.expectedPolicyVersion
      });
      try {
        const result = await input
          .requireHighRiskRepository()
          .executeActionGrant({
            actionGrant: grant,
            ownerUserId: authenticated.user.id,
            deviceCredentialId: authenticated.credential.id,
            upstreamBackendId: authenticated.credential.upstreamBackendId,
            teamId: review.teamId,
            operationFamily: binding.operationFamily,
            action: binding.action,
            targetId: binding.targetId,
            scopeHash: binding.scopeHash,
            requestHash: binding.requestHash,
            execute: async ({ projectSharePolicy }) => ({
              statusCode: 200,
              body: await projectSharePolicy.revoke(
                {
                  userId: authenticated.user.id,
                  deviceCredentialId: authenticated.credential.id,
                  upstreamBackendId: authenticated.credential.upstreamBackendId
                },
                { projectId, expectedPolicyVersion: body.expectedPolicyVersion }
              )
            })
          });
        if (!result) throw forbidden();
        return reply.code(result.statusCode).send(result.body);
      } catch (error) {
        const safe = handle(error);
        return reply.code(safe.statusCode).send(safe);
      }
    }
  );
};
