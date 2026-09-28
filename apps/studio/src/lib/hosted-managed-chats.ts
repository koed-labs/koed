// prettier-ignore
// @ts-expect-error -- Node's native test runner needs the source extension.
import { parseExecution, parseManagedChatMemoryAttribution, parseRuntime, record, validExecutionId, type AgentExecution, type LaunchInstance, type ManagedChatMemoryAttribution, type RuntimeItem, type RuntimeSnapshot } from "./managed-agent-chat.ts";
import type { AgentModelCapability } from "./agentIdentityEditor";
import type { PendingChatRequest } from "./managed-chat-requests";
import { stripPersonalMemoryAttributionFooter } from "@koed/shared/personal-memory-attribution";

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
  memory?: ManagedChatMemoryAttribution;
  providerTurnId?: string | null;
  providerItemId?: string | null;
};

type HostedRuntimeOutputSnapshot = Omit<RuntimeSnapshot, "items"> & {
  items: Array<
    RuntimeItem & {
      createdAt?: string;
      updatedAt?: string;
      providerTurnId?: string | null;
      providerItemId?: string | null;
      presentation?: RuntimeItem["presentation"] & { policyKey?: string };
    }
  >;
};

/** Add visible current-generation provider output for active or uncertain prompts. */
export function hostedMessagesWithTransientOutput(
  selectedExecutionId: string | null,
  runtime: HostedRuntimeOutputSnapshot | null,
  messages: HostedConversationMessage[]
): HostedConversationMessage[] {
  if (
    !selectedExecutionId ||
    runtime?.execution.id !== selectedExecutionId ||
    (!hostedPromptOutcomeIsUncertain(runtime) &&
      (runtime.latestCommand?.commandKind !== "prompt" ||
        !["dispatching", "running"].includes(runtime.latestCommand.state)))
  )
    return messages;

  const transient = runtime.items.flatMap((item) => {
    const presentation = item.presentation;
    const text =
      typeof item.payload.text === "string"
        ? hostedRuntimeText(item.payload.text)
        : "";
    const providerTurnId = item.providerTurnId?.trim() || null;
    const providerItemId = item.providerItemId?.trim() || null;
    if (
      item.executionGeneration !== runtime.execution.executionGeneration ||
      item.itemKind !== "transient_output" ||
      item.state !== "pending" ||
      presentation?.mode === "hidden" ||
      presentation?.renderer !== "message" ||
      !presentation.policyKey ||
      !text ||
      (!providerTurnId && !providerItemId)
    )
      return [];

    return [
      {
        id: `transient:${item.id}`,
        role: "assistant" as const,
        content: text,
        createdAt: item.updatedAt ?? item.createdAt ?? "",
        author: null,
        providerTurnId,
        providerItemId
      }
    ];
  });

  if (transient.length === 0) return messages;
  const unmatched = transient.filter(
    (output) =>
      !messages.some((message) => {
        if (message.role !== "assistant") return false;
        if (output.providerItemId && message.providerItemId) {
          return output.providerItemId === message.providerItemId;
        }
        return Boolean(
          output.providerTurnId &&
          message.providerTurnId &&
          output.providerTurnId === message.providerTurnId
        );
      })
  );
  return [...messages, ...unmatched].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt)
  );
}

export function hostedMessagesForSelection<
  T extends { id: string },
  P extends T & { executionId: string }
>(
  selectedExecutionId: string | null,
  runtimeExecutionId: string | null,
  messages: T[],
  pendingMessage: P | null
): Array<T | P> {
  if (!selectedExecutionId || runtimeExecutionId !== selectedExecutionId) {
    return [];
  }
  if (
    !pendingMessage ||
    pendingMessage.executionId !== selectedExecutionId ||
    messages.some((message) => message.id === pendingMessage.id)
  ) {
    return messages;
  }
  return [...messages, pendingMessage];
}

export function hostedRecoveryGuardForSelection(input: {
  selectedExecutionId: string | null;
  pendingOperationExecutionId: string | null;
  checkingExecutionIds: readonly string[];
}): { hasPendingOperation: boolean; isChecking: boolean } {
  const { selectedExecutionId } = input;
  if (!selectedExecutionId) {
    return { hasPendingOperation: false, isChecking: false };
  }
  return {
    hasPendingOperation:
      input.pendingOperationExecutionId === selectedExecutionId,
    isChecking: input.checkingExecutionIds.includes(selectedExecutionId)
  };
}

