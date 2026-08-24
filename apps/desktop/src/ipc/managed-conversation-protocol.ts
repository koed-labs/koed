import {
  isSupportedAiClientDriverId,
  type SupportedAiClientDriverId
} from "@koed/shared/ai-client-contract";

export const managedConversationCommandChannel =
  "koed:managed-conversation:command";

const maximumPromptBytes = 256 * 1024;
const maximumIdentifierLength = 512;
const maximumIdempotencyKeyLength = 256;

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
};

const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new TypeError(`${label} has unexpected fields.`);
  }
};

const identifier = (value: unknown, label: string): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    value.length > maximumIdentifierLength
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
};

const idempotencyKey = (value: unknown): string => {
  const key = identifier(value, "Managed Conversation idempotency key");
  if (
    key.length > maximumIdempotencyKeyLength ||
    !/^[A-Za-z0-9._:-]+$/u.test(key)
  ) {
    throw new TypeError("Managed Conversation idempotency key is invalid.");
  }
  return key;
};

const uuid = (value: unknown, label: string): string => {
  const parsed = identifier(value, label);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      parsed
    )
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  return parsed;
};

const prompt = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    new TextEncoder().encode(value).byteLength > maximumPromptBytes
  ) {
    throw new TypeError("Managed Conversation prompt is invalid.");
  }
  return value;
};

export type ManagedConversationStartRequest = {
  operation: "start";
  projectId: string;
  aiClientDriverId: SupportedAiClientDriverId;
  aiClientInstanceId: string;
  model: string;
  reasoningEffort: string | null;
  permissionMode: "supervised" | "auto_edit" | "auto" | "full_access";
  runnerKind: "local_device";
  idempotencyKey: string;
};

export type ManagedConversationLaunchOptionsRequest = {
  operation: "launch_options";
};

export type ManagedConversationDraftScope = {
  projectId: string;
  capturedSessionId: string;
  threadId: string;
};

export type ManagedConversationDraftRequest =
  | ({ operation: "draft_read" } & ManagedConversationDraftScope)
  | ({
      operation: "draft_write";
      value: string;
    } & ManagedConversationDraftScope)
  | ({ operation: "draft_delete" } & ManagedConversationDraftScope);

export type ManagedConversationResumeRequest = {
  operation: "resume";
  projectId: string;
  capturedSessionId: string;
  threadId: string;
};

export type ManagedConversationInspectRequest = {
  operation: "inspect";
  executionId: string;
};

export type ManagedConversationSendRequest = {
  operation: "send";
  executionId: string;
  capturedSessionId: string;
  threadId: string;
  idempotencyKey: string;
  clientUserMessageId: string;
  prompt: string;
  fileMentionCommandIds: string[];
  terminalContextReferences: string[];
};

export type ManagedConversationTargetsRequest = {
  operation: "targets";
};

export type ManagedConversationUsageRequest = {
  operation: "usage";
  executionId: string;
};

export type ManagedConversationRuntimeRequest = {
  operation: "runtime";
  executionId: string;
};

export type ManagedConversationRuntimeResponseRequest = {
  operation: "runtime_respond";
  executionId: string;
  itemId: string;
  itemKind:
    | "command_approval"
    | "file_approval"
    | "permissions_approval"
    | "user_input";
  executionGeneration: number;
  decision?: "accept" | "acceptForSession" | "decline" | "cancel";
  answers?: Record<string, string[]>;
};

export type ManagedConversationControlRequest = {
  operation: "interrupt" | "stop";
  executionId: string;
  executionGeneration: number;
  idempotencyKey: string;
};

export type ManagedConversationTransferStatusRequest = {
  operation: "transfer_status";
  executionId: string;
};

export type ManagedConversationHandoffRequest = {
  operation: "handoff";
  actionGrantId: string;
  executionId: string;
  operationId: string;
  targetDeviceId: string;
};

export type ManagedConversationForkRequest = {
  operation: "fork";
  actionGrantId: string;
  executionId: string;
  operationId: string;
  targetDeviceId: string;
  reason:
    | "user_requested"
    | "incompatible_provider"
    | "origin_unavailable"
    | "independent_work";
};

export type ManagedConversationRequest =
  | ManagedConversationStartRequest
  | ManagedConversationLaunchOptionsRequest
  | ManagedConversationDraftRequest
  | ManagedConversationInspectRequest
  | ManagedConversationResumeRequest
  | ManagedConversationSendRequest
  | ManagedConversationTargetsRequest
  | ManagedConversationUsageRequest
  | ManagedConversationRuntimeRequest
  | ManagedConversationRuntimeResponseRequest
  | ManagedConversationControlRequest
  | ManagedConversationTransferStatusRequest
  | ManagedConversationHandoffRequest
  | ManagedConversationForkRequest;

export type ManagedConversationIdentity = {
  executionId: string | null;
  projectId: string;
  capturedSessionId: string;
  threadId: string;
  executionOwner?: {
    driverId: SupportedAiClientDriverId;
    instanceId: string;
  };
};

export type ManagedConversationTransferLifecycle = {
  operation: "handoff" | "fork";
  operationId: string;
  state: string;
  targetDeviceId: string;
  childExecutionId: string | null;
  failureCode: string | null;
  updatedAt: string;
};

export type ManagedConversationContextUsage = {
  model: string | null;
  modelContextWindow: number | null;
  usedTokens: number | null;
  totalProcessedTokens: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  usageAccuracy:
    | "provider_reported"
    | "provider_replayed"
    | "provider_partial"
    | "local_estimate";
  observedAt: string;
};

export type ManagedConversationRuntimeItem = {
  id: string;
  executionGeneration: number;
  providerTurnId: string | null;
  providerItemId: string | null;
  itemKind:
    | "command_approval"
    | "file_approval"
    | "permissions_approval"
    | "user_input"
    | "transient_output";
  presentation: {
    mode: "expanded" | "collapsed" | "status";
    renderer:
      | "message"
      | "reasoning_summary"
      | "tool_call"
      | "tool_result"
      | "approval"
      | "user_input"
      | "lifecycle"
      | "telemetry"
      | "generic";
    policyKey: string;
    policyRevision: number;
    reason: string;
  };
  state: "pending" | "answered";
  payload: Record<string, unknown>;
  revision: number;
  createdAt: string;
  updatedAt: string;
  answered: boolean;
};

