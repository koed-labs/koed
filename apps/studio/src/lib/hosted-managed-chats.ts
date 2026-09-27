// prettier-ignore
// @ts-expect-error -- Node's native test runner needs the source extension.
import { parseExecution, parseRuntime, record, validExecutionId, type AgentExecution, type LaunchInstance, type RuntimeSnapshot } from "./managed-agent-chat.ts";
import type { AgentModelCapability } from "./agentIdentityEditor";

export type HostedManagedExecution = AgentExecution & {
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  stoppedAt: string | null;
};

export type HostedConversationMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  author: { agentId: string; name: string } | null;
};

export type HostedConversationState = {
  executionId: string;
  executionGeneration: number;
  executionState: string;
  messages: HostedConversationMessage[];
};

export type HostedLaunchOptions = {
  runners: Array<{ deviceId: string; displayName: string }>;
  instances: Array<LaunchInstance & { readiness: string; ready: boolean }>;
  projects: Array<{ id: string; name: string }>;
};

export type HostedProjectMove = {
  id: string;
  executionId: string;
  executionGeneration: number;
  sourceProjectId: string | null;
  destinationProjectId: string;
  state: "pending" | "claimed" | "cancelled" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
};

export type LocalRetainedWorkspace = {
  moveId: string;
  sourcePath: string;
  reason: string;
  retainedAt: string;
  sourceProjectId: string | null;
  available: boolean;
  checkoutKind: "koed_managed_worktree" | "user_managed_checkout" | "unknown";
  deletable: boolean;
};

export class HostedManagedChatError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
    this.name = "HostedManagedChatError";
  }
}

const assertExecutionId = (id: string) => {
  if (!validExecutionId(id))
    throw new HostedManagedChatError("This Conversation is unavailable.");
};

const projectExecution = (value: unknown): AgentExecution => {
  const execution = parseExecution(value);
  return {
    id: execution.id,
    projectId: execution.projectId,
    provider: execution.provider,
    aiClientInstanceId: execution.aiClientInstanceId,
    model: execution.model,
    reasoningEffort: execution.reasoningEffort,
    permissionMode: execution.permissionMode,
    executionGeneration: execution.executionGeneration,
    stateVersion: execution.stateVersion,
    state: execution.state,
    lastErrorCode: execution.lastErrorCode
  };
};

