import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  readLocalEdgeUpstreamRegistry,
  upstreamBackendById,
  createScheduledJobSchema,
  editScheduledJobSchema,
  scheduledJobVersionSchema,
  scheduledJobReassignSchema,
  scheduledJobRunNowSchema,
  scheduledJobRuntimeTickRequestSchema,
  scheduledJobRuntimeTickResultSchema,
  scheduledJobRuntimeAuthoritySchema,
  scheduledJobRuntimeLeaseRequestSchema,
  scheduledJobRuntimeLeaseResultSchema
} from "@koed/shared";
import {
  ScheduledJobNotFound,
  ScheduledJobConflict,
  ScheduledJobAuthorityUnavailable,
  type AgentsRepository,
  type ScheduledJobTeamAuthority,
  type ScheduledJobRepository
} from "@koed/db";
import type { ApiRouteContext } from "../server/context.js";
import { authenticateHqManagedWrite } from "../managed-conversations/hq-auth.js";
import { authenticateProjectRead } from "../projects/desktop-read-auth.js";
import { tickScheduledJobs } from "./runtime-tick.js";

const idParams = z.object({ id: z.uuid() }).strict();
const runParams = z.object({ id: z.uuid(), runId: z.uuid() }).strict();
const runtimeCommandParams = z.object({ commandId: z.uuid() }).strict();
const runtimeExecutionParams = z.object({ executionId: z.uuid() }).strict();
const listQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(1024).optional()
  })
  .strict();
const attemptQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    afterAttempt: z.coerce.number().int().nonnegative().optional()
  })
  .strict();
const localProfiles = new Set(["developer", "local_personal"]);