export type ManagedConversationLaunchOptions = {
  runners: Array<{
    kind: "local_device";
    deploymentId: string;
    deviceId: string;
    displayName: string;
  }>;
  instances: Array<{
    instanceId: string;
    driverId: SupportedAiClientDriverId;
    displayName: string;
    ready: boolean;
    readiness: string;
    models: Array<{
      id: string;
      displayName?: string;
      description?: string;
      supportedReasoningEfforts: string[];
      defaultReasoningEffort?: string;
      isDefault?: boolean;
      contextWindow?: number;
    }>;
    capabilities: {
      defaultPermissionMode:
        | "supervised"
        | "auto_edit"
        | "auto"
        | "full_access";
      permissionModes: Array<{
        mode: "supervised" | "auto_edit" | "auto" | "full_access";
        support: "supported" | "requires_bridge" | "unsupported";
      }>;
    };
  }>;
};

export type ManagedConversationResult =
  | {
      operation: "launch_options";
      options: ManagedConversationLaunchOptions;
    }
  | {
      operation: "draft_read";
      value: string;
    }
  | { operation: "draft_write"; ok: true }
  | { operation: "draft_delete"; ok: true }
  | {
      operation: "start";
      status: "starting" | "ready";
      executionId: string;
      conversation?: ManagedConversationIdentity;
    }
  | {
      operation: "resume";
      status: "ready" | "read_only" | "reconciling";
      conversation: ManagedConversationIdentity;
      message?: string;
    }
  | {
      operation: "inspect";
      status: "starting" | "ready" | "reconciling" | "failed";
      executionId: string;
      conversation?: ManagedConversationIdentity;
      message?: string;
    }
  | {
      operation: "send";
      status: "queued" | "reconciling" | "rejected";
      conversation: ManagedConversationIdentity;
      idempotencyKey: string;
      clientUserMessageId: string;
      turnId?: string;
      message?: string;
    }
  | {
      operation: "targets";
      devices: Array<{
        deviceId: string;
        deploymentId: string;
        label: string | null;
      }>;
    }
  | {
      operation: "usage";
      executionId: string;
      provider: "codex" | "claude" | "pi";
      usage: ManagedConversationContextUsage | null;
    }
  | {
      operation: "runtime";
      executionId: string;
      executionGeneration: number;
      executionStateVersion: number;
      executionState: string;
      executionLastErrorCode: string | null;
      latestCommand: {
        id: string;
        sequence: number;
        executionGeneration: number;
        commandKind: string;
        clientUserMessageId: string | null;
        state: string;
        lastErrorCode: string | null;
        updatedAt: string;
      } | null;
      items: ManagedConversationRuntimeItem[];
    }
  | { operation: "runtime_respond"; accepted: true; itemId: string }
  | {
      operation: "interrupt";
      status: "queued";
      executionId: string;
      commandId: string;
    }
  | {
      operation: "stop";
      status: "queued";
      executionId: string;
      commandId: string;
    }
  | {
      operation: "transfer_status";
      executionId: string;
      handoff: ManagedConversationTransferLifecycle | null;
      fork: ManagedConversationTransferLifecycle | null;
    }
  | {
      operation: "handoff";
      status: "queued";
      executionId: string;
      operationId: string;
      targetDeviceId: string;
    }
  | {
      operation: "fork";
      status: "queued";
      executionId: string;
      operationId: string;
      targetDeviceId: string;
    };

