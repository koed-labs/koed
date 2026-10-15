import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type {
  ClaimedRecurringAgentTaskOccurrence,
  MemorySourceRepository
} from "@koed/db";
import {
  createRecurringAgentTaskSchema,
  personalAgentChatSubmitResponseSchema,
  recurringAgentOccurrencePageSchema,
  recurringAgentOccurrenceSchema,
  recurringAgentTaskListSchema,
  recurringAgentTaskSchema,
  recurringAgentTaskControlSchema,
  recurringAgentTaskExecutionSchema,
  recurringAgentTaskRunNowSchema,
  type PersonalAgentChatSubmit,
  updateRecurringAgentTaskSchema,
  type RecurringAgentTaskContext,
  type RecurringAgentTaskExecution
} from "@koed/shared";

import type { ApiRouteContext } from "../server/context.js";

type Actor = { userId: string };
type OwnerIdentity = Actor;
type RunnerIdentity = Actor & { deviceId: string; deploymentId: string };
type NativeSubmitResponse = z.infer<
  typeof personalAgentChatSubmitResponseSchema
>;
type RecurringOccurrence = z.infer<typeof recurringAgentOccurrenceSchema>;

type ProxyResult = { status: number; payload: Record<string, unknown> } | null;
type ProxyManaged = (
  method: "GET" | "POST" | "PUT" | "PATCH",
  path: string,
  body?: unknown,
  options?: { query?: URLSearchParams; expectedBackendId?: string }
) => Promise<ProxyResult>;

export interface RecurringAgentTaskRouteHooks {
  authenticateOwner(request: FastifyRequest): Promise<OwnerIdentity>;
  authenticateRunner(request: FastifyRequest): Promise<RunnerIdentity>;
  submitNativeMessage(
    request: FastifyRequest,
    ownerUserId: string,
    conversationId: string,
    input: PersonalAgentChatSubmit
  ): Promise<NativeSubmitResponse>;
  validateLaunch(
    request: FastifyRequest,
    ownerUserId: string,
    execution: RecurringAgentTaskExecution,
    taskContext: RecurringAgentTaskContext,
    expectedTargetDeploymentId?: string
  ): Promise<{
    targetDeploymentId: string;
    canonicalAiClientInstanceId: string;
  }>;
  proxyManaged: ProxyManaged;
}

type OccurrenceFence = {
  ownerUserId: string;
  occurrenceId: string;
  runnerId: string;
  leaseToken: string;
};

type RecurringAgentTaskClaim = ClaimedRecurringAgentTaskOccurrence;
const uuid = z.uuid();
const runnerBody = z
  .object({
    runnerId: z.string().trim().min(1).max(160),
    leaseMs: z.number().int().safe().min(5_000).max(300_000)
  })
  .strict();
const taskParams = z.object({ taskId: uuid }).strict();
const agentParams = z.object({ agentId: uuid }).strict();
const occurrenceListQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).optional(),
    before: uuid.optional()
  })
  .strict();
const taskListQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    before: uuid.optional()
  })
  .strict();

const errorCode = (error: unknown): string => {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code.slice(0, 120);
  }
  return error instanceof Error
    ? error.name.slice(0, 120)
    : "launch_unavailable";
};

const nativeResultUnlinked = (): Error & {
  statusCode: number;
  code: string;
} =>
  Object.assign(
    new Error("Native Personal Agent submission could not be linked yet"),
    {
      statusCode: 409,
      code: "recurring_task_native_result_unlinked"
    }
  );

