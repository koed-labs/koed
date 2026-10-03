import type { AgentModelCapability } from "./agentIdentityEditor";
import { stripPersonalMemoryAttributionFooter } from "@koed/shared/personal-memory-attribution";
// prettier-ignore
// @ts-expect-error -- Node's native test runner needs the source extension.
import { assertRecallFeedbackChange, parseRecallFeedbackResponse, recallFeedbackPath, type RecallFeedback, type RecallFeedbackChange } from "./recall-feedback.ts";

export type ExecutionSettings = {
  model: string;
  reasoningEffort: string | null;
  permissionMode: "supervised" | "auto_edit" | "auto" | "full_access";
};
export type AgentExecution = ExecutionSettings & {
  id: string;
  projectId: string | null;
  runnerDeviceId?: string;
  provider: string;
  aiClientInstanceId: string;
  executionGeneration: number;
  stateVersion: number;
  state: string;
  lastErrorCode: string | null;
};
export type RuntimeItem = {
  id: string;
  executionGeneration: number;
  itemKind: string;
  state: string;
  payload: Record<string, unknown>;
  providerTurnId?: string | null;
  providerItemId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  presentation?: { mode: string; renderer: string; policyKey?: string };
  answered?: boolean;
};
export type RuntimeSnapshot = {
  execution: AgentExecution;
  items: RuntimeItem[];
  hasIndeterminatePrompt?: boolean;
  latestCommand: {
    id: string;
    state: string;
    commandKind: string;
    canCancelBeforeClaim?: boolean;
    clientUserMessageId?: string | null;
    lastErrorCode: string | null;
  } | null;
};

export type ManagedChatMemoryCitation = Readonly<{ label: string }>;
export type ManagedChatMemoryAttribution = Readonly<{
  used: boolean;
  status: "available" | "unavailable" | "skipped";
  citations: readonly ManagedChatMemoryCitation[];
}>;

/** Parse only server-supplied, owner-authorized citation labels. */
export function parseManagedChatMemoryAttribution(
  value: unknown
): ManagedChatMemoryAttribution | null {
  if (
    !record(value) ||
    typeof value.used !== "boolean" ||
    (value.status !== "available" &&
      value.status !== "unavailable" &&
      value.status !== "skipped") ||
    !Array.isArray(value.citations)
  )
    return null;

  const citations: ManagedChatMemoryCitation[] = [];
  for (const citation of value.citations) {
    if (
      !record(citation) ||
      typeof citation.label !== "string" ||
      citation.label.trim().length === 0
    )
      return null;
    citations.push({ label: citation.label });
  }
  if (!value.used && citations.length > 0) return null;
  return { used: value.used, status: value.status, citations };
}

export type ManagedChatHistoryMessage = Readonly<{
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  author?: Readonly<{ agentId: string; name: string }> | null;
  memory?: ManagedChatMemoryAttribution;
  providerTurnId?: string | null;
  providerItemId?: string | null;
}>;