export const parseManagedConversationRequest = (
  value: unknown
): ManagedConversationRequest => {
  const input = record(value, "Managed Conversation request");
  if (input.operation === "start") {
    exactKeys(
      input,
      [
        "operation",
        "projectId",
        "aiClientDriverId",
        "aiClientInstanceId",
        "model",
        "reasoningEffort",
        "permissionMode",
        "runnerKind",
        "idempotencyKey"
      ],
      "Managed Conversation start"
    );
    return {
      operation: "start",
      projectId: identifier(input.projectId, "Project id"),
      aiClientDriverId:
        typeof input.aiClientDriverId === "string" &&
        isSupportedAiClientDriverId(input.aiClientDriverId)
          ? input.aiClientDriverId
          : (() => {
              throw new TypeError(
                "Managed Conversation AI Client driver is invalid."
              );
            })(),
      aiClientInstanceId: identifier(
        input.aiClientInstanceId,
        "AI Client instance id"
      ),
      model: identifier(input.model, "AI Client model"),
      reasoningEffort:
        input.reasoningEffort === null
          ? null
          : identifier(input.reasoningEffort, "Reasoning effort"),
      permissionMode:
        input.permissionMode === "auto" ||
        input.permissionMode === "supervised" ||
        input.permissionMode === "auto_edit" ||
        input.permissionMode === "full_access"
          ? input.permissionMode
          : (() => {
              throw new TypeError(
                "Managed Conversation permission mode is invalid."
              );
            })(),
      runnerKind:
        input.runnerKind === "local_device"
          ? input.runnerKind
          : (() => {
              throw new TypeError("Managed Conversation runner is invalid.");
            })(),
      idempotencyKey: idempotencyKey(input.idempotencyKey)
    };
  }
  if (input.operation === "launch_options") {
    exactKeys(input, ["operation"], "Managed Conversation launch options");
    return { operation: "launch_options" };
  }
  if (
    input.operation === "draft_read" ||
    input.operation === "draft_write" ||
    input.operation === "draft_delete"
  ) {
    exactKeys(
      input,
      [
        "operation",
        "projectId",
        "capturedSessionId",
        "threadId",
        ...(input.operation === "draft_write" ? ["value"] : [])
      ],
      "Managed Conversation draft"
    );
    if (
      input.operation === "draft_write" &&
      (typeof input.value !== "string" ||
        new TextEncoder().encode(input.value).byteLength > maximumPromptBytes)
    ) {
      throw new TypeError("Managed Conversation draft is invalid.");
    }
    const scope = {
      projectId: identifier(input.projectId, "Project id"),
      capturedSessionId: identifier(
        input.capturedSessionId,
        "Captured Session id"
      ),
      threadId: identifier(input.threadId, "Conversation id")
    };
    if (input.operation === "draft_write") {
      return {
        operation: "draft_write",
        ...scope,
        value: input.value as string
      };
    }
    return { operation: input.operation, ...scope };
  }
  if (input.operation === "resume") {
    exactKeys(
      input,
      ["operation", "projectId", "capturedSessionId", "threadId"],
      "Managed Conversation resume"
    );
    return {
      operation: "resume",
      projectId: identifier(input.projectId, "Project id"),
      capturedSessionId: identifier(
        input.capturedSessionId,
        "Captured Session id"
      ),
      threadId: identifier(input.threadId, "Conversation id")
    };
  }
  if (input.operation === "inspect") {
    exactKeys(
      input,
      ["operation", "executionId"],
      "Managed Conversation inspection"
    );
    return {
      operation: "inspect",
      executionId: identifier(
        input.executionId,
        "Managed Conversation execution id"
      )
    };
  }
  if (input.operation === "send") {
    exactKeys(
      input,
      [
        "operation",
        "executionId",
        "capturedSessionId",
        "threadId",
        "idempotencyKey",
        "clientUserMessageId",
        "prompt",
        "fileMentionCommandIds",
        "terminalContextReferences"
      ],
      "Managed Conversation send"
    );
    if (
      !Array.isArray(input.fileMentionCommandIds) ||
      input.fileMentionCommandIds.length > 16 ||
      input.fileMentionCommandIds.some(
        (value) =>
          typeof value !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
            value
          )
      ) ||
      !Array.isArray(input.terminalContextReferences) ||
      input.terminalContextReferences.length > 8 ||
      input.terminalContextReferences.some(
        (value) =>
          typeof value !== "string" || !/^mtc1_[A-Za-z0-9_-]{43}$/u.test(value)
      )
    ) {
      throw new TypeError(
        "Managed Conversation context references are invalid."
      );
    }
    return {
      operation: "send",
      executionId: identifier(input.executionId, "Managed execution id"),
      capturedSessionId: identifier(
        input.capturedSessionId,
        "Captured Session id"
      ),
      threadId: identifier(input.threadId, "Conversation id"),
      idempotencyKey: idempotencyKey(input.idempotencyKey),
      clientUserMessageId: uuid(
        input.clientUserMessageId,
        "Client user message id"
      ),
      prompt: prompt(input.prompt),
      fileMentionCommandIds: input.fileMentionCommandIds as string[],
      terminalContextReferences: input.terminalContextReferences as string[]
    };
  }
  if (input.operation === "runtime") {
    exactKeys(input, ["operation", "executionId"], "Managed runtime read");
    return {
      operation: "runtime",
      executionId: identifier(input.executionId, "Managed execution id")
    };
  }
  if (input.operation === "runtime_respond") {
    const itemKind = input.itemKind;
    if (
      itemKind !== "command_approval" &&
      itemKind !== "file_approval" &&
      itemKind !== "permissions_approval" &&
      itemKind !== "user_input"
    ) {
      throw new TypeError("Managed runtime item kind is invalid.");
    }
    exactKeys(
      input,
      [
        "operation",
        "executionId",
        "itemId",
        "itemKind",
        "executionGeneration",
        ...(itemKind === "user_input" ? ["answers"] : ["decision"])
      ],
      "Managed runtime response"
    );
    if (
      !Number.isSafeInteger(input.executionGeneration) ||
      (input.executionGeneration as number) < 1
    ) {
      throw new TypeError("Managed runtime generation is invalid.");
    }
    if (itemKind === "user_input") {
      const answers = record(input.answers, "Managed runtime answers");
      if (Object.keys(answers).length > 64) {
        throw new TypeError("Managed runtime answers are invalid.");
      }
      const parsedAnswers: Record<string, string[]> = {};
      for (const [questionId, value] of Object.entries(answers)) {
        if (
          !questionId ||
          questionId.length > 512 ||
          !Array.isArray(value) ||
          value.length > 32 ||
          value.some(
            (answer) => typeof answer !== "string" || answer.length > 16_384
          )
        ) {
          throw new TypeError("Managed runtime answers are invalid.");
        }
        parsedAnswers[questionId] = value as string[];
      }
      return {
        operation: "runtime_respond",
        executionId: identifier(input.executionId, "Managed execution id"),
        itemId: identifier(input.itemId, "Managed runtime item id"),
        itemKind,
        executionGeneration: input.executionGeneration as number,
        answers: parsedAnswers
      };
    }
    if (
      input.decision !== "accept" &&
      input.decision !== "acceptForSession" &&
      input.decision !== "decline" &&
      input.decision !== "cancel"
    ) {
      throw new TypeError("Managed runtime decision is invalid.");
    }
    return {
      operation: "runtime_respond",
      executionId: identifier(input.executionId, "Managed execution id"),
      itemId: identifier(input.itemId, "Managed runtime item id"),
      itemKind,
      executionGeneration: input.executionGeneration as number,
      decision: input.decision
    };
  }
  if (input.operation === "interrupt" || input.operation === "stop") {
    exactKeys(
      input,
      ["operation", "executionId", "executionGeneration", "idempotencyKey"],
      "Managed Conversation control"
    );
    if (
      !Number.isSafeInteger(input.executionGeneration) ||
      (input.executionGeneration as number) < 1
    ) {
      throw new TypeError("Managed execution generation is invalid.");
    }
    return {
      operation: input.operation,
      executionId: identifier(input.executionId, "Managed execution id"),
      executionGeneration: input.executionGeneration as number,
      idempotencyKey: idempotencyKey(input.idempotencyKey)
    };
  }
  if (input.operation === "targets") {
    exactKeys(input, ["operation"], "Managed Conversation targets");
    return { operation: "targets" };
  }
  if (input.operation === "usage") {
    exactKeys(
      input,
      ["operation", "executionId"],
      "Managed Conversation usage"
    );
    return {
      operation: "usage",
      executionId: identifier(input.executionId, "Managed execution id")
    };
  }
  if (input.operation === "transfer_status") {
    exactKeys(
      input,
      ["operation", "executionId"],
      "Managed Conversation transfer status"
    );
    return {
      operation: "transfer_status",
      executionId: identifier(input.executionId, "Managed execution id")
    };
  }
  if (input.operation === "handoff") {
    exactKeys(
      input,
      [
        "operation",
        "actionGrantId",
        "executionId",
        "operationId",
        "targetDeviceId"
      ],
      "Managed Conversation handoff"
    );
    return {
      operation: "handoff",
      actionGrantId: identifier(input.actionGrantId, "Action Grant id"),
      executionId: identifier(input.executionId, "Managed execution id"),
      operationId: identifier(input.operationId, "Handoff operation id"),
      targetDeviceId: identifier(input.targetDeviceId, "Target device id")
    };
  }
  if (input.operation === "fork") {
    exactKeys(
      input,
      [
        "operation",
        "actionGrantId",
        "executionId",
        "operationId",
        "targetDeviceId",
        "reason"
      ],
      "Managed Conversation fork"
    );
    if (
      input.reason !== "user_requested" &&
      input.reason !== "incompatible_provider" &&
      input.reason !== "origin_unavailable" &&
      input.reason !== "independent_work"
    ) {
      throw new TypeError("Managed Conversation fork reason is invalid.");
    }
    return {
      operation: "fork",
      actionGrantId: identifier(input.actionGrantId, "Action Grant id"),
      executionId: identifier(input.executionId, "Managed execution id"),
      operationId: identifier(input.operationId, "Fork operation id"),
      targetDeviceId: identifier(input.targetDeviceId, "Target device id"),
      reason: input.reason
    };
  }
  throw new TypeError("Unsupported Managed Conversation operation.");
};

