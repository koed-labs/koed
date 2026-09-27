import type { AgentModelCapability } from "./agentIdentityEditor";

export type ExecutionSettings = {
  model: string;
  reasoningEffort: string | null;
  permissionMode: "supervised" | "auto_edit" | "auto" | "full_access";
};
export type AgentExecution = ExecutionSettings & {
  id: string;
  projectId: string | null;
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
  presentation?: { mode: string; renderer: string };
  answered?: boolean;
};
export type RuntimeSnapshot = {
  execution: AgentExecution;
  items: RuntimeItem[];
  latestCommand: {
    id: string;
    state: string;
    commandKind: string;
    clientUserMessageId?: string | null;
    lastErrorCode: string | null;
  } | null;
};

/** Keep queued cancellation separate from interrupting a runner-claimed turn. */
export function managedConversationControls(
  command: RuntimeSnapshot["latestCommand"]
): { canCancelPendingPrompt: boolean; canInterrupt: boolean } {
  if (command?.commandKind !== "prompt")
    return { canCancelPendingPrompt: false, canInterrupt: false };
  return {
    canCancelPendingPrompt: ["queued", "pending"].includes(command.state),
    canInterrupt: ["dispatching", "running"].includes(command.state)
  };
}
export type LaunchInstance = {
  instanceId: string;
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

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export async function managedRequest(
  path: string,
  body?: unknown,
  signal?: AbortSignal
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
    method: body === undefined ? "GET" : "POST",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
    cache: "no-store"
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ManagedChatError(
      record(payload) && typeof payload.error === "string"
        ? payload.error
        : "The conversation request failed.",
      response.status
    );
  }
  if (!record(payload))
    throw new ManagedChatError(
      "The conversation service returned an invalid response."
    );
  return payload;
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
          ...(typeof command.clientUserMessageId === "string"
            ? { clientUserMessageId: command.clientUserMessageId }
            : {}),
          lastErrorCode:
            typeof command.lastErrorCode === "string"
              ? command.lastErrorCode
              : null
        }
      : null;
  return { execution, items, latestCommand };
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