/** Owner routes manage definitions; the runner route only submits one reserved native message. */
export const registerRecurringAgentTaskRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext,
  hooks: RecurringAgentTaskRouteHooks
): void => {
  const repository = () =>
    context.requireRepository() as MemorySourceRepository;
  const readLimit =
    context.rateLimit.managedConversationRead ?? context.rateLimit.memoryRead;
  const writeLimit =
    context.rateLimit.managedConversationWrite ?? context.rateLimit.memoryWrite;
  const forward = async (
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
    query?: URLSearchParams
  ) => hooks.proxyManaged(method, path, body, query ? { query } : {});

  app.get(
    "/v1/personal-agents/:agentId/recurring-tasks",
    { preHandler: readLimit },
    async (request) => {
      const { userId } = await hooks.authenticateOwner(request);
      const { agentId } = agentParams.parse(request.params);
      const query = taskListQuery.parse(request.query);
      const params = new URLSearchParams();
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      if (query.before) params.set("before", query.before);
      const path = `/v1/personal-agents/${encodeURIComponent(agentId)}/recurring-tasks`;
      const proxied = await forward("GET", path, undefined, params);
      if (proxied) return recurringAgentTaskListSchema.parse(proxied.payload);
      return recurringAgentTaskListSchema.parse(
        await repository().listRecurringAgentTasks(
          { userId },
          { agentId, ...query }
        )
      );
    }
  );

  app.post(
    "/v1/personal-agents/:agentId/recurring-tasks",
    { preHandler: writeLimit },
    async (request, reply) => {
      const { userId } = await hooks.authenticateOwner(request);
      const { agentId } = agentParams.parse(request.params);
      const input = createRecurringAgentTaskSchema.parse(request.body);
      const path = `/v1/personal-agents/${encodeURIComponent(agentId)}/recurring-tasks`;
      const proxied = await forward("POST", path, input);
      if (proxied)
        return reply
          .status(proxied.status)
          .send({ task: recurringAgentTaskSchema.parse(proxied.payload.task) });
      const validatedLaunch = await hooks.validateLaunch(
        request,
        userId,
        input.execution,
        input.context
      );
      return {
        task: recurringAgentTaskSchema.parse(
          await repository().createRecurringAgentTask(
            { userId },
            { agentId, input, validatedLaunch }
          )
        )
      };
    }
  );

  app.get(
    "/v1/recurring-agent-tasks/:taskId",
    { preHandler: readLimit },
    async (request) => {
      const { userId } = await hooks.authenticateOwner(request);
      const { taskId } = taskParams.parse(request.params);
      const path = `/v1/recurring-agent-tasks/${encodeURIComponent(taskId)}`;
      const proxied = await forward("GET", path);
      if (proxied)
        return { task: recurringAgentTaskSchema.parse(proxied.payload.task) };
      const task = await repository().getRecurringAgentTask({ userId }, taskId);
      if (!task)
        throw Object.assign(new Error("Recurring Agent task not found"), {
          statusCode: 404
        });
      return { task: recurringAgentTaskSchema.parse(task) };
    }
  );

  app.patch(
    "/v1/recurring-agent-tasks/:taskId",
    { preHandler: writeLimit },
    async (request, reply) => {
      const { userId } = await hooks.authenticateOwner(request);
      const { taskId } = taskParams.parse(request.params);
      const input = updateRecurringAgentTaskSchema.parse(request.body);
      const path = `/v1/recurring-agent-tasks/${encodeURIComponent(taskId)}`;
      const proxied = await forward("PATCH", path, input);
      if (proxied)
        return reply
          .status(proxied.status)
          .send({ task: recurringAgentTaskSchema.parse(proxied.payload.task) });
      const current = await repository().getRecurringAgentTask(
        { userId },
        taskId
      );
      if (!current)
        throw Object.assign(new Error("Recurring Agent task not found"), {
          statusCode: 404
        });
      const validatedLaunch = await hooks.validateLaunch(
        request,
        userId,
        input.execution,
        input.context
      );
      const task = await repository().updateRecurringAgentTask(
        { userId },
        { taskId, input, validatedLaunch }
      );
      if (!task)
        throw Object.assign(new Error("Recurring Agent task not found"), {
          statusCode: 404
        });
      return { task: recurringAgentTaskSchema.parse(task) };
    }
  );

  app.post(
    "/v1/recurring-agent-tasks/:taskId/control",
    { preHandler: writeLimit },
    async (request, reply) => {
      const { userId } = await hooks.authenticateOwner(request);
      const { taskId } = taskParams.parse(request.params);
      const input = recurringAgentTaskControlSchema.parse(request.body);
      const path = `/v1/recurring-agent-tasks/${encodeURIComponent(taskId)}/control`;
      const proxied = await forward("POST", path, input);
      if (proxied)
        return reply
          .status(proxied.status)
          .send({ task: recurringAgentTaskSchema.parse(proxied.payload.task) });
      const current = await repository().getRecurringAgentTask(
        { userId },
        taskId
      );
      if (!current)
        throw Object.assign(new Error("Recurring Agent task not found"), {
          statusCode: 404
        });
      const validatedLaunch =
        input.action === "resume"
          ? await hooks.validateLaunch(
              request,
              userId,
              current.execution,
              current.context
            )
          : undefined;
      const task = await repository().controlRecurringAgentTask(
        { userId },
        { taskId, input, ...(validatedLaunch ? { validatedLaunch } : {}) }
      );
      if (!task)
        throw Object.assign(new Error("Recurring Agent task not found"), {
          statusCode: 404
        });
      return { task: recurringAgentTaskSchema.parse(task) };
    }
  );

  app.post(
    "/v1/recurring-agent-tasks/:taskId/run-now",
    { preHandler: writeLimit },
    async (request, reply) => {
      const { userId } = await hooks.authenticateOwner(request);
      const { taskId } = taskParams.parse(request.params);
      const input = recurringAgentTaskRunNowSchema.parse(request.body);
      const path = `/v1/recurring-agent-tasks/${encodeURIComponent(taskId)}/run-now`;
      const proxied = await forward("POST", path, input);
      if (proxied)
        return reply.status(proxied.status).send({
          occurrence: recurringAgentOccurrenceSchema.parse(
            proxied.payload.occurrence
          )
        });
      const task = await repository().getRecurringAgentTask({ userId }, taskId);
      if (!task)
        throw Object.assign(new Error("Recurring Agent task not found"), {
          statusCode: 404
        });
      const validatedLaunch = await hooks.validateLaunch(
        request,
        userId,
        task.execution,
        task.context
      );
      const occurrence = await repository().reserveRecurringAgentTaskRunNow(
        { userId },
        { taskId, input, validatedLaunch }
      );
      return { occurrence: recurringAgentOccurrenceSchema.parse(occurrence) };
    }
  );

  app.get(
    "/v1/recurring-agent-tasks/:taskId/occurrences",
    { preHandler: readLimit },
    async (request) => {
      const { userId } = await hooks.authenticateOwner(request);
      const { taskId } = taskParams.parse(request.params);
      const query = occurrenceListQuery.parse(request.query);
      const params = new URLSearchParams();
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      if (query.before) params.set("before", query.before);
      const path = `/v1/recurring-agent-tasks/${encodeURIComponent(taskId)}/occurrences`;
      const proxied = await forward("GET", path, undefined, params);
      if (proxied)
        return recurringAgentOccurrencePageSchema.parse(proxied.payload);
      return recurringAgentOccurrencePageSchema.parse(
        await repository().listRecurringAgentTaskOccurrences(
          { userId },
          { taskId, ...query }
        )
      );
    }
  );

  app.post(
    "/v1/managed-conversation-runner/recurring-agent-tasks/claim",
    { preHandler: writeLimit },
    async (request) => {
      const identity = await hooks.authenticateRunner(request);
      const input = runnerBody.parse(request.body);
      const path =
        "/v1/managed-conversation-runner/recurring-agent-tasks/claim";
      const proxied = await forward("POST", path, input);
      if (proxied) return proxied.payload;

      const repo = repository();
      await reconcileOne(repo, identity);
      const claim = await repo.claimNextDueRecurringAgentTaskOccurrence({
        ownerUserId: identity.userId,
        targetDeviceId: identity.deviceId,
        targetDeploymentId: identity.deploymentId,
        runnerId: input.runnerId,
        leaseMs: input.leaseMs
      });
      if (!claim) return { occurrence: null };
      return submitClaim(request, hooks, repo, identity, claim, input.leaseMs);
    }
  );
};