const parseIdentity = (value: unknown): ManagedConversationIdentity => {
  const identity = record(value, "Managed Conversation identity");
  const hasExecutionOwner = identity.executionOwner !== undefined;
  exactKeys(
    identity,
    [
      "executionId",
      "projectId",
      "capturedSessionId",
      "threadId",
      ...(hasExecutionOwner ? ["executionOwner"] : [])
    ],
    "Managed Conversation identity"
  );
  const executionOwner = hasExecutionOwner
    ? record(identity.executionOwner, "Managed Conversation execution owner")
    : null;
  if (executionOwner) {
    exactKeys(
      executionOwner,
      ["driverId", "instanceId"],
      "Managed Conversation execution owner"
    );
    if (
      typeof executionOwner.driverId !== "string" ||
      !isSupportedAiClientDriverId(executionOwner.driverId)
    ) {
      throw new TypeError("Managed Conversation execution owner is invalid.");
    }
  }
  return {
    executionId:
      identity.executionId === null
        ? null
        : identifier(identity.executionId, "Managed Conversation execution id"),
    projectId: identifier(identity.projectId, "Project id"),
    capturedSessionId: identifier(
      identity.capturedSessionId,
      "Captured Session id"
    ),
    threadId: identifier(identity.threadId, "Conversation id"),
    ...(executionOwner
      ? {
          executionOwner: {
            driverId: executionOwner.driverId as SupportedAiClientDriverId,
            instanceId: identifier(
              executionOwner.instanceId,
              "AI Client instance id"
            )
          }
        }
      : {})
  };
};

const parseTransferLifecycle = (
  value: unknown,
  operation: "handoff" | "fork"
): ManagedConversationTransferLifecycle => {
  const lifecycle = record(value, "Managed Conversation transfer lifecycle");
  exactKeys(
    lifecycle,
    [
      "operation",
      "operationId",
      "state",
      "targetDeviceId",
      "childExecutionId",
      "failureCode",
      "updatedAt"
    ],
    "Managed Conversation transfer lifecycle"
  );
  if (lifecycle.operation !== operation) {
    throw new TypeError("Managed Conversation transfer kind is invalid.");
  }
  if (
    lifecycle.childExecutionId !== null &&
    typeof lifecycle.childExecutionId !== "string"
  ) {
    throw new TypeError("Managed Conversation child execution is invalid.");
  }
  if (
    lifecycle.failureCode !== null &&
    (typeof lifecycle.failureCode !== "string" ||
      !/^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(lifecycle.failureCode))
  ) {
    throw new TypeError("Managed Conversation transfer failure is invalid.");
  }
  if (
    typeof lifecycle.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(lifecycle.updatedAt))
  ) {
    throw new TypeError("Managed Conversation transfer time is invalid.");
  }
  return {
    operation,
    operationId: identifier(lifecycle.operationId, "Transfer operation id"),
    state: identifier(lifecycle.state, "Transfer state"),
    targetDeviceId: identifier(lifecycle.targetDeviceId, "Target device id"),
    childExecutionId:
      lifecycle.childExecutionId === null
        ? null
        : identifier(lifecycle.childExecutionId, "Child execution id"),
    failureCode: lifecycle.failureCode,
    updatedAt: lifecycle.updatedAt
  };
};

const nullableTokenCount = (value: unknown, label: string): number | null => {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value as number;
};