/** An unresolved prompt outcome must never authorize a fresh send. */
export function hostedPromptOutcomeIsUncertain(
  runtime:
    | (Pick<RuntimeSnapshot, "latestCommand"> & {
        hasIndeterminatePrompt?: boolean;
      })
    | null
    | undefined
): boolean {
  return (
    runtime?.hasIndeterminatePrompt === true ||
    (runtime?.latestCommand?.commandKind === "prompt" &&
      runtime.latestCommand.state === "indeterminate")
  );
}

export function hostedRecoverySelectionIsCurrent(
  selectedExecutionAtStart: string | null,
  selectedExecutionNow: string | null
): boolean {
  return selectedExecutionAtStart === selectedExecutionNow;
}

export type HostedConversationState = {
  executionId: string;
  executionGeneration: number;
  executionState: string;
  messages: HostedConversationMessage[];
};

export type HostedConversationRecoveryLookup =
  | { found: false }
  | {
      found: true;
      executionId: string;
      executionGeneration: number;
      commandId: string;
      commandState: string;
      commandKind: "start" | "prompt";
      clientUserMessageId: string | null;
      initialPromptCommandId?: string | null;
    };

export type HostedRecoveryDisposition = Readonly<{
  kind: "accepted" | "canceled" | "failed" | "uncertain";
  clearIdentity: boolean;
  restorePrompt: boolean;
  showPendingMessage: boolean;
}>;

/** Preserve send identity when the runner cannot prove the command outcome. */
export function hostedRecoveryDisposition(
  commandState: string
): HostedRecoveryDisposition {
  if (commandState === "canceled")
    return {
      kind: "canceled",
      clearIdentity: true,
      restorePrompt: true,
      showPendingMessage: false
    };
  if (commandState === "failed")
    return {
      kind: "failed",
      clearIdentity: false,
      restorePrompt: true,
      showPendingMessage: false
    };
  if (commandState === "indeterminate")
    return {
      kind: "uncertain",
      clearIdentity: false,
      restorePrompt: true,
      showPendingMessage: true
    };
  if (["queued", "blocked", "dispatching"].includes(commandState))
    return {
      kind: "accepted",
      clearIdentity: false,
      restorePrompt: false,
      showPendingMessage: true
    };
  if (commandState === "completed")
    return {
      kind: "accepted",
      clearIdentity: true,
      restorePrompt: false,
      showPendingMessage: true
    };
  return {
    kind: "uncertain",
    clearIdentity: false,
    restorePrompt: true,
    showPendingMessage: true
  };
}

export type HostedLaunchOptions = {
  runners: Array<{ deviceId: string; displayName: string }>;
  instances: Array<
    LaunchInstance & {
      runnerDeviceId: string;
      readiness: string;
      ready: boolean;
    }
  >;
  projects: Array<{ id: string; name: string }>;
};

export const hostedLaunchInstancesForDevice = (
  options: HostedLaunchOptions | null,
  deviceId: string
): HostedLaunchOptions["instances"] =>
  options?.instances.filter(
    (instance) => instance.runnerDeviceId === deviceId
  ) ?? [];

export type HostedLaunchSelection = {
  projectId: string;
  deviceId: string;
  instanceId: string;
  modelId: string;
  effort: string;
  permission: string;
};