const reconcileOne = async (
  repository: MemorySourceRepository,
  identity: RunnerIdentity
): Promise<void> => {
  const native =
    await repository.getNextRecurringAgentTaskOccurrenceForReconciliation({
      ownerUserId: identity.userId,
      targetDeviceId: identity.deviceId,
      targetDeploymentId: identity.deploymentId
    });
  if (!native) return;
  if (native.nativeDeliveryId && native.nativeMessageId) {
    const linked =
      await repository.linkRecurringAgentTaskOccurrenceNativeResult({
        ownerUserId: identity.userId,
        occurrenceId: native.occurrence.id,
        requestId: native.occurrence.id,
        deliveryId: native.nativeDeliveryId,
        messageId: native.nativeMessageId,
        executionId: native.nativeExecutionId,
        commandId: native.nativeCommandId
      });
    if (!linked) throw nativeResultUnlinked();
  } else if (
    native.occurrence.status === "reserved" &&
    native.nativeState !== "missing"
  ) {
    await repository.settleRecurringAgentTaskOccurrence({
      ownerUserId: identity.userId,
      occurrenceId: native.occurrence.id,
      outcome: "needs_review",
      errorCode: "native_delivery_incomplete"
    });
    return;
  }
  const status = native.nativeState;
  const outcome =
    status === "completed"
      ? "completed"
      : status === "canceled"
        ? "canceled"
        : status === "failed" ||
            status === "uncertain" ||
            status === "skipped" ||
            status === "missing"
          ? "needs_review"
          : null;
  if (!outcome) return;
  await repository.settleRecurringAgentTaskOccurrence({
    ownerUserId: identity.userId,
    occurrenceId: native.occurrence.id,
    ...(native.nativeDeliveryId ? { deliveryId: native.nativeDeliveryId } : {}),
    ...(native.nativeExecutionId
      ? { executionId: native.nativeExecutionId }
      : {}),
    outcome,
    ...(native.nativeErrorCode ? { errorCode: native.nativeErrorCode } : {})
  });
};