const parseContextUsage = (value: unknown): ManagedConversationContextUsage => {
  const usage = record(value, "Managed Conversation context usage");
  exactKeys(
    usage,
    [
      "model",
      "modelContextWindow",
      "usedTokens",
      "totalProcessedTokens",
      "inputTokens",
      "cachedInputTokens",
      "outputTokens",
      "reasoningOutputTokens",
      "usageAccuracy",
      "observedAt"
    ],
    "Managed Conversation context usage"
  );
  if (
    usage.model !== null &&
    (typeof usage.model !== "string" ||
      usage.model.length === 0 ||
      usage.model.length > 512)
  ) {
    throw new TypeError("Managed Conversation usage model is invalid.");
  }
  if (
    usage.usageAccuracy !== "provider_reported" &&
    usage.usageAccuracy !== "provider_replayed" &&
    usage.usageAccuracy !== "provider_partial" &&
    usage.usageAccuracy !== "local_estimate"
  ) {
    throw new TypeError("Managed Conversation usage accuracy is invalid.");
  }
  if (
    typeof usage.observedAt !== "string" ||
    !Number.isFinite(Date.parse(usage.observedAt))
  ) {
    throw new TypeError("Managed Conversation usage time is invalid.");
  }
  return {
    model: usage.model,
    modelContextWindow: nullableTokenCount(
      usage.modelContextWindow,
      "Model context window"
    ),
    usedTokens: nullableTokenCount(usage.usedTokens, "Used token count"),
    totalProcessedTokens: nullableTokenCount(
      usage.totalProcessedTokens,
      "Processed token count"
    ),
    inputTokens: nullableTokenCount(usage.inputTokens, "Input token count"),
    cachedInputTokens: nullableTokenCount(
      usage.cachedInputTokens,
      "Cached input token count"
    ),
    outputTokens: nullableTokenCount(usage.outputTokens, "Output token count"),
    reasoningOutputTokens: nullableTokenCount(
      usage.reasoningOutputTokens,
      "Reasoning token count"
    ),
    usageAccuracy: usage.usageAccuracy,
    observedAt: usage.observedAt
  };
};

const parseRuntimeItem = (value: unknown): ManagedConversationRuntimeItem => {
  const item = record(value, "Managed runtime item");
  exactKeys(
    item,
    [
      "id",
      "executionGeneration",
      "providerTurnId",
      "providerItemId",
      "itemKind",
      "presentation",
      "state",
      "payload",
      "revision",
      "createdAt",
      "updatedAt",
      "answered"
    ],
    "Managed runtime item"
  );
  const kinds = [
    "command_approval",
    "file_approval",
    "permissions_approval",
    "user_input",
    "transient_output"
  ] as const;
  if (
    !kinds.includes(item.itemKind as (typeof kinds)[number]) ||
    (item.state !== "pending" && item.state !== "answered") ||
    typeof item.answered !== "boolean" ||
    !Number.isSafeInteger(item.executionGeneration) ||
    (item.executionGeneration as number) < 1 ||
    !Number.isSafeInteger(item.revision) ||
    (item.revision as number) < 1 ||
    (item.providerTurnId !== null && typeof item.providerTurnId !== "string") ||
    (item.providerItemId !== null && typeof item.providerItemId !== "string") ||
    typeof item.createdAt !== "string" ||
    !Number.isFinite(Date.parse(item.createdAt)) ||
    typeof item.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(item.updatedAt))
  ) {
    throw new TypeError("Managed runtime item is invalid.");
  }
  const payload = record(item.payload, "Managed runtime payload");
  const presentation = record(
    item.presentation,
    "Managed runtime presentation"
  );
  const presentationModes = ["expanded", "collapsed", "status"] as const;
  const presentationRenderers = [
    "message",
    "reasoning_summary",
    "tool_call",
    "tool_result",
    "approval",
    "user_input",
    "lifecycle",
    "telemetry",
    "generic"
  ] as const;
  if (
    !presentationModes.includes(
      presentation.mode as (typeof presentationModes)[number]
    ) ||
    !presentationRenderers.includes(
      presentation.renderer as (typeof presentationRenderers)[number]
    ) ||
    typeof presentation.policyKey !== "string" ||
    !Number.isSafeInteger(presentation.policyRevision) ||
    (presentation.policyRevision as number) < 0 ||
    typeof presentation.reason !== "string"
  ) {
    throw new TypeError("Managed runtime presentation is invalid.");
  }
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > 256_000) {
    throw new TypeError("Managed runtime payload is too large.");
  }
  return {
    id: identifier(item.id, "Managed runtime item id"),
    executionGeneration: item.executionGeneration as number,
    providerTurnId: item.providerTurnId,
    providerItemId: item.providerItemId,
    itemKind: item.itemKind as ManagedConversationRuntimeItem["itemKind"],
    presentation:
      presentation as ManagedConversationRuntimeItem["presentation"],
    state: item.state,
    payload,
    revision: item.revision as number,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    answered: item.answered
  };
};

const permissionMode = (
  value: unknown
): "supervised" | "auto_edit" | "auto" | "full_access" => {
  if (
    value !== "auto" &&
    value !== "supervised" &&
    value !== "auto_edit" &&
    value !== "full_access"
  ) {
    throw new TypeError("Managed Conversation permission mode is invalid.");
  }
  return value;
};

