import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AgentsRepository, MemorySourceRepository } from "@koed/db";
import { z } from "zod";
import { isSupportedAiClientDriverId } from "@koed/shared";
import {
  agentDelegationBodySchema,
  agentDelegationColdBodySchema,
  agentDelegationListQuerySchema,
  agentDelegationParamsSchema,
  agentDelegationProjectParamsSchema,
  agentDelegationResponseSchema,
  agentDelegationsResponseSchema
} from "@koed/shared/agent-delegation-contract";
import type { ApiRouteContext } from "../server/context.js";
import type { RateLimitHandler } from "../infra/rate-limit.js";
import { authenticateHqManagedWrite } from "./hq-auth.js";

type Instance = {
  instanceId: string;
  driverId: string;
  ready: boolean;
  models: Array<Record<string, unknown>>;
};
type Selection = {
  projectId: string;
  contextKind: "project";
  provider: "codex" | "claude" | "pi";
  aiClientInstanceId: string;
  model: string;
  reasoningEffort: null;
  permissionMode: "supervised" | "auto_edit" | "auto" | "full_access";
  runnerKind: "local_device";
  idempotencyKey: string;
};
const statusError = (message: string, statusCode: number) =>
  Object.assign(new Error(message), { statusCode });
const modelId = (model: Record<string, unknown>): string | null =>
  typeof model.id === "string"
    ? model.id
    : typeof model.fullId === "string"
      ? model.fullId
      : typeof model.model === "string"
        ? model.model
        : null;