export const hostedLaunchSelectionForOptions = (
  options: HostedLaunchOptions,
  current: HostedLaunchSelection
): HostedLaunchSelection => {
  const projectId =
    current.projectId === "" ||
    options.projects.some((project) => project.id === current.projectId)
      ? current.projectId
      : (options.projects[0]?.id ?? "");
  const deviceId = options.runners.some(
    (runner) => runner.deviceId === current.deviceId
  )
    ? current.deviceId
    : (options.runners[0]?.deviceId ?? "");
  const instances = hostedLaunchInstancesForDevice(options, deviceId);
  const instance =
    instances.find((item) => item.instanceId === current.instanceId) ??
    instances[0];
  const model =
    instance?.models.find((item) => item.id === current.modelId) ??
    instance?.models[0];
  const effort = model?.supportedReasoningEfforts.includes(current.effort)
    ? current.effort
    : (model?.supportedReasoningEfforts[0] ?? "");
  const permission = instance?.permissionModes.includes(current.permission)
    ? current.permission
    : (instance?.permissionModes[0] ?? "");

  return {
    projectId,
    deviceId,
    instanceId: instance?.instanceId ?? "",
    modelId: model?.id ?? "",
    effort,
    permission
  };
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

const hostedRuntimeText = (value: unknown): string => {
  if (typeof value !== "string") return "";
  return stripPersonalMemoryAttributionFooter(value)
    .slice(0, 12_000)
    .replace(
      /(?:\/(?:Users|home|private|Volumes|tmp|root|workspace|workspaces|var|mnt|opt|srv|etc)\/|[A-Za-z]:\\)[^\s"']+/gu,
      "[local path hidden]"
    )
    .replace(
      /\b(api[_ -]?key|token|password|secret|credential|authorization)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      "$1=[redacted]"
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, "Bearer [redacted]")
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/gu,
      "[redacted]"
    );
};

const hostedRuntimeValue = (value: unknown, key = "", depth = 0): unknown => {
  if (
    /api[_ -]?key|token|password|secret|credential|authorization|private[_ -]?key/iu.test(
      key
    )
  )
    return "[redacted]";
  if (typeof value === "string") return hostedRuntimeText(value);
  if (Array.isArray(value)) {
    if (depth >= 5) return "[details omitted]";
    return value
      .slice(0, 64)
      .map((entry) => hostedRuntimeValue(entry, key, depth + 1));
  }
  if (!record(value)) return value;
  if (depth >= 5) return "[details omitted]";
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 64)
      .map(([entryKey, entryValue]) => [
        hostedRuntimeText(entryKey),
        hostedRuntimeValue(entryValue, entryKey, depth + 1)
      ])
  );
};

const hostedRuntimeItem = (item: RuntimeSnapshot["items"][number]) => {
  const payload: Record<string, unknown> = {};
  for (const key of ["reason", "toolName", "command", "diff"] as const) {
    if (
      typeof item.payload[key] === "string" ||
      Array.isArray(item.payload[key])
    )
      payload[key] = hostedRuntimeValue(item.payload[key], key);
  }
  const presentation = item.presentation as
    | (NonNullable<RuntimeItem["presentation"]> & { policyKey?: string })
    | undefined;
  if (
    item.itemKind === "transient_output" &&
    item.state === "pending" &&
    presentation?.mode !== "hidden" &&
    presentation?.renderer === "message" &&
    typeof presentation.policyKey === "string" &&
    presentation.policyKey.length > 0 &&
    typeof item.payload.text === "string"
  )
    payload.text = hostedRuntimeText(item.payload.text);
  if (record(item.payload.permissions))
    payload.permissions = hostedRuntimeValue(
      item.payload.permissions,
      "permissions"
    );
  if (record(item.payload.input)) {
    const input: Record<string, unknown> = {};
    for (const key of [
      "command",
      "cmd",
      "file_path",
      "path",
      "patch",
      "diff"
    ] as const) {
      if (item.payload.input[key] !== undefined)
        input[key] = hostedRuntimeValue(item.payload.input[key], key);
    }
    if (Object.keys(input).length > 0) payload.input = input;
  }
  if (item.payload.supportsSessionApproval === true)
    payload.supportsSessionApproval = true;
  if (Array.isArray(item.payload.questions)) {
    payload.questions = item.payload.questions.flatMap((value) => {
      if (!record(value) || typeof value.id !== "string") return [];
      return [
        {
          id: value.id,
          ...(typeof value.header === "string"
            ? { header: hostedRuntimeText(value.header) }
            : {}),
          ...(typeof value.question === "string"
            ? { question: hostedRuntimeText(value.question) }
            : {}),
          ...(typeof value.required === "boolean"
            ? { required: value.required }
            : {}),
          ...(value.isSecret === true ? { isSecret: true } : {}),
          ...(value.isOther === true ? { isOther: true } : {}),
          ...(Array.isArray(value.options)
            ? {
                options: value.options.flatMap((option) =>
                  record(option) && typeof option.label === "string"
                    ? [
                        {
                          label: hostedRuntimeText(option.label),
                          ...(typeof option.description === "string"
                            ? {
                                description: hostedRuntimeText(
                                  option.description
                                )
                              }
                            : {})
                        }
                      ]
                    : []
                )
              }
            : {})
        }
      ];
    });
  }
  return { ...item, payload };
};