const parseLaunchOptions = (
  value: unknown
): ManagedConversationLaunchOptions => {
  const options = record(value, "Managed Conversation launch options");
  exactKeys(
    options,
    ["runners", "instances"],
    "Managed Conversation launch options"
  );
  if (
    !Array.isArray(options.runners) ||
    options.runners.length > 8 ||
    !Array.isArray(options.instances) ||
    options.instances.length > 32
  ) {
    throw new TypeError("Managed Conversation launch options are invalid.");
  }
  return {
    runners: options.runners.map((value) => {
      const runner = record(value, "Managed Conversation runner");
      exactKeys(
        runner,
        ["kind", "deploymentId", "deviceId", "displayName"],
        "Managed Conversation runner"
      );
      if (runner.kind !== "local_device") {
        throw new TypeError("Managed Conversation runner is invalid.");
      }
      return {
        kind: runner.kind,
        deploymentId: identifier(runner.deploymentId, "Runner deployment id"),
        deviceId: identifier(runner.deviceId, "Runner device id"),
        displayName: identifier(runner.displayName, "Runner display name")
      };
    }),
    instances: options.instances.map((value) => {
      const instance = record(value, "AI Client instance");
      exactKeys(
        instance,
        [
          "instanceId",
          "driverId",
          "displayName",
          "ready",
          "readiness",
          "models",
          "capabilities"
        ],
        "AI Client instance"
      );
      if (
        typeof instance.driverId !== "string" ||
        !isSupportedAiClientDriverId(instance.driverId) ||
        typeof instance.ready !== "boolean" ||
        !Array.isArray(instance.models) ||
        instance.models.length > 256
      ) {
        throw new TypeError("AI Client instance is invalid.");
      }
      const capabilities = record(
        instance.capabilities,
        "AI Client capabilities"
      );
      if (
        !Array.isArray(capabilities.permissionModes) ||
        capabilities.permissionModes.length > 4
      ) {
        throw new TypeError("AI Client permission modes are invalid.");
      }
      return {
        instanceId: identifier(instance.instanceId, "AI Client instance id"),
        driverId: instance.driverId,
        displayName: identifier(instance.displayName, "AI Client display name"),
        ready: instance.ready,
        readiness: identifier(instance.readiness, "AI Client readiness"),
        models: instance.models.map((value) => {
          const model = record(value, "AI Client model");
          if (
            !Array.isArray(model.supportedReasoningEfforts) ||
            model.supportedReasoningEfforts.length > 16
          ) {
            throw new TypeError(
              "AI Client model reasoning values are invalid."
            );
          }
          const efforts = model.supportedReasoningEfforts.map((effort) =>
            identifier(effort, "AI Client reasoning effort")
          );
          return {
            id: identifier(model.id, "AI Client model id"),
            ...(typeof model.displayName === "string"
              ? {
                  displayName: identifier(
                    model.displayName,
                    "AI Client model name"
                  )
                }
              : {}),
            ...(typeof model.description === "string"
              ? { description: model.description.slice(0, 2_048) }
              : {}),
            supportedReasoningEfforts: efforts,
            ...(typeof model.defaultReasoningEffort === "string"
              ? {
                  defaultReasoningEffort: identifier(
                    model.defaultReasoningEffort,
                    "Default reasoning effort"
                  )
                }
              : {}),
            ...(typeof model.isDefault === "boolean"
              ? { isDefault: model.isDefault }
              : {}),
            ...(Number.isSafeInteger(model.contextWindow) &&
            (model.contextWindow as number) > 0
              ? { contextWindow: model.contextWindow as number }
              : {})
          };
        }),
        capabilities: {
          defaultPermissionMode: permissionMode(
            capabilities.defaultPermissionMode
          ),
          permissionModes: capabilities.permissionModes.map((value) => {
            const mode = record(value, "AI Client permission mode");
            if (
              mode.support !== "supported" &&
              mode.support !== "requires_bridge" &&
              mode.support !== "unsupported"
            ) {
              throw new TypeError("AI Client permission support is invalid.");
            }
            return { mode: permissionMode(mode.mode), support: mode.support };
          })
        }
      };
    })
  };
};