/** A private child launch, using the same managed execution machinery as a Work Item. */
export function registerAgentDelegationRoutes(
  app: FastifyInstance,
  deps: {
    context: ApiRouteContext;
    agents: AgentsRepository | null;
    writeRateLimit: RateLimitHandler;
    readRateLimit: RateLimitHandler;
    runnerIdentity: (
      request: FastifyRequest
    ) => Promise<{ deploymentId: string; deviceId: string }>;
    launchInstances: (
      repository: MemorySourceRepository,
      userId: string
    ) => Promise<Instance[]>;
    assertSelection: (
      repository: MemorySourceRepository,
      userId: string,
      input: Selection
    ) => Promise<void>;
    localProjectExecutionPath: (projectId: string) => Promise<string | null>;
  }
) {
  app.get(
    "/v1/managed-conversations/agent-delegations",
    { preHandler: deps.readRateLimit },
    async (request) => {
      if (
        !["developer", "local_personal"].includes(
          deps.context.config.deploymentProfile
        )
      )
        throw statusError("Agent delegation requires a local profile", 403);
      const owner = await authenticateHqManagedWrite(request, deps.context);
      const { projectId } = agentDelegationListQuerySchema.parse(request.query);
      const repository = deps.context.requireRepository();
      return agentDelegationsResponseSchema.parse({
        items: await repository.listManagedAgentDelegations(
          { userId: owner.id },
          projectId
        )
      });
    }
  );

  const delegate = async (
    request: FastifyRequest,
    reply: import("fastify").FastifyReply,
    coldProjectId: string | null
  ) => {
    if (
      !["developer", "local_personal"].includes(
        deps.context.config.deploymentProfile
      )
    )
      throw statusError("Agent delegation requires a local profile", 403);
    if (!deps.agents) throw statusError("Agents are unavailable", 503);
    const owner = await authenticateHqManagedWrite(request, deps.context);
    const executionId = coldProjectId
      ? null
      : agentDelegationParamsSchema.parse(request.params).executionId;
    const activeBody = coldProjectId
      ? null
      : agentDelegationBodySchema.parse(request.body);
    const body =
      activeBody ?? agentDelegationColdBodySchema.parse(request.body);
    const executionGeneration = activeBody?.executionGeneration ?? null;
    const repository = deps.context.requireRepository();
    const runner = await deps.runnerIdentity(request);
    const parent = executionId
      ? await repository.getManagedConversationExecution(
          { userId: owner.id },
          executionId
        )
      : null;
    if (
      executionId &&
      (!parent ||
        !z.uuid().safeParse(parent.projectId).success ||
        parent.runnerDeploymentId !== runner.deploymentId ||
        parent.runnerDeviceId !== runner.deviceId)
    )
      throw statusError("Parent Conversation is unavailable", 404);
    const projectId = parent?.projectId ?? coldProjectId;
    if (!projectId) throw statusError("Project HQ is unavailable", 404);
    const previous = await repository.getManagedAgentDelegationByRequest(
      { userId: owner.id },
      body.requestId
    );
    if (
      previous &&
      (previous.parentExecutionId !== executionId ||
        previous.parentExecutionGeneration !== executionGeneration ||
        previous.agentId !== body.agentId ||
        previous.projectId !== projectId)
    )
      throw statusError("Agent delegation request changed", 409);
    if (
      !previous &&
      parent &&
      (parent.executionGeneration !== executionGeneration ||
        !["running", "quiesced"].includes(parent.state))
    )
      throw statusError("Parent Conversation generation changed", 409);
    let selection: Selection;
    if (previous) {
      const child = await repository.getManagedConversationExecution(
        { userId: owner.id },
        previous.childExecutionId
      );
      if (
        !child ||
        child.projectId !== projectId ||
        child.runnerDeploymentId !== runner.deploymentId ||
        child.runnerDeviceId !== runner.deviceId ||
        !isSupportedAiClientDriverId(child.provider)
      )
        throw statusError("Agent delegation needs reconciliation", 409);
      selection = {
        projectId: child.projectId,
        contextKind: "project",
        provider: child.provider,
        aiClientInstanceId: child.aiClientInstanceId,
        model: child.model,
        reasoningEffort: null,
        permissionMode: child.permissionMode,
        runnerKind: "local_device",
        idempotencyKey: body.requestId
      };
    } else {
      const agent = (await deps.agents.list(owner.id)).find(
        (item) => item.id === body.agentId
      );
      if (!agent || agent.isChiefOfStaff)
        throw statusError("Helper Agent is unavailable", 404);
      const instances = await deps.launchInstances(repository, owner.id);
      const instance = instances.find(
        (item) => item.instanceId === agent.aiClientInstanceId
      );
      if (
        !instance ||
        !instance.ready ||
        !isSupportedAiClientDriverId(instance.driverId)
      )
        throw statusError("Helper Agent AI Client is unavailable", 409);
      const chosen = agent.defaultModel
        ? instance.models.find((model) => modelId(model) === agent.defaultModel)
        : instance.models[0];
      const selectedModel = chosen ? modelId(chosen) : null;
      if (!selectedModel)
        throw statusError("Helper Agent model is unavailable", 409);
      selection = {
        projectId,
        contextKind: "project",
        provider: instance.driverId,
        aiClientInstanceId: agent.aiClientInstanceId,
        model: selectedModel,
        reasoningEffort: null,
        permissionMode: agent.defaultPermissionMode,
        runnerKind: "local_device",
        idempotencyKey: body.requestId
      };
      await deps.assertSelection(repository, owner.id, selection);
    }
    const projectPath = previous
      ? null
      : await deps.localProjectExecutionPath(projectId);
    if (!previous && !projectPath)
      throw statusError("Project has no verified local execution path", 409);
    const created = await repository.createManagedConversation(
      { userId: owner.id },
      {
        ...selection,
        runnerDeploymentId: runner.deploymentId,
        runnerDeviceId: runner.deviceId,
        initialPrompt: body.prompt,
        deferUntilRuntimeBinding: true,
        agentDelegation: {
          parentExecutionId: executionId,
          parentExecutionGeneration: executionGeneration,
          agentId: body.agentId,
          requestId: body.requestId
        }
      }
    );
    const binding = await repository.getManagedConversationRuntimeBinding(
      { userId: owner.id },
      created.execution.id
    );
    if (
      binding &&
      (binding.deploymentId !== runner.deploymentId ||
        binding.deviceId !== runner.deviceId ||
        binding.executionGeneration !== created.execution.executionGeneration)
    )
      throw statusError("Agent delegation runtime binding changed", 409);
    if (!binding) {
      const verifiedPath =
        projectPath ?? (await deps.localProjectExecutionPath(projectId));
      if (!verifiedPath)
        throw statusError("Project has no verified local execution path", 409);
      await repository.upsertManagedConversationRuntimeBinding(
        { userId: owner.id },
        {
          executionId: created.execution.id,
          deploymentId: runner.deploymentId,
          deviceId: runner.deviceId,
          executionGeneration: created.execution.executionGeneration,
          projectPath: verifiedPath
        }
      );
    }
    return reply.status(202).send(
      agentDelegationResponseSchema.parse({
        executionId: created.execution.id,
        agentId: body.agentId,
        reused: Boolean(previous)
      })
    );
  };
  app.post(
    "/v1/managed-conversations/:executionId/delegate",
    { preHandler: deps.writeRateLimit },
    (request, reply) => delegate(request, reply, null)
  );
  app.post(
    "/v1/projects/:projectId/hq/delegate",
    { preHandler: deps.writeRateLimit },
    (request, reply) =>
      delegate(
        request,
        reply,
        agentDelegationProjectParamsSchema.parse(request.params).projectId
      )
  );
}