export function hasMeaningfulHostedApprovalDetails(
  request: PendingChatRequest
): boolean {
  if (request.kind === "user_input")
    return Boolean(
      request.questions?.some((question) => question.question.trim())
    );
  const usefulLabels = new Set([
    "Command",
    "Changes",
    "Permissions",
    "command",
    "cmd",
    "file_path",
    "path",
    "patch",
    "diff"
  ]);
  return request.details.some((detail) => {
    if (!usefulLabels.has(detail.label)) return false;
    const content = detail.text
      .replace(/\[(?:local path hidden|redacted)\]/giu, "")
      .replace(
        /\b(?:api[_ -]?key|token|password|secret|credential)\s*[:=]?/giu,
        ""
      )
      .replace(/[^\p{L}\p{N}]/gu, "");
    return content.length > 0;
  });
}

export function hostedRecoveryBackendId(value: unknown): string | null {
  if (!record(value) || !record(value.connection)) return null;
  const backendId = value.connection.backendId;
  return typeof backendId === "string" && backendId.trim()
    ? backendId.trim()
    : null;
}

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
    const hasMemory = Object.prototype.hasOwnProperty.call(value, "memory");
    const memory =
      hasMemory && value.role === "assistant"
        ? parseManagedChatMemoryAttribution(value.memory)
        : undefined;
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
          stripPersonalMemoryAttributionFooter(value.content, {
            mode: "final"
          }) + (value.truncated === true ? "\n[Output truncated]" : ""),
        createdAt: value.createdAt,
        author,
        ...(memory ? { memory } : {}),
        ...(typeof value.providerTurnId === "string" ||
        value.providerTurnId === null
          ? { providerTurnId: value.providerTurnId }
          : {}),
        ...(typeof value.providerItemId === "string" ||
        value.providerItemId === null
          ? { providerItemId: value.providerItemId }
          : {})
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
          typeof value.driverId !== "string" ||
          typeof value.runnerDeviceId !== "string" ||
          !runners.some((runner) => runner.deviceId === value.runnerDeviceId)
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
        const readiness =
          typeof value.readiness === "string" ? value.readiness : "unknown";
        const mayUseLastKnownModels =
          value.ready === true || readiness === "stale";
        const models: AgentModelCapability[] =
          mayUseLastKnownModels && Array.isArray(value.models)
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
                          (effort): effort is string =>
                            typeof effort === "string"
                        )
                      : []
                  }
                ];
              })
            : [];
        return [
          {
            instanceId: value.instanceId,
            runnerDeviceId: value.runnerDeviceId,
            driverId: value.driverId,
            models,
            permissionModes,
            ready: value.ready === true,
            readiness
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
    initialPromptClientUserMessageId?: string;
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
    items: parsedRuntime.items.map(hostedRuntimeItem),
    hasIndeterminatePrompt: parsedRuntime.hasIndeterminatePrompt,
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

export async function loadHostedManagedConversationAccess(
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<{ ownerId: string; backendId: string }> {
  const payload = await requestJson(
    "/v1/managed-conversations/access",
    { signal },
    fetcher
  );
  if (
    !record(payload.user) ||
    typeof payload.user.id !== "string" ||
    !payload.user.id.trim()
  )
    throw new HostedManagedChatError(
      "The signed-in Conversation owner is unavailable."
    );
  if (typeof payload.backendId !== "string" || !payload.backendId.trim())
    throw new HostedManagedChatError(
      "The Conversation backend identity is unavailable."
    );
  return { ownerId: payload.user.id, backendId: payload.backendId.trim() };
}

export async function lookupHostedConversationRecovery(
  input:
    | { kind: "start"; idempotencyKey: string }
    | {
        kind: "prompt";
        idempotencyKey: string;
        clientUserMessageId: string;
        executionId: string;
        executionGeneration: number;
      },
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<HostedConversationRecoveryLookup> {
  if (!input.idempotencyKey.trim())
    throw new HostedManagedChatError(
      "This Conversation send identity is unavailable."
    );
  if (
    input.kind === "prompt" &&
    (!validExecutionId(input.clientUserMessageId) ||
      !validExecutionId(input.executionId) ||
      !Number.isSafeInteger(input.executionGeneration) ||
      input.executionGeneration < 1)
  )
    throw new HostedManagedChatError(
      "This Conversation send identity is outdated."
    );
  const query = new URLSearchParams({
    kind: input.kind,
    idempotencyKey: input.idempotencyKey,
    ...(input.kind === "prompt"
      ? {
          clientUserMessageId: input.clientUserMessageId,
          executionId: input.executionId,
          executionGeneration: String(input.executionGeneration)
        }
      : {})
  });
  const payload = await requestJson(
    `/v1/managed-conversations/recovery/lookup?${query.toString()}`,
    { signal },
    fetcher
  );
  if (payload.found === false) return { found: false };
  if (
    payload.found !== true ||
    !record(payload.execution) ||
    !record(payload.command) ||
    typeof payload.execution.id !== "string" ||
    !validExecutionId(payload.execution.id) ||
    !Number.isSafeInteger(payload.execution.executionGeneration) ||
    typeof payload.command.id !== "string" ||
    !validExecutionId(payload.command.id) ||
    payload.command.executionId !== payload.execution.id ||
    payload.command.executionGeneration !==
      payload.execution.executionGeneration ||
    payload.command.commandKind !== input.kind ||
    typeof payload.command.state !== "string" ||
    !(
      payload.command.clientUserMessageId === null ||
      typeof payload.command.clientUserMessageId === "string"
    )
  )
    throw new HostedManagedChatError(
      "Koed returned invalid Conversation recovery state."
    );
  if (
    input.kind === "prompt" &&
    (payload.execution.id !== input.executionId ||
      payload.execution.executionGeneration !== input.executionGeneration ||
      payload.command.clientUserMessageId !== input.clientUserMessageId)
  )
    throw new HostedManagedChatError(
      "Koed returned mismatched Conversation recovery state."
    );
  return {
    found: true,
    executionId: payload.execution.id,
    executionGeneration: Number(payload.execution.executionGeneration),
    commandId: payload.command.id,
    commandState: payload.command.state,
    commandKind: input.kind,
    clientUserMessageId: payload.command.clientUserMessageId as string | null,
    ...(input.kind === "start"
      ? {
          initialPromptCommandId:
            typeof payload.command.initialPromptCommandId === "string" &&
            validExecutionId(payload.command.initialPromptCommandId)
              ? payload.command.initialPromptCommandId
              : null
        }
      : {})
  };
}

export async function respondToHostedRuntimeItem(
  execution: Pick<AgentExecution, "id" | "executionGeneration">,
  item: Pick<RuntimeItem, "id" | "executionGeneration" | "itemKind">,
  response: {
    decision?: "accept" | "acceptForSession" | "decline" | "cancel";
    answers?: Record<string, string[]>;
  },
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<void> {
  assertExecutionId(execution.id);
  if (
    !validExecutionId(item.id) ||
    item.executionGeneration !== execution.executionGeneration ||
    ![
      "command_approval",
      "file_approval",
      "permissions_approval",
      "user_input"
    ].includes(item.itemKind)
  )
    throw new HostedManagedChatError(
      "This Conversation request is outdated. Refresh before responding."
    );
  const kind = item.itemKind as
    | "command_approval"
    | "file_approval"
    | "permissions_approval"
    | "user_input";
  const body = {
    kind,
    executionGeneration: item.executionGeneration,
    ...(kind === "user_input"
      ? { answers: response.answers ?? {} }
      : { decision: response.decision })
  };
  await requestJson(
    `/v1/managed-conversations/${encodeURIComponent(execution.id)}/runtime-items/${encodeURIComponent(item.id)}/respond`,
    { signal, body },
    fetcher
  );
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