export const parseManagedConversationResult = (
  value: unknown
): ManagedConversationResult => {
  const result = record(value, "Managed Conversation result");
  if (result.operation === "launch_options") {
    exactKeys(
      result,
      ["operation", "options"],
      "Managed Conversation launch options result"
    );
    return {
      operation: "launch_options",
      options: parseLaunchOptions(result.options)
    };
  }
  if (result.operation === "draft_read") {
    exactKeys(
      result,
      ["operation", "value"],
      "Managed Conversation draft read result"
    );
    if (
      typeof result.value !== "string" ||
      new TextEncoder().encode(result.value).byteLength > maximumPromptBytes
    ) {
      throw new TypeError("Managed Conversation draft result is invalid.");
    }
    return { operation: "draft_read", value: result.value };
  }
  if (
    result.operation === "draft_write" ||
    result.operation === "draft_delete"
  ) {
    exactKeys(result, ["operation", "ok"], "Managed Conversation draft result");
    if (result.ok !== true) {
      throw new TypeError("Managed Conversation draft result is invalid.");
    }
    return { operation: result.operation, ok: true };
  }
  if (result.operation === "start") {
    const hasConversation = result.conversation !== undefined;
    exactKeys(
      result,
      [
        "operation",
        "status",
        "executionId",
        ...(hasConversation ? ["conversation"] : [])
      ],
      "Managed Conversation start result"
    );
    if (result.status !== "ready" && result.status !== "starting") {
      throw new TypeError("Managed Conversation start status is invalid.");
    }
    if (result.status === "ready" && !hasConversation) {
      throw new TypeError("Ready Managed Conversation has no identity.");
    }
    return {
      operation: "start",
      status: result.status,
      executionId: identifier(
        result.executionId,
        "Managed Conversation execution id"
      ),
      ...(hasConversation
        ? { conversation: parseIdentity(result.conversation) }
        : {})
    };
  }
  if (result.operation === "resume") {
    const allowedKeys = result.message
      ? ["operation", "status", "conversation", "message"]
      : ["operation", "status", "conversation"];
    exactKeys(result, allowedKeys, "Managed Conversation resume result");
    if (
      result.status !== "ready" &&
      result.status !== "read_only" &&
      result.status !== "reconciling"
    ) {
      throw new TypeError("Managed Conversation resume status is invalid.");
    }
    if (
      result.message !== undefined &&
      (typeof result.message !== "string" || result.message.length > 512)
    ) {
      throw new TypeError("Managed Conversation resume message is invalid.");
    }
    return {
      operation: "resume",
      status: result.status,
      conversation: parseIdentity(result.conversation),
      ...(result.message ? { message: result.message } : {})
    };
  }
  if (result.operation === "inspect") {
    const hasConversation = result.conversation !== undefined;
    const allowedKeys = [
      "operation",
      "status",
      "executionId",
      ...(hasConversation ? ["conversation"] : []),
      ...(result.message ? ["message"] : [])
    ];
    exactKeys(result, allowedKeys, "Managed Conversation inspection result");
    if (
      result.status !== "starting" &&
      result.status !== "ready" &&
      result.status !== "reconciling" &&
      result.status !== "failed"
    ) {
      throw new TypeError("Managed Conversation inspection status is invalid.");
    }
    if (result.status === "ready" && !hasConversation) {
      throw new TypeError("Ready Managed Conversation has no identity.");
    }
    if (
      result.message !== undefined &&
      (typeof result.message !== "string" || result.message.length > 512)
    ) {
      throw new TypeError(
        "Managed Conversation inspection message is invalid."
      );
    }
    return {
      operation: "inspect",
      status: result.status,
      executionId: identifier(
        result.executionId,
        "Managed Conversation execution id"
      ),
      ...(hasConversation
        ? { conversation: parseIdentity(result.conversation) }
        : {}),
      ...(result.message ? { message: result.message } : {})
    };
  }
  if (result.operation === "send") {
    const allowedKeys = [
      "operation",
      "status",
      "conversation",
      "idempotencyKey",
      "clientUserMessageId",
      ...(result.turnId ? ["turnId"] : []),
      ...(result.message ? ["message"] : [])
    ];
    exactKeys(result, allowedKeys, "Managed Conversation send result");
    if (
      result.status !== "queued" &&
      result.status !== "reconciling" &&
      result.status !== "rejected"
    ) {
      throw new TypeError("Managed Conversation send status is invalid.");
    }
    if (
      result.message !== undefined &&
      (typeof result.message !== "string" || result.message.length > 512)
    ) {
      throw new TypeError("Managed Conversation send message is invalid.");
    }
    return {
      operation: "send",
      status: result.status,
      conversation: parseIdentity(result.conversation),
      idempotencyKey: idempotencyKey(result.idempotencyKey),
      clientUserMessageId: uuid(
        result.clientUserMessageId,
        "Client user message id"
      ),
      ...(result.turnId
        ? { turnId: identifier(result.turnId, "Codex turn id") }
        : {}),
      ...(result.message ? { message: result.message } : {})
    };
  }
  if (result.operation === "targets") {
    exactKeys(result, ["operation", "devices"], "Managed Conversation targets");
    if (!Array.isArray(result.devices) || result.devices.length > 100) {
      throw new TypeError("Managed Conversation target devices are invalid.");
    }
    return {
      operation: "targets",
      devices: result.devices.map((value) => {
        const device = record(value, "Managed Conversation target device");
        exactKeys(
          device,
          ["deviceId", "deploymentId", "label"],
          "Managed Conversation target device"
        );
        if (
          device.label !== null &&
          (typeof device.label !== "string" || device.label.length > 160)
        ) {
          throw new TypeError("Managed Conversation device label is invalid.");
        }
        return {
          deviceId: identifier(device.deviceId, "Target device id"),
          deploymentId: identifier(device.deploymentId, "Target deployment id"),
          label: device.label
        };
      })
    };
  }
  if (result.operation === "usage") {
    exactKeys(
      result,
      ["operation", "executionId", "provider", "usage"],
      "Managed Conversation usage result"
    );
    if (
      result.provider !== "codex" &&
      result.provider !== "claude" &&
      result.provider !== "pi"
    ) {
      throw new TypeError("Managed Conversation usage provider is invalid.");
    }
    return {
      operation: "usage",
      executionId: identifier(result.executionId, "Managed execution id"),
      provider: result.provider,
      usage: result.usage === null ? null : parseContextUsage(result.usage)
    };
  }
  if (result.operation === "runtime") {
    exactKeys(
      result,
      [
        "operation",
        "executionId",
        "executionGeneration",
        "executionStateVersion",
        "executionState",
        "executionLastErrorCode",
        "latestCommand",
        "items"
      ],
      "Managed runtime result"
    );
    if (
      !Number.isSafeInteger(result.executionGeneration) ||
      (result.executionGeneration as number) < 1 ||
      !Number.isSafeInteger(result.executionStateVersion) ||
      (result.executionStateVersion as number) < 1 ||
      !Array.isArray(result.items) ||
      result.items.length > 256
    ) {
      throw new TypeError("Managed runtime result is invalid.");
    }
    if (
      result.executionLastErrorCode !== null &&
      typeof result.executionLastErrorCode !== "string"
    ) {
      throw new TypeError("Managed runtime execution error is invalid.");
    }
    const latestCommand =
      result.latestCommand === null
        ? null
        : record(result.latestCommand, "Managed runtime latest command");
    if (latestCommand) {
      exactKeys(
        latestCommand,
        [
          "id",
          "sequence",
          "executionGeneration",
          "commandKind",
          "clientUserMessageId",
          "state",
          "lastErrorCode",
          "updatedAt"
        ],
        "Managed runtime latest command"
      );
      if (
        !Number.isSafeInteger(latestCommand.sequence) ||
        (latestCommand.sequence as number) < 0 ||
        !Number.isSafeInteger(latestCommand.executionGeneration) ||
        (latestCommand.executionGeneration as number) < 1 ||
        typeof latestCommand.commandKind !== "string" ||
        (latestCommand.clientUserMessageId !== null &&
          typeof latestCommand.clientUserMessageId !== "string") ||
        typeof latestCommand.state !== "string" ||
        (latestCommand.lastErrorCode !== null &&
          typeof latestCommand.lastErrorCode !== "string") ||
        typeof latestCommand.updatedAt !== "string" ||
        !Number.isFinite(Date.parse(latestCommand.updatedAt))
      ) {
        throw new TypeError("Managed runtime latest command is invalid.");
      }
    }
    return {
      operation: "runtime",
      executionId: identifier(result.executionId, "Managed execution id"),
      executionGeneration: result.executionGeneration as number,
      executionStateVersion: result.executionStateVersion as number,
      executionState: identifier(
        result.executionState,
        "Managed execution state"
      ),
      executionLastErrorCode: result.executionLastErrorCode as string | null,
      latestCommand: latestCommand
        ? {
            id: identifier(latestCommand.id, "Managed runtime command id"),
            sequence: latestCommand.sequence as number,
            executionGeneration: latestCommand.executionGeneration as number,
            commandKind: identifier(
              latestCommand.commandKind,
              "Managed runtime command kind"
            ),
            state: identifier(
              latestCommand.state,
              "Managed runtime command state"
            ),
            clientUserMessageId:
              latestCommand.clientUserMessageId === null
                ? null
                : identifier(
                    latestCommand.clientUserMessageId,
                    "Managed client message id"
                  ),
            lastErrorCode: latestCommand.lastErrorCode as string | null,
            updatedAt: latestCommand.updatedAt as string
          }
        : null,
      items: result.items.map(parseRuntimeItem)
    };
  }
  if (result.operation === "runtime_respond") {
    exactKeys(
      result,
      ["operation", "accepted", "itemId"],
      "Managed runtime response result"
    );
    if (result.accepted !== true) {
      throw new TypeError("Managed runtime response was not accepted.");
    }
    return {
      operation: "runtime_respond",
      accepted: true,
      itemId: identifier(result.itemId, "Managed runtime item id")
    };
  }
  if (result.operation === "interrupt" || result.operation === "stop") {
    exactKeys(
      result,
      ["operation", "status", "executionId", "commandId"],
      "Managed control result"
    );
    if (result.status !== "queued") {
      throw new TypeError("Managed control status is invalid.");
    }
    return {
      operation: result.operation,
      status: "queued",
      executionId: identifier(result.executionId, "Managed execution id"),
      commandId: identifier(result.commandId, "Managed command id")
    };
  }
  if (result.operation === "transfer_status") {
    exactKeys(
      result,
      ["operation", "executionId", "handoff", "fork"],
      "Managed Conversation transfer status result"
    );
    return {
      operation: "transfer_status",
      executionId: identifier(result.executionId, "Managed execution id"),
      handoff:
        result.handoff === null
          ? null
          : parseTransferLifecycle(result.handoff, "handoff"),
      fork:
        result.fork === null
          ? null
          : parseTransferLifecycle(result.fork, "fork")
    };
  }
  if (result.operation === "handoff" || result.operation === "fork") {
    exactKeys(
      result,
      ["operation", "status", "executionId", "operationId", "targetDeviceId"],
      "Managed Conversation transfer result"
    );
    if (result.status !== "queued") {
      throw new TypeError("Managed Conversation transfer status is invalid.");
    }
    return {
      operation: result.operation,
      status: "queued",
      executionId: identifier(result.executionId, "Managed execution id"),
      operationId: identifier(result.operationId, "Transfer operation id"),
      targetDeviceId: identifier(result.targetDeviceId, "Target device id")
    };
  }
  throw new TypeError("Unsupported Managed Conversation result.");
};