const managedRuntimeText = (value: unknown): string => {
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

/** Add only this selected Conversation's active or uncertain approved provider output. */
export function managedMessagesWithTransientOutput(
  selectedExecutionId: string | null,
  runtime: RuntimeSnapshot | null,
  messages: ManagedChatHistoryMessage[]
): ManagedChatHistoryMessage[] {
  if (
    !selectedExecutionId ||
    runtime?.execution.id !== selectedExecutionId ||
    runtime.latestCommand?.commandKind !== "prompt" ||
    !["dispatching", "running", "indeterminate"].includes(
      runtime.latestCommand.state
    )
  )
    return messages;

  const transient = runtime.items.flatMap((item) => {
    const presentation = item.presentation;
    const text = managedRuntimeText(item.payload.text);
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

    const parsedTimestamp = Date.parse(item.updatedAt ?? item.createdAt ?? "");
    return [
      {
        id: `transient:${item.id}`,
        role: "assistant" as const,
        content: text,
        createdAt: Number.isFinite(parsedTimestamp) ? parsedTimestamp : 0,
        author: null,
        providerTurnId,
        providerItemId
      }
    ];
  });
  const unmatched = transient.filter(
    (output) =>
      !messages.some((message) => {
        if (message.role !== "assistant") return false;
        if (output.providerItemId && message.providerItemId)
          return output.providerItemId === message.providerItemId;
        return Boolean(
          output.providerTurnId &&
          message.providerTurnId &&
          output.providerTurnId === message.providerTurnId
        );
      })
  );
  return unmatched.length ? [...messages, ...unmatched] : messages;
}

/** Keep queued cancellation separate from interrupting a runner-claimed turn. */
export function canCancelManagedConversationPrompt(
  command: RuntimeSnapshot["latestCommand"] | undefined
): boolean {
  return (
    command?.commandKind === "prompt" &&
    command.state === "queued" &&
    command.canCancelBeforeClaim === true
  );
}

export function managedConversationControls(
  command: RuntimeSnapshot["latestCommand"]
): { canCancelPendingPrompt: boolean; canInterrupt: boolean } {
  if (command?.commandKind !== "prompt")
    return { canCancelPendingPrompt: false, canInterrupt: false };
  return {
    canCancelPendingPrompt: canCancelManagedConversationPrompt(command),
    canInterrupt: ["dispatching", "running"].includes(command.state)
  };
}
export type LaunchInstance = {
  instanceId: string;
  hostedInstanceId?: string;
  runnerDeviceId?: string;
  sourceDeviceLabel?: string | null;
  driverId: string;
  models: AgentModelCapability[];
  permissionModes: string[];
};
export type AgentTurnSelection = {
  agentId: string | null;
  provider: string | null;
  model: string;
  effort: string;
  permissionMode: "full" | "ask" | "read";
  instanceId?: string;
};

export const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const validExecutionId = (id: string): boolean => uuidPattern.test(id);

export class ManagedChatError extends Error {
  readonly status?: number;
  readonly code?: string;

  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** A fresh local execution needs a URL that can recover its draft after reload. */
export function shouldNavigateToExecutionAfterSendFailure(
  startedNewExecution: boolean,
  executionId: string | null
): boolean {
  return Boolean(startedNewExecution && executionId);
}

export function managedAgentRecoveryHref(
  executionId: string,
  agentId: string
): string {
  const query = new URLSearchParams({
    chat: "1",
    execution: executionId,
    agent: agentId
  });
  return `/?${query.toString()}`;
}

export async function managedRequest(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  method?: "GET" | "POST" | "PUT"
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) {
    const session = await fetch("/studio-api/github/session", {
      cache: "no-store",
      signal
    });
    const payload: unknown = await session.json();
    if (
      !session.ok ||
      !record(payload) ||
      typeof payload.csrfToken !== "string"
    ) {
      throw new ManagedChatError(
        "Studio session is unavailable. Refresh before sending."
      );
    }
    headers["x-studio-csrf"] = payload.csrfToken;
    headers["content-type"] = "application/json";
  }
  const response = await fetch(`/studio-api/managed-conversations${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
    cache: "no-store"
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const envelope =
      record(payload) && record(payload.error) ? payload.error : null;
    throw new ManagedChatError(
      envelope && typeof envelope.message === "string"
        ? envelope.message
        : record(payload) && typeof payload.error === "string"
          ? payload.error
          : "The conversation request failed.",
      response.status,
      envelope && typeof envelope.code === "string" ? envelope.code : undefined
    );
  }
  if (!record(payload))
    throw new ManagedChatError(
      "The conversation service returned an invalid response."
    );
  return payload;
}

export async function loadManagedBuildProgress(
  executionId: string,
  jobId: string,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  return managedRequest(
    `/${encodeURIComponent(executionId)}/build-progress?jobId=${encodeURIComponent(jobId)}`,
    undefined,
    signal
  );
}

export async function loadManagedRecallFeedback(
  executionId: string,
  messageId: string,
  signal?: AbortSignal
): Promise<RecallFeedback | null> {
  const path = recallFeedbackPath(executionId, messageId).replace(
    /^\/v1\/managed-conversations/,
    ""
  );
  const payload = await managedRequest(path, undefined, signal);
  if (!("feedback" in payload)) {
    throw new ManagedChatError("The feedback response is invalid.");
  }
  const feedback = parseRecallFeedbackResponse(payload);
  if (payload.feedback !== null && !feedback) {
    throw new ManagedChatError("The feedback response is invalid.");
  }
  return feedback;
}

export async function updateManagedRecallFeedback(
  executionId: string,
  messageId: string,
  change: RecallFeedbackChange,
  signal?: AbortSignal
): Promise<RecallFeedback | null> {
  assertRecallFeedbackChange(change);
  const path = recallFeedbackPath(executionId, messageId).replace(
    /^\/v1\/managed-conversations/,
    ""
  );
  const payload = await managedRequest(path, change, signal, "PUT");
  if (!("feedback" in payload)) {
    throw new ManagedChatError("The feedback response is invalid.");
  }
  const feedback = parseRecallFeedbackResponse(payload);
  if (payload.feedback !== null && !feedback) {
    throw new ManagedChatError("The feedback response is invalid.");
  }
  return feedback;
}

export function parseExecution(value: unknown): AgentExecution {
  if (
    !record(value) ||
    typeof value.id !== "string" ||
    !validExecutionId(value.id) ||
    !(
      value.projectId === null ||
      (typeof value.projectId === "string" && value.projectId.length > 0)
    ) ||
    typeof value.provider !== "string" ||
    typeof value.aiClientInstanceId !== "string" ||
    (value.runnerDeviceId !== undefined &&
      typeof value.runnerDeviceId !== "string") ||
    typeof value.model !== "string" ||
    typeof value.state !== "string" ||
    !Number.isSafeInteger(value.executionGeneration) ||
    Number(value.executionGeneration) < 1 ||
    !Number.isSafeInteger(value.stateVersion) ||
    !["supervised", "auto_edit", "auto", "full_access"].includes(
      String(value.permissionMode)
    ) ||
    !(
      value.reasoningEffort === null ||
      typeof value.reasoningEffort === "string"
    )
  ) {
    throw new ManagedChatError("The execution state is unavailable.");
  }
  return value as unknown as AgentExecution;
}

export function parseLaunchInstances(
  payload: Record<string, unknown>
): LaunchInstance[] {
  return (Array.isArray(payload.instances) ? payload.instances : []).flatMap(
    (item) => {
      if (
        !record(item) ||
        item.ready !== true ||
        typeof item.instanceId !== "string" ||
        typeof item.driverId !== "string"
      )
        return [];
      const capabilities = record(item.capabilities) ? item.capabilities : {};
      const permissionModes = (
        Array.isArray(capabilities.permissionModes)
          ? capabilities.permissionModes
          : []
      ).flatMap((mode) =>
        record(mode) &&
        mode.support === "supported" &&
        typeof mode.mode === "string"
          ? [mode.mode]
          : []
      );
      const models: AgentModelCapability[] = (
        Array.isArray(item.models) ? item.models : []
      ).flatMap((model) => {
        if (!record(model) || typeof model.id !== "string") return [];
        return [
          {
            provider: item.driverId as string,
            instanceId: item.instanceId as string,
            ...(typeof item.hostedInstanceId === "string"
              ? { hostedInstanceId: item.hostedInstanceId }
              : {}),
            ...(typeof item.sourceDeviceLabel === "string"
              ? { computerLabel: item.sourceDeviceLabel }
              : {}),
            id: model.id,
            displayName:
              typeof model.displayName === "string"
                ? model.displayName
                : model.id,
            supportedReasoningEfforts: (Array.isArray(
              model.supportedReasoningEfforts
            )
              ? model.supportedReasoningEfforts
              : []
            ).filter((effort): effort is string => typeof effort === "string")
          }
        ];
      });
      return [
        {
          instanceId: item.instanceId,
          ...(typeof item.hostedInstanceId === "string"
            ? { hostedInstanceId: item.hostedInstanceId }
            : {}),
          ...(item.sourceDeviceLabel === null ||
          typeof item.sourceDeviceLabel === "string"
            ? { sourceDeviceLabel: item.sourceDeviceLabel }
            : {}),
          driverId: item.driverId,
          models,
          permissionModes
        }
      ];
    }
  );
}

export function resolveLaunchSelection(
  selection: AgentTurnSelection,
  instances: LaunchInstance[]
) {
  if (!selection.agentId)
    throw new ManagedChatError("Choose an agent with @ before sending.");
  if (selection.permissionMode === "read") {
    throw new ManagedChatError(
      "This managed runtime does not support read-only execution. No task was started. Choose a supported permission mode explicitly."
    );
  }
  const permissionMode =
    selection.permissionMode === "ask" ? "supervised" : "full_access";
  const effort = selection.effort.toLowerCase().replace("extra high", "xhigh");
  const instance = instances.find(
    (candidate) =>
      candidate.driverId === selection.provider &&
      (!selection.instanceId ||
        candidate.instanceId === selection.instanceId) &&
      candidate.permissionModes.includes(permissionMode) &&
      candidate.models.some(
        (model) =>
          model.id === selection.model &&
          (!effort || model.supportedReasoningEfforts.includes(effort))
      )
  );
  if (!instance)
    throw new ManagedChatError(
      "The selected model, effort, or permission mode is not available. Choose supported settings before sending."
    );
  return {
    provider: instance.driverId,
    aiClientInstanceId: instance.instanceId,
    model: selection.model,
    reasoningEffort: effort || null,
    permissionMode
  } as ExecutionSettings & { provider: string; aiClientInstanceId: string };
}

export function parseRuntime(
  payload: Record<string, unknown>
): RuntimeSnapshot {
  const execution = parseExecution(payload.execution);
  const items = (Array.isArray(payload.items) ? payload.items : []).flatMap(
    (item) => {
      if (
        !record(item) ||
        typeof item.id !== "string" ||
        typeof item.itemKind !== "string" ||
        typeof item.state !== "string" ||
        item.executionGeneration !== execution.executionGeneration ||
        !record(item.payload)
      )
        return [];
      return [item as unknown as RuntimeItem];
    }
  );
  const command = payload.latestCommand;
  const latestCommand =
    record(command) &&
    typeof command.id === "string" &&
    typeof command.state === "string" &&
    typeof command.commandKind === "string"
      ? {
          id: command.id,
          state: command.state,
          commandKind: command.commandKind,
          canCancelBeforeClaim: command.canCancelBeforeClaim === true,
          ...(typeof command.clientUserMessageId === "string"
            ? { clientUserMessageId: command.clientUserMessageId }
            : {}),
          lastErrorCode:
            typeof command.lastErrorCode === "string"
              ? command.lastErrorCode
              : null
        }
      : null;
  return {
    execution,
    items,
    hasIndeterminatePrompt: payload.hasIndeterminatePrompt === true,
    latestCommand
  };
}

export function acceptRuntimeSnapshot(
  previous: RuntimeSnapshot | null,
  next: RuntimeSnapshot
): boolean {
  return (
    !previous ||
    (previous.execution.id === next.execution.id &&
      (next.execution.executionGeneration >
        previous.execution.executionGeneration ||
        (next.execution.executionGeneration ===
          previous.execution.executionGeneration &&
          next.execution.stateVersion >= previous.execution.stateVersion)))
  );
}