const withBoundedLeaseRenewal = async <T>(
  repository: MemorySourceRepository,
  fence: OccurrenceFence,
  leaseMs: number,
  operation: () => Promise<T>,
  request?: FastifyRequest
): Promise<T> => {
  const renewEveryMs = Math.max(1_000, Math.floor(leaseMs / 3));
  const renewalDeadline = Date.now() + Math.min(300_000, leaseMs * 2);
  let renewing = false;
  let active = true;
  const timer = setInterval(() => {
    if (!active || renewing) return;
    if (Date.now() >= renewalDeadline) {
      active = false;
      clearInterval(timer);
      return;
    }
    renewing = true;
    void repository
      .renewRecurringAgentTaskOccurrenceLease({ ...fence, leaseMs })
      .then((renewed) => {
        if (!renewed) {
          active = false;
          clearInterval(timer);
        }
      })
      .catch(() => {
        active = false;
        clearInterval(timer);
      })
      .finally(() => {
        renewing = false;
      });
  }, renewEveryMs);
  const stopRenewing = () => {
    active = false;
    clearInterval(timer);
  };
  request?.raw.once("aborted", stopRenewing);
  if (request?.raw.aborted) stopRenewing();
  timer.unref?.();
  try {
    return await operation();
  } finally {
    stopRenewing();
    request?.raw.removeListener("aborted", stopRenewing);
  }
};