export interface ManagedConversationDesktopApi {
  launchOptions: () => Promise<
    Extract<ManagedConversationResult, { operation: "launch_options" }>
  >;
  start: (
    input: Omit<ManagedConversationStartRequest, "operation">
  ) => Promise<Extract<ManagedConversationResult, { operation: "start" }>>;
  inspect: (
    executionId: string
  ) => Promise<Extract<ManagedConversationResult, { operation: "inspect" }>>;
  resume: (
    input: Omit<ManagedConversationResumeRequest, "operation">
  ) => Promise<Extract<ManagedConversationResult, { operation: "resume" }>>;
  send: (
    input: Omit<
      ManagedConversationSendRequest,
      "operation" | "fileMentionCommandIds" | "terminalContextReferences"
    > &
      Partial<
        Pick<
          ManagedConversationSendRequest,
          "fileMentionCommandIds" | "terminalContextReferences"
        >
      >
  ) => Promise<Extract<ManagedConversationResult, { operation: "send" }>>;
  readDraft: (
    input: ManagedConversationDraftScope
  ) => Promise<Extract<ManagedConversationResult, { operation: "draft_read" }>>;
  writeDraft: (
    input: ManagedConversationDraftScope & { value: string }
  ) => Promise<
    Extract<ManagedConversationResult, { operation: "draft_write" }>
  >;
  deleteDraft: (
    input: ManagedConversationDraftScope
  ) => Promise<
    Extract<ManagedConversationResult, { operation: "draft_delete" }>
  >;
  targets: () => Promise<
    Extract<ManagedConversationResult, { operation: "targets" }>
  >;
  usage: (
    executionId: string
  ) => Promise<Extract<ManagedConversationResult, { operation: "usage" }>>;
  runtime: (
    executionId: string
  ) => Promise<Extract<ManagedConversationResult, { operation: "runtime" }>>;
  respond: (
    input: Omit<ManagedConversationRuntimeResponseRequest, "operation">
  ) => Promise<
    Extract<ManagedConversationResult, { operation: "runtime_respond" }>
  >;
  interrupt: (
    input: Omit<ManagedConversationControlRequest, "operation">
  ) => Promise<Extract<ManagedConversationResult, { operation: "interrupt" }>>;
  stop: (
    input: Omit<ManagedConversationControlRequest, "operation">
  ) => Promise<Extract<ManagedConversationResult, { operation: "stop" }>>;
  transferStatus: (
    executionId: string
  ) => Promise<
    Extract<ManagedConversationResult, { operation: "transfer_status" }>
  >;
  handoff: (
    input: Omit<ManagedConversationHandoffRequest, "operation">
  ) => Promise<Extract<ManagedConversationResult, { operation: "handoff" }>>;
  fork: (
    input: Omit<ManagedConversationForkRequest, "operation">
  ) => Promise<Extract<ManagedConversationResult, { operation: "fork" }>>;
}