export function registerScheduledJobRoutes(
  app: FastifyInstance,
  context: ApiRouteContext,
  repository: ScheduledJobRepository | null,
  agents: AgentsRepository | null,
  teamAuthority: ScheduledJobTeamAuthority | null
) {
  const repo = () => {
    if (!localProfiles.has(context.config.deploymentProfile))
      throw Object.assign(
        new Error("Scheduled Jobs require a Personal deployment"),
        { statusCode: 403 }
      );
    if (!repository)
      throw Object.assign(new Error("Scheduled Jobs are unavailable"), {
        statusCode: 503
      });
    return repository;
  };
  const read = (request: FastifyRequest) =>
    authenticateProjectRead(request, {
      deploymentProfile: context.config.deploymentProfile,
      koedHome: context.config.koedHome,
      auth: context.auth
    });
  const write = (request: FastifyRequest) =>
    authenticateHqManagedWrite(request, context);
  const creatingDevice = async (request: FastifyRequest) => {
    const owner = await write(request);
    const authorization = request.headers.authorization?.trim() ?? "";
    let deviceId: string | undefined;
    if (/^Koed-Device\s/i.test(authorization)) {
      const credential = await context.auth.authenticateDeviceCredential(
        request,
        { fresh: true }
      );
      if (
        credential.user.id !== owner.id ||
        !credential.credential.operationFamilies.includes(
          "managed_execution"
        ) ||
        !credential.credential.operationFamilies.includes(
          "personal_collaboration_write"
        ) ||
        !z.uuid().safeParse(credential.credential.metadata.protocolDeploymentId)
          .success
      )
        throw Object.assign(new Error("Device lacks Scheduled Job authority"), {
          statusCode: 403
        });
      deviceId = credential.credential.deviceInstanceId;
    } else if (
      /^Koed-Desktop\s/i.test(authorization) &&
      localProfiles.has(context.config.deploymentProfile)
    ) {
      const identity = context.deploymentIdentity.inspect();
      if (identity.health !== "healthy" || !identity.deploymentId)
        throw Object.assign(
          new Error("Verified local device identity is required"),
          { statusCode: 503 }
        );
      deviceId = identity.deviceInstanceId ?? undefined;
    }
    if (!deviceId || !z.uuid().safeParse(deviceId).success)
      throw Object.assign(new Error("A verified device identity is required"), {
        statusCode: 403
      });
    return { ownerUserId: owner.id, deviceId };
  };
  const handle = (error: unknown) => {
    if (error instanceof ScheduledJobNotFound)
      throw Object.assign(error, { statusCode: 404 });
    if (error instanceof ScheduledJobConflict)
      throw Object.assign(error, { statusCode: 409 });
    if (error instanceof ScheduledJobAuthorityUnavailable)
      throw Object.assign(error, { statusCode: 503 });
    throw error;
  };
  app.post(
    "/v1/scheduled-jobs/runtime/tick",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      if (!request.headers.authorization?.trim().startsWith("Koed-Desktop "))
        throw Object.assign(new Error("Local AI Runtime credential required"), {
          statusCode: 403
        });
      scheduledJobRuntimeTickRequestSchema.parse(request.body ?? {});
      const { ownerUserId, deviceId } = await creatingDevice(request);
      // The scheduler transaction and dispatch binding use the local command
      // store. A remote-authority worker would never claim that local command.
      const registry = readLocalEdgeUpstreamRegistry(
        context.localEdge.upstreamBackendsPath
      );
      const selected = registry.activeBackendId
        ? upstreamBackendById(registry, registry.activeBackendId)
        : null;
      if (selected?.routePolicy.managedExecution === "enabled")
        throw Object.assign(
          new Error(
            "Scheduled Jobs are unavailable while remote Managed Conversations are active"
          ),
          { statusCode: 503 }
        );
      const identity = context.deploymentIdentity.inspect();
      if (
        identity.health !== "healthy" ||
        identity.deviceInstanceId !== deviceId ||
        !identity.deploymentId ||
        !agents ||
        !teamAuthority
      )
        throw Object.assign(new Error("Scheduled Job runtime is unavailable"), {
          statusCode: 503
        });
      return scheduledJobRuntimeTickResultSchema.parse(
        await tickScheduledJobs(
          {
            jobs: repo(),
            managed: context.requireRepository(),
            agents,
            teamAuthority
          },
          { ownerUserId, deviceId, deploymentId: identity.deploymentId }
        )
      );
    }
  );
  const runtimeAuthority = async (request: FastifyRequest) => {
    if (!request.headers.authorization?.trim().startsWith("Koed-Desktop "))
      throw Object.assign(new Error("Local AI Runtime credential required"), {
        statusCode: 403
      });
    const caller = await creatingDevice(request);
    const identity = context.deploymentIdentity.inspect();
    if (
      identity.health !== "healthy" ||
      identity.deviceInstanceId !== caller.deviceId
    )
      throw Object.assign(new Error("Verified runtime device changed"), {
        statusCode: 409
      });
    return caller;
  };
  app.get(
    "/v1/scheduled-jobs/runtime/commands/:commandId/authority",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      const caller = await runtimeAuthority(request);
      const { commandId } = runtimeCommandParams.parse(request.params);
      try {
        const current = await repo().assertManagedCommandAuthority(
          caller.ownerUserId,
          commandId,
          caller.deviceId,
          [
            "queued",
            "dispatching",
            "completed",
            "failed",
            "indeterminate",
            "canceled"
          ]
        );
        return scheduledJobRuntimeAuthoritySchema.parse({
          allowed: true,
          scheduled: current.scheduled
        });
      } catch (error) {
        return handle(error);
      }
    }
  );
  app.get(
    "/v1/scheduled-jobs/runtime/executions/:executionId/authority",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      const caller = await runtimeAuthority(request);
      const { executionId } = runtimeExecutionParams.parse(request.params);
      const commandId = await repo().getActiveScheduledCommandForExecution(
        caller.ownerUserId,
        executionId
      );
      if (!commandId)
        return scheduledJobRuntimeAuthoritySchema.parse({
          allowed: true,
          scheduled: false
        });
      try {
        await repo().assertManagedCommandAuthority(
          caller.ownerUserId,
          commandId,
          caller.deviceId,
          [
            "queued",
            "dispatching",
            "completed",
            "failed",
            "indeterminate",
            "canceled"
          ]
        );
        return scheduledJobRuntimeAuthoritySchema.parse({
          allowed: true,
          scheduled: true
        });
      } catch (error) {
        return handle(error);
      }
    }
  );
  app.post(
    "/v1/scheduled-jobs/runtime/commands/:commandId/lease",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const caller = await runtimeAuthority(request);
      const { commandId } = runtimeCommandParams.parse(request.params);
      const input = scheduledJobRuntimeLeaseRequestSchema.parse(request.body);
      try {
        const recorded = await repo().appendManagedCommandLease(
          caller.ownerUserId,
          commandId,
          caller.deviceId,
          input.leaseToken,
          input.runnerId
        );
        if (!recorded)
          throw new ScheduledJobConflict(
            "Scheduled command binding is unavailable"
          );
        return scheduledJobRuntimeLeaseResultSchema.parse({ recorded });
      } catch (error) {
        return handle(error);
      }
    }
  );
  app.get(
    "/v1/scheduled-jobs",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      const owner = await read(request);
      return await repo().list(owner.id, listQuery.parse(request.query));
    }
  );
  app.post(
    "/v1/scheduled-jobs",
    { preHandler: context.rateLimit.memoryWrite },
    async (request, reply) => {
      const { ownerUserId, deviceId } = await creatingDevice(request);
      const body = createScheduledJobSchema.parse(request.body);
      try {
        return reply
          .code(201)
          .send(await repo().create(ownerUserId, deviceId, body));
      } catch (error) {
        return handle(error);
      }
    }
  );
  app.get(
    "/v1/scheduled-jobs/:id",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      const owner = await read(request);
      const { id } = idParams.parse(request.params);
      try {
        return await repo().get(owner.id, id);
      } catch (error) {
        return handle(error);
      }
    }
  );
  app.patch(
    "/v1/scheduled-jobs/:id",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const owner = await write(request);
      const { id } = idParams.parse(request.params);
      const body = editScheduledJobSchema.parse(request.body);
      try {
        return await repo().edit(owner.id, id, body);
      } catch (error) {
        return handle(error);
      }
    }
  );
  app.post(
    "/v1/scheduled-jobs/:id/pause",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const owner = await write(request);
      const { id } = idParams.parse(request.params);
      const body = scheduledJobVersionSchema
        .extend({ paused: z.boolean() })
        .strict()
        .parse(request.body);
      try {
        return await repo().setPaused(
          owner.id,
          id,
          body.expectedVersion,
          body.paused
        );
      } catch (error) {
        return handle(error);
      }
    }
  );
  app.post(
    "/v1/scheduled-jobs/:id/reassign",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const owner = await write(request);
      const { id } = idParams.parse(request.params);
      const body = scheduledJobReassignSchema.parse(request.body);
      try {
        return await repo().reassign(
          owner.id,
          id,
          body.expectedVersion,
          body.targetDeviceId
        );
      } catch (error) {
        return handle(error);
      }
    }
  );
  app.get(
    "/v1/scheduled-jobs/:id/runs",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      const owner = await read(request);
      const { id } = idParams.parse(request.params);
      try {
        return await repo().listRuns(
          owner.id,
          id,
          listQuery.parse(request.query)
        );
      } catch (error) {
        return handle(error);
      }
    }
  );
  app.post(
    "/v1/scheduled-jobs/:id/run-now",
    { preHandler: context.rateLimit.memoryWrite },
    async (request, reply) => {
      const owner = await write(request);
      const { id } = idParams.parse(request.params);
      const body = scheduledJobRunNowSchema.parse(request.body);
      try {
        return reply
          .code(202)
          .send(
            await repo().runNow(
              owner.id,
              id,
              body.expectedVersion,
              body.requestId
            )
          );
      } catch (error) {
        return handle(error);
      }
    }
  );
  app.post(
    "/v1/scheduled-jobs/:id/runs/:runId/retry",
    { preHandler: context.rateLimit.memoryWrite },
    async (request, reply) => {
      const owner = await write(request);
      const { id, runId } = runParams.parse(request.params);
      const body = scheduledJobVersionSchema.parse(request.body);
      try {
        return reply
          .code(202)
          .send(await repo().retry(owner.id, id, runId, body.expectedVersion));
      } catch (error) {
        return handle(error);
      }
    }
  );
  app.post(
    "/v1/scheduled-jobs/:id/runs/:runId/skip",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const owner = await write(request);
      const { id, runId } = runParams.parse(request.params);
      const body = scheduledJobVersionSchema.parse(request.body);
      try {
        return await repo().skip(owner.id, id, runId, body.expectedVersion);
      } catch (error) {
        return handle(error);
      }
    }
  );
  app.get(
    "/v1/scheduled-jobs/:id/runs/:runId/attempts",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      const owner = await read(request);
      const { id, runId } = runParams.parse(request.params);
      try {
        return await repo().attemptHistory(
          owner.id,
          id,
          runId,
          attemptQuery.parse(request.query)
        );
      } catch (error) {
        return handle(error);
      }
    }
  );
}