const submitClaim = async (
  request: FastifyRequest,
  hooks: RecurringAgentTaskRouteHooks,
  repository: MemorySourceRepository,
  identity: RunnerIdentity,
  claim: RecurringAgentTaskClaim,
  leaseMs: number
): Promise<{ occurrence: RecurringOccurrence }> => {
  const fence: OccurrenceFence = {
    ownerUserId: identity.userId,
    occurrenceId: claim.occurrence.id,
    runnerId: claim.runnerId,
    leaseToken: claim.leaseToken
  };
  let execution: RecurringAgentTaskExecution;
  try {
    if (request.raw.aborted) {
      throw Object.assign(
        new Error("Recurring task claim request was aborted"),
        {
          statusCode: 499,
          code: "recurring_task_request_aborted"
        }
      );
    }
    if (
      claim.ownerUserId !== identity.userId ||
      claim.targetDeviceId !== identity.deviceId ||
      claim.targetDeploymentId !== identity.deploymentId ||
      claim.occurrence.conversationId !== claim.occurrence.id
    ) {
      throw Object.assign(new Error("Recurring task binding changed"), {
        statusCode: 409,
        code: "recurring_task_binding_mismatch"
      });
    }
    execution = recurringAgentTaskExecutionSchema.parse({
      provider: claim.launchSnapshot.provider,
      aiClientInstanceId: claim.launchSnapshot.aiClientInstanceId,
      targetDeviceId: claim.launchSnapshot.targetDeviceId,
      model: claim.launchSnapshot.model,
      reasoningEffort: claim.launchSnapshot.reasoningEffort,
      permissionMode: claim.launchSnapshot.permissionMode
    });
    const validatedLaunch = await withBoundedLeaseRenewal(
      repository,
      fence,
      leaseMs,
      () =>
        hooks.validateLaunch(
          request,
          identity.userId,
          execution,
          claim.context,
          identity.deploymentId
        ),
      request
    );
    if (
      validatedLaunch.targetDeploymentId !== claim.targetDeploymentId ||
      validatedLaunch.canonicalAiClientInstanceId !==
        claim.canonicalAiClientInstanceId
    ) {
      throw Object.assign(new Error("Recurring task launch binding changed"), {
        statusCode: 409,
        code: "recurring_task_binding_mismatch"
      });
    }
    if (request.raw.aborted) {
      throw Object.assign(
        new Error("Recurring task claim request was aborted"),
        {
          statusCode: 499,
          code: "recurring_task_request_aborted"
        }
      );
    }
    if (
      !(await repository.renewRecurringAgentTaskOccurrenceLease({
        ...fence,
        leaseMs
      }))
    ) {
      throw Object.assign(new Error("Recurring task reservation expired"), {
        statusCode: 409,
        code: "recurring_task_lease_lost"
      });
    }
    if (
      !(await repository.markRecurringAgentTaskOccurrenceSubmissionStarted(
        fence
      ))
    ) {
      throw Object.assign(new Error("Recurring task reservation expired"), {
        statusCode: 409,
        code: "recurring_task_lease_lost"
      });
    }
  } catch (error) {
    if (errorCode(error) !== "recurring_task_lease_lost") {
      await repository.settleRecurringAgentTaskOccurrence({
        ...fence,
        ownerUserId: identity.userId,
        occurrenceId: claim.occurrence.id,
        outcome: "needs_review",
        errorCode: errorCode(error)
      });
    }
    throw error;
  }

  const input: PersonalAgentChatSubmit = {
    requestId: claim.occurrence.id,
    text: claim.prompt,
    context: { ...claim.context, targetDeviceId: claim.targetDeviceId },
    recipients: [
      {
        kind: "agent",
        agentId: claim.agentId,
        agentVersion: claim.agentVersion,
        ...execution,
        selectedResourceIds: []
      }
    ]
  };
  try {
    if (request.raw.aborted) {
      throw Object.assign(
        new Error("Recurring task claim request was aborted"),
        {
          statusCode: 499,
          code: "recurring_task_request_aborted"
        }
      );
    }
    const result = personalAgentChatSubmitResponseSchema.parse(
      await withBoundedLeaseRenewal(
        repository,
        fence,
        leaseMs,
        () =>
          hooks.submitNativeMessage(
            request,
            identity.userId,
            claim.occurrence.conversationId,
            input
          ),
        request
      )
    );
    if (
      result.message.requestId !== input.requestId ||
      result.conversation.conversationId !== claim.occurrence.conversationId
    ) {
      throw Object.assign(
        new Error(
          "Native Personal Agent response did not match the occurrence"
        ),
        { code: "native_occurrence_identity_mismatch" }
      );
    }
    const delivery = result.deliveries.find(
      (candidate) =>
        candidate.recipientKind === "agent" &&
        candidate.agentId === claim.agentId
    );
    if (!delivery)
      throw Object.assign(
        new Error("Native Personal Agent delivery was not created"),
        { code: "native_delivery_missing" }
      );
    const occurrence =
      await repository.linkRecurringAgentTaskOccurrenceNativeResult({
        ownerUserId: identity.userId,
        occurrenceId: claim.occurrence.id,
        requestId: input.requestId,
        deliveryId: delivery.id,
        messageId: result.message.id,
        executionId: delivery.executionId,
        commandId: delivery.commandId
      });
    if (!occurrence) throw nativeResultUnlinked();
    return {
      occurrence: recurringAgentOccurrenceSchema.parse(occurrence)
    };
  } catch (error) {
    // A submit response can be lost after its transaction commits. Query the
    // stable native request before marking the occurrence for owner review.
    const native =
      await repository.getNextRecurringAgentTaskOccurrenceForReconciliation({
        ownerUserId: identity.userId,
        targetDeviceId: identity.deviceId,
        targetDeploymentId: identity.deploymentId
      });
    if (
      native?.occurrence.id === claim.occurrence.id &&
      native.nativeDeliveryId &&
      native.nativeMessageId
    ) {
      const occurrence =
        await repository.linkRecurringAgentTaskOccurrenceNativeResult({
          ownerUserId: identity.userId,
          occurrenceId: claim.occurrence.id,
          requestId: input.requestId,
          deliveryId: native.nativeDeliveryId,
          messageId: native.nativeMessageId,
          executionId: native.nativeExecutionId,
          commandId: native.nativeCommandId
        });
      if (!occurrence) throw nativeResultUnlinked();
      return {
        occurrence: recurringAgentOccurrenceSchema.parse(occurrence)
      };
    }
    if (errorCode(error) !== "recurring_task_native_result_unlinked") {
      await repository.settleRecurringAgentTaskOccurrence({
        ...fence,
        ownerUserId: identity.userId,
        occurrenceId: claim.occurrence.id,
        outcome: "needs_review",
        errorCode: errorCode(error)
      });
    }
    throw error;
  }
};