const projectMove = (
  value: unknown,
  expectedExecutionId: string
): HostedProjectMove => {
  if (
    !record(value) ||
    typeof value.id !== "string" ||
    !validExecutionId(value.id) ||
    value.executionId !== expectedExecutionId ||
    !Number.isSafeInteger(value.executionGeneration) ||
    Number(value.executionGeneration) < 1 ||
    !(
      value.sourceProjectId === null ||
      typeof value.sourceProjectId === "string"
    ) ||
    typeof value.destinationProjectId !== "string" ||
    !value.destinationProjectId.trim() ||
    !["pending", "claimed", "cancelled", "completed", "failed"].includes(
      String(value.state)
    ) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  )
    throw new HostedManagedChatError(
      "Koed returned an invalid Project Move state."
    );
  return {
    id: value.id,
    executionId: value.executionId,
    executionGeneration: Number(value.executionGeneration),
    sourceProjectId: value.sourceProjectId as string | null,
    destinationProjectId: value.destinationProjectId,
    state: value.state as HostedProjectMove["state"],
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
};

export async function requestHostedProjectMove(
  execution: Pick<
    AgentExecution,
    "id" | "executionGeneration" | "stateVersion"
  >,
  destinationProjectId: string,
  idempotencyKey: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
  routePrefix = "/v1/managed-conversations"
): Promise<HostedProjectMove> {
  assertExecutionId(execution.id);
  const payload = await requestJson(
    `${routePrefix}/${encodeURIComponent(execution.id)}/project-moves`,
    {
      body: {
        executionGeneration: execution.executionGeneration,
        expectedStateVersion: execution.stateVersion,
        destinationProjectId,
        idempotencyKey
      },
      signal
    },
    fetcher
  );
  return projectMove(payload.move, execution.id);
}

export async function loadLatestHostedProjectMove(
  executionId: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
  routePrefix = "/v1/managed-conversations"
): Promise<HostedProjectMove | null> {
  assertExecutionId(executionId);
  const payload = await requestJson(
    `${routePrefix}/${encodeURIComponent(executionId)}/project-moves/latest`,
    { signal },
    fetcher
  );
  return payload.move === null ? null : projectMove(payload.move, executionId);
}

export async function cancelHostedProjectMove(
  execution: Pick<AgentExecution, "id" | "executionGeneration">,
  moveId: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
  routePrefix = "/v1/managed-conversations"
): Promise<HostedProjectMove> {
  assertExecutionId(execution.id);
  if (!validExecutionId(moveId))
    throw new HostedManagedChatError("This Project Move is unavailable.");
  const payload = await requestJson(
    `${routePrefix}/${encodeURIComponent(execution.id)}/project-moves/${encodeURIComponent(moveId)}/cancel`,
    { body: { executionGeneration: execution.executionGeneration }, signal },
    fetcher
  );
  return projectMove(payload.move, execution.id);
}

const localProjectMovePrefix = "/studio-api/managed-conversations";

export function requestLocalProjectMove(
  execution: Pick<
    AgentExecution,
    "id" | "executionGeneration" | "stateVersion"
  >,
  destinationProjectId: string,
  idempotencyKey: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<HostedProjectMove> {
  return requestHostedProjectMove(
    execution,
    destinationProjectId,
    idempotencyKey,
    signal,
    fetcher,
    localProjectMovePrefix
  );
}

export function loadLatestLocalProjectMove(
  executionId: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<HostedProjectMove | null> {
  return loadLatestHostedProjectMove(
    executionId,
    signal,
    fetcher,
    localProjectMovePrefix
  );
}

export function cancelLocalProjectMove(
  execution: Pick<AgentExecution, "id" | "executionGeneration">,
  moveId: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<HostedProjectMove> {
  return cancelHostedProjectMove(
    execution,
    moveId,
    signal,
    fetcher,
    localProjectMovePrefix
  );
}

export async function loadLocalRetainedWorkspaces(
  executionId: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<LocalRetainedWorkspace[]> {
  assertExecutionId(executionId);
  const payload = await requestJson(
    `${localProjectMovePrefix}/${encodeURIComponent(executionId)}/retained-workspaces`,
    { signal, csrf: true },
    fetcher
  );
  if (!Array.isArray(payload.workspaces))
    throw new HostedManagedChatError(
      "Koed returned an invalid retained workspace list."
    );
  return payload.workspaces.map((value) => {
    if (
      !record(value) ||
      typeof value.moveId !== "string" ||
      !validExecutionId(value.moveId) ||
      typeof value.sourcePath !== "string" ||
      value.sourcePath.length === 0 ||
      typeof value.reason !== "string" ||
      typeof value.retainedAt !== "string" ||
      typeof value.available !== "boolean" ||
      !["koed_managed_worktree", "user_managed_checkout", "unknown"].includes(
        String(value.checkoutKind)
      ) ||
      typeof value.deletable !== "boolean" ||
      !(
        value.sourceProjectId === null ||
        typeof value.sourceProjectId === "string"
      )
    )
      throw new HostedManagedChatError(
        "Koed returned an invalid retained workspace record."
      );
    return {
      moveId: value.moveId,
      sourcePath: value.sourcePath,
      reason: value.reason,
      retainedAt: value.retainedAt,
      sourceProjectId: value.sourceProjectId,
      available: value.available,
      checkoutKind:
        value.checkoutKind as LocalRetainedWorkspace["checkoutKind"],
      deletable: value.deletable
    };
  });
}

export async function openLocalRetainedWorkspace(
  executionId: string,
  moveId: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<void> {
  assertExecutionId(executionId);
  if (!validExecutionId(moveId))
    throw new HostedManagedChatError("This retained workspace is unavailable.");
  const payload = await requestJson(
    `${localProjectMovePrefix}/${encodeURIComponent(executionId)}/retained-workspaces/${encodeURIComponent(moveId)}/open`,
    { body: {}, signal, csrf: true },
    fetcher
  );
  if (payload.opened !== true)
    throw new HostedManagedChatError(
      "Koed could not open this retained workspace."
    );
}

export async function deleteLocalRetainedManagedWorktree(
  executionId: string,
  moveId: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<void> {
  assertExecutionId(executionId);
  if (!validExecutionId(moveId))
    throw new HostedManagedChatError("This retained workspace is unavailable.");
  const payload = await requestJson(
    `${localProjectMovePrefix}/${encodeURIComponent(executionId)}/retained-workspaces/${encodeURIComponent(moveId)}/delete`,
    { body: { confirmation: "delete_managed_worktree" }, signal, csrf: true },
    fetcher
  );
  if (payload.deleted !== true)
    throw new HostedManagedChatError(
      "Koed could not delete this managed worktree."
    );
}

const requestJson = async (
  path: string,
  input: { body?: unknown; signal?: AbortSignal; csrf?: boolean } = {},
  fetcher: typeof fetch = fetch
): Promise<Record<string, unknown>> => {
  let csrfToken: string | null = null;
  if (input.csrf && !path.startsWith("/studio-api/"))
    throw new HostedManagedChatError(
      "Retained workspaces are available only in local Studio."
    );
  if (
    input.csrf ||
    (input.body !== undefined && path.startsWith("/studio-api/"))
  ) {
    const session = await fetcher("/studio-api/github/session", {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      signal: input.signal,
      headers: { accept: "application/json" }
    });
    const sessionPayload: unknown = await session.json().catch(() => null);
    if (
      !session.ok ||
      !record(sessionPayload) ||
      typeof sessionPayload.csrfToken !== "string"
    )
      throw new HostedManagedChatError(
        "Studio session is unavailable. Refresh before retrying this Studio action."
      );
    csrfToken = sessionPayload.csrfToken;
  }
  const response = await fetcher(path, {
    method: input.body === undefined ? "GET" : "POST",
    credentials: "include",
    cache: "no-store",
    redirect: "error",
    signal: input.signal,
    headers: {
      accept: "application/json",
      ...(input.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...(csrfToken === null ? {} : { "x-studio-csrf": csrfToken })
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) })
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const gatewayError =
      record(payload) && typeof payload.error === "string"
        ? payload.error
        : null;
    throw new HostedManagedChatError(
      gatewayError === "retained_workspace_unavailable"
        ? "This retained workspace is no longer available on this computer."
        : gatewayError
          ? gatewayError
          : response.status === 401 || response.status === 403
            ? "Your Koed session is no longer authorized. Sign in again."
            : "The Conversation request failed. Retry to connect.",
      response.status
    );
  }
  if (!record(payload))
    throw new HostedManagedChatError(
      "Koed returned an invalid Conversation response."
    );
  return payload;
};

export function parseHostedManagedExecutions(
  payload: Record<string, unknown>
): HostedManagedExecution[] {
  if (!Array.isArray(payload.executions))
    throw new HostedManagedChatError(
      "Koed returned an invalid Conversation list."
    );
  return payload.executions.flatMap((value) => {
    try {
      const execution = projectExecution(value);
      if (
        !record(value) ||
        typeof value.createdAt !== "string" ||
        typeof value.updatedAt !== "string" ||
        !(value.startedAt === null || typeof value.startedAt === "string") ||
        !(value.stoppedAt === null || typeof value.stoppedAt === "string")
      )
        return [];
      return [
        {
          ...execution,
          createdAt: value.createdAt,
          updatedAt: value.updatedAt,
          startedAt: value.startedAt,
          stoppedAt: value.stoppedAt
        }
      ];
    } catch {
      return [];
    }
  });
}

export function parseHostedConversationState(
  payload: Record<string, unknown>,
  expectedExecutionId: string,
  expectedGeneration: number
): HostedConversationState {
  if (
    payload.executionId !== expectedExecutionId ||
    payload.executionGeneration !== expectedGeneration ||
    typeof payload.executionState !== "string" ||
    !Array.isArray(payload.messages)
  )
    throw new HostedManagedChatError(
      "Koed returned an outdated Conversation history. Refresh and try again."
    );
  const messages = payload.messages.flatMap((value) => {
    if (
      !record(value) ||
      typeof value.id !== "string" ||
      (value.role !== "user" && value.role !== "assistant") ||
      typeof value.content !== "string" ||
      typeof value.createdAt !== "string"
    )
      return [];
    const author = record(value.author)
      ? typeof value.author.agentId === "string" &&
        typeof value.author.name === "string"
        ? { agentId: value.author.agentId, name: value.author.name }
        : null
      : null;
    return [
      {
        id: value.id,
        role: value.role as "user" | "assistant",
        content:
          value.content +
          (value.truncated === true ? "\n[Output truncated]" : ""),
        createdAt: value.createdAt,
        author
      }
    ];
  });
  return {
    executionId: expectedExecutionId,
    executionGeneration: expectedGeneration,
    executionState: payload.executionState,
    messages
  };
}

export async function listHostedManagedConversations(
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<HostedManagedExecution[]> {
  return parseHostedManagedExecutions(
    await requestJson(
      "/v1/managed-conversations?limit=100",
      { signal },
      fetcher
    )
  );
}

export async function loadHostedLaunchOptions(
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<HostedLaunchOptions> {
  const payload = await requestJson(
    "/v1/managed-conversations/launch-options",
    { signal },
    fetcher
  );
  const runners = Array.isArray(payload.runners)
    ? payload.runners.flatMap((value) =>
        record(value) &&
        value.kind === "local_device" &&
        typeof value.deviceId === "string" &&
        typeof value.displayName === "string"
          ? [{ deviceId: value.deviceId, displayName: value.displayName }]
          : []
      )
    : [];
  const instances = Array.isArray(payload.instances)
    ? payload.instances.flatMap((value) => {
        if (
          !record(value) ||
          typeof value.instanceId !== "string" ||
          typeof value.driverId !== "string"
        )
          return [];
        const capabilities = record(value.capabilities)
          ? value.capabilities
          : {};
        const permissionModes = Array.isArray(capabilities.permissionModes)
          ? capabilities.permissionModes.flatMap((mode) =>
              record(mode) &&
              typeof mode.mode === "string" &&
              mode.support === "supported"
                ? [mode.mode]
                : []
            )
          : [];
        const models: AgentModelCapability[] = Array.isArray(value.models)
          ? value.models.flatMap((model) => {
              if (!record(model) || typeof model.id !== "string") return [];
              return [
                {
                  provider: value.driverId as string,
                  instanceId: value.instanceId as string,
                  id: model.id,
                  displayName:
                    typeof model.displayName === "string"
                      ? model.displayName
                      : model.id,
                  supportedReasoningEfforts: Array.isArray(
                    model.supportedReasoningEfforts
                  )
                    ? model.supportedReasoningEfforts.filter(
                        (effort): effort is string => typeof effort === "string"
                      )
                    : []
                }
              ];
            })
          : [];
        return [
          {
            instanceId: value.instanceId,
            driverId: value.driverId,
            models,
            permissionModes,
            ready: value.ready === true,
            readiness:
              typeof value.readiness === "string" ? value.readiness : "unknown"
          }
        ];
      })
    : [];
  const projects = Array.isArray(payload.projects)
    ? payload.projects.flatMap((value) =>
        record(value) &&
        typeof value.id === "string" &&
        typeof value.name === "string"
          ? [{ id: value.id, name: value.name }]
          : []
      )
    : [];
  return { runners, instances, projects };
}

export async function startHostedManagedConversation(
  input: {
    projectId: string | null;
    contextKind: "project" | "independent";
    provider: string;
    aiClientInstanceId: string;
    model: string;
    reasoningEffort: string | null;
    permissionMode: string;
    targetDeviceId: string;
    idempotencyKey: string;
    initialPrompt?: string;
  },
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<{
  execution: AgentExecution;
  commandId: string;
  commandState: string;
}> {
  if (
    (input.contextKind === "independent" && input.projectId !== null) ||
    (input.contextKind === "project" && input.projectId === null)
  )
    throw new HostedManagedChatError(
      "Choose either a Project or a standalone Conversation."
    );
  const payload = await requestJson(
    "/v1/managed-conversations",
    { body: { ...input, runnerKind: "local_device" }, signal },
    fetcher
  );
  const execution = projectExecution(payload.execution);
  if (
    !record(payload.command) ||
    typeof payload.command.id !== "string" ||
    typeof payload.command.state !== "string"
  )
    throw new HostedManagedChatError(
      "Koed did not confirm that the Conversation was accepted."
    );
  return {
    execution,
    commandId: payload.command.id,
    commandState: payload.command.state
  };
}

export async function cancelHostedConversationStart(
  execution: Pick<AgentExecution, "id" | "executionGeneration">,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<{ commandId: string; state: string; canceled: boolean }> {
  assertExecutionId(execution.id);
  const payload = await requestJson(
    `/v1/managed-conversations/${encodeURIComponent(execution.id)}/start/cancel`,
    { signal, body: { executionGeneration: execution.executionGeneration } },
    fetcher
  );
  if (
    !record(payload.command) ||
    typeof payload.command.id !== "string" ||
    typeof payload.command.state !== "string"
  )
    throw new HostedManagedChatError(
      "Koed did not confirm the Conversation start state."
    );
  return {
    commandId: payload.command.id,
    state: payload.command.state,
    canceled: payload.command.canceled === true
  };
}

export async function loadHostedManagedConversation(
  executionId: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<{ runtime: RuntimeSnapshot; state: HostedConversationState }> {
  assertExecutionId(executionId);
  const base = `/v1/managed-conversations/${encodeURIComponent(executionId)}`;
  const [runtimePayload, statePayload] = await Promise.all([
    requestJson(`${base}/runtime`, { signal }, fetcher),
    requestJson(`${base}/agent-state?limit=20`, { signal }, fetcher)
  ]);
  const parsedRuntime = parseRuntime(runtimePayload);
  const runtime: RuntimeSnapshot = {
    execution: projectExecution(runtimePayload.execution),
    items: [],
    latestCommand: parsedRuntime.latestCommand
  };
  if (runtime.execution.id !== executionId)
    throw new HostedManagedChatError(
      "Koed returned a different Conversation. Refresh and try again."
    );
  return {
    runtime,
    state: parseHostedConversationState(
      statePayload,
      executionId,
      runtime.execution.executionGeneration
    )
  };
}

export async function queueHostedConversationPrompt(
  execution: Pick<AgentExecution, "id" | "executionGeneration">,
  prompt: string,
  ids: { idempotencyKey: string; clientUserMessageId: string },
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<{ commandId: string; state: string }> {
  assertExecutionId(execution.id);
  const payload = await requestJson(
    `/v1/managed-conversations/${encodeURIComponent(execution.id)}/prompts`,
    {
      signal,
      body: {
        executionGeneration: execution.executionGeneration,
        idempotencyKey: ids.idempotencyKey,
        clientUserMessageId: ids.clientUserMessageId,
        prompt
      }
    },
    fetcher
  );
  if (
    !record(payload.command) ||
    typeof payload.command.id !== "string" ||
    typeof payload.command.state !== "string"
  )
    throw new HostedManagedChatError(
      "Koed did not confirm that the message was accepted."
    );
  return { commandId: payload.command.id, state: payload.command.state };
}

export async function cancelHostedQueuedPrompt(
  execution: Pick<AgentExecution, "id" | "executionGeneration">,
  commandId: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<{ state: string; canceled: boolean }> {
  assertExecutionId(execution.id);
  if (!validExecutionId(commandId))
    throw new HostedManagedChatError("This Pending message is unavailable.");
  const payload = await requestJson(
    `/v1/managed-conversations/${encodeURIComponent(execution.id)}/prompts/${encodeURIComponent(commandId)}/cancel`,
    { signal, body: { executionGeneration: execution.executionGeneration } },
    fetcher
  );
  if (!record(payload.command) || typeof payload.command.state !== "string")
    throw new HostedManagedChatError(
      "Koed did not confirm the Pending message state."
    );
  return {
    state: payload.command.state,
    canceled: payload.command.canceled === true
  };
}

export async function requestHostedConversationControl(
  execution: Pick<AgentExecution, "id" | "executionGeneration">,
  action: "interrupt" | "stop",
  idempotencyKey: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<{ commandId: string; state: string }> {
  assertExecutionId(execution.id);
  const payload = await requestJson(
    `/v1/managed-conversations/${encodeURIComponent(execution.id)}/${action}`,
    {
      signal,
      body: {
        executionGeneration: execution.executionGeneration,
        idempotencyKey
      }
    },
    fetcher
  );
  if (
    !record(payload.command) ||
    typeof payload.command.id !== "string" ||
    typeof payload.command.state !== "string"
  )
    throw new HostedManagedChatError(
      `Koed did not confirm the ${action} request.`
    );
  return { commandId: payload.command.id, state: payload.command.state };
}
