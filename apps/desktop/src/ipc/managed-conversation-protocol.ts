import {
  aiClientIdentifierPattern,
  aiClientInstanceIdMaxLength
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

const aiClientInstanceIdentifier = (value: unknown, label: string): string => {
  const result = identifier(value, label);
  if (
    result.length > aiClientInstanceIdMaxLength ||
    !aiClientIdentifierPattern.test(result)
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  return result;
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
  aiClientDriverId: "codex" | "claude" | "pi";
  aiClientInstanceId: string;
  idempotencyKey: string;
};

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
  capturedSessionId: string;
  threadId: string;
  idempotencyKey: string;
  prompt: string;
};

export type ManagedConversationTargetsRequest = {
  operation: "targets";
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
  | ManagedConversationInspectRequest
  | ManagedConversationResumeRequest
  | ManagedConversationSendRequest
  | ManagedConversationTargetsRequest
  | ManagedConversationTransferStatusRequest
  | ManagedConversationHandoffRequest
  | ManagedConversationForkRequest;

export type ManagedConversationIdentity = {
  executionId: string | null;
  projectId: string;
  capturedSessionId: string;
  threadId: string;
  executionOwner?: {
    driverId: "codex" | "claude" | "pi";
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

export type ManagedConversationResult =
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
      status: "queued" | "reconciling";
      conversation: ManagedConversationIdentity;
      idempotencyKey: string;
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
        "idempotencyKey"
      ],
      "Managed Conversation start"
    );
    if (
      input.aiClientDriverId !== "codex" &&
      input.aiClientDriverId !== "claude" &&
      input.aiClientDriverId !== "pi"
    ) {
      throw new TypeError("AI Client driver id is invalid.");
    }
    return {
      operation: "start",
      projectId: identifier(input.projectId, "Project id"),
      aiClientDriverId: input.aiClientDriverId,
      aiClientInstanceId: aiClientInstanceIdentifier(
        input.aiClientInstanceId,
        "AI Client instance id"
      ),
      idempotencyKey: idempotencyKey(input.idempotencyKey)
    };
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
        "capturedSessionId",
        "threadId",
        "idempotencyKey",
        "prompt"
      ],
      "Managed Conversation send"
    );
    return {
      operation: "send",
      capturedSessionId: identifier(
        input.capturedSessionId,
        "Captured Session id"
      ),
      threadId: identifier(input.threadId, "Conversation id"),
      idempotencyKey: idempotencyKey(input.idempotencyKey),
      prompt: prompt(input.prompt)
    };
  }
  if (input.operation === "targets") {
    exactKeys(input, ["operation"], "Managed Conversation targets");
    return { operation: "targets" };
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
  const keys = ["executionId", "projectId", "capturedSessionId", "threadId"];
  if (identity.executionOwner !== undefined) keys.push("executionOwner");
  exactKeys(identity, keys, "Managed Conversation identity");
  const owner =
    identity.executionOwner === undefined
      ? undefined
      : record(identity.executionOwner, "Managed Conversation execution owner");
  if (owner) {
    exactKeys(
      owner,
      ["driverId", "instanceId"],
      "Managed Conversation execution owner"
    );
  }
  if (
    owner &&
    owner.driverId !== "codex" &&
    owner.driverId !== "claude" &&
    owner.driverId !== "pi"
  ) {
    throw new TypeError("Managed Conversation execution owner is invalid.");
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
    ...(owner
      ? {
          executionOwner: {
            driverId: owner.driverId as "codex" | "claude" | "pi",
            instanceId: aiClientInstanceIdentifier(
              owner.instanceId,
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

export const parseManagedConversationResult = (
  value: unknown
): ManagedConversationResult => {
  const result = record(value, "Managed Conversation result");
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
      ...(result.turnId ? ["turnId"] : []),
      ...(result.message ? ["message"] : [])
    ];
    exactKeys(result, allowedKeys, "Managed Conversation send result");
    if (result.status !== "queued" && result.status !== "reconciling") {
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
  start: (
    projectId: string,
    idempotencyKey: string,
    owner: {
      aiClientDriverId: "codex" | "claude" | "pi";
      aiClientInstanceId: string;
    }
  ) => Promise<Extract<ManagedConversationResult, { operation: "start" }>>;
  inspect: (
    executionId: string
  ) => Promise<Extract<ManagedConversationResult, { operation: "inspect" }>>;
  resume: (
    input: Omit<ManagedConversationResumeRequest, "operation">
  ) => Promise<Extract<ManagedConversationResult, { operation: "resume" }>>;
  send: (
    input: Omit<ManagedConversationSendRequest, "operation">
  ) => Promise<Extract<ManagedConversationResult, { operation: "send" }>>;
  targets: () => Promise<
    Extract<ManagedConversationResult, { operation: "targets" }>
  >;
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
