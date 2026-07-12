import { createHash } from "node:crypto";
import { codexCanonicalConversationItemKey } from "@koed/shared";

export { codexCanonicalConversationItemKey } from "@koed/shared";

import type { CodexAppServerRawEvent } from "./codex-app-server-runner.js";
import type { RawConversationItemRequest } from "./conversation-source-types.js";

export const CODEX_APP_SERVER_CONVERSATION_ADAPTER_VERSION =
  "codex-app-server-conversation-v1";

type RecordValue = Record<string, unknown>;

export interface CodexManagedConversationSourceContext {
  sessionId: string;
  externalThreadId: string;
  transcriptPath?: string;
  clientUserMessageIds?: ReadonlyMap<string, string>;
}

export interface CodexConversationIdentityIssue {
  method: string;
  itemType: string;
  externalThreadId: string;
  externalTurnId?: string;
  reason: string;
}

export interface CodexConversationAdapterBatch {
  items: RawConversationItemRequest[];
  identityIssues: CodexConversationIdentityIssue[];
}

const isRecord = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const record = (value: unknown): RecordValue => (isRecord(value) ? value : {});

const string = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const sha256 = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const semanticContent = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === "string") {
          return entry;
        }
        return isRecord(entry) && typeof entry.text === "string"
          ? entry.text
          : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return isRecord(value) ? JSON.stringify(value) : "";
};

const compactDisplay = (value: unknown, maxLength: number): string => {
  const normalized = semanticContent(value).replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 3)}...`;
};

const joined = (parts: Array<string | undefined>): string =>
  parts.filter((part): part is string => Boolean(part?.trim())).join("\n\n");

const userMessageText = (item: RecordValue): string => {
  const content = Array.isArray(item.content) ? item.content : [];
  return content
    .map((entry) => {
      const input = record(entry);
      return string(input.text) ?? string(input.path) ?? "";
    })
    .filter(Boolean)
    .join("\n");
};

const reasoningSummaryText = (item: RecordValue): string =>
  (Array.isArray(item.summary) ? item.summary : [])
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join("\n");

const rawEventEnvelope = (event: CodexAppServerRawEvent): RecordValue => ({
  method: event.method,
  ...(event.params !== undefined ? { params: event.params } : {}),
  ...(event.result !== undefined ? { result: event.result } : {})
});

const isoFromUnixTime = (
  value: unknown,
  unit: "milliseconds" | "seconds"
): string | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  const date = new Date(unit === "seconds" ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

const sourceEventTime = (event: CodexAppServerRawEvent): string | undefined => {
  const params = record(event.params);
  if (event.method === "item/started") {
    return isoFromUnixTime(params.startedAtMs, "milliseconds");
  }
  if (event.method === "item/completed") {
    return isoFromUnixTime(params.completedAtMs, "milliseconds");
  }
  const turn = record(params.turn);
  if (event.method === "turn/completed") {
    return isoFromUnixTime(turn.completedAt, "seconds");
  }
  if (event.method === "turn/started") {
    return isoFromUnixTime(turn.startedAt, "seconds");
  }
  return undefined;
};

const eventThreadId = (
  event: CodexAppServerRawEvent,
  fallback: string
): string => {
  const params = record(event.params);
  const result = record(event.result);
  return (
    string(params.threadId) ??
    string(record(params.thread).id) ??
    string(record(result.thread).id) ??
    fallback
  );
};

const eventTurnId = (event: CodexAppServerRawEvent): string | undefined => {
  const params = record(event.params);
  const result = record(event.result);
  return (
    string(params.turnId) ??
    string(record(params.turn).id) ??
    string(record(result.turn).id)
  );
};

const observationIdentity = (input: {
  event: CodexAppServerRawEvent;
  component: string;
  externalThreadId: string;
  externalTurnId?: string;
  externalItemId?: string;
  stableItemId: string;
  snapshotIdentity?: boolean;
}): { sourceHash: string; idempotencyKey: string } => {
  const sourceHash = sha256(rawEventEnvelope(input.event));
  const lifecycleIdentity = {
    version: 1,
    provider: "codex",
    sourceTransport: "app_server",
    method: input.event.method,
    externalThreadId: input.externalThreadId,
    externalTurnId: input.externalTurnId ?? null,
    lifecycleItemId: input.externalItemId ?? input.stableItemId,
    component: input.component,
    ...(input.snapshotIdentity ? { sourceHash } : {})
  };
  return {
    sourceHash,
    idempotencyKey: `codex-app-server-observation:${sha256(lifecycleIdentity)}`
  };
};

const canonicalItem = (input: {
  event: CodexAppServerRawEvent;
  context: CodexManagedConversationSourceContext;
  externalThreadId: string;
  externalTurnId?: string;
  externalItemId?: string;
  stableItemId: string;
  component: string;
  transcriptType: string;
  rawText?: string;
  metadata?: RecordValue;
  observationKind: "lifecycle_started" | "lifecycle_completed" | "control";
  projectionStatus: "pending" | "raw_only";
  canonicalIdentity?: boolean;
  observationOnly?: boolean;
  snapshotIdentity?: boolean;
}): RawConversationItemRequest => {
  const observation = observationIdentity({
    event: input.event,
    component: input.component,
    externalThreadId: input.externalThreadId,
    externalTurnId: input.externalTurnId,
    externalItemId: input.externalItemId,
    stableItemId: input.stableItemId,
    snapshotIdentity: input.snapshotIdentity
  });
  const eventTime = sourceEventTime(input.event);
  return {
    ...(input.observationOnly ? { observationOnly: true } : {}),
    sessionId: input.context.sessionId,
    sourceKind: "codex",
    sourceAdapterVersion: CODEX_APP_SERVER_CONVERSATION_ADAPTER_VERSION,
    sourceTransport: "app_server",
    externalSessionId: input.externalThreadId,
    externalThreadId: input.externalThreadId,
    ...(input.externalTurnId ? { externalTurnId: input.externalTurnId } : {}),
    ...(input.externalItemId ? { externalItemId: input.externalItemId } : {}),
    sourceRecordType: "app_server_notification",
    sourceEventType: input.event.method,
    sourceSequence: input.event.sequence,
    ...(eventTime ? { eventTime } : {}),
    observedAt: input.event.observedAt,
    rawJson: rawEventEnvelope(input.event),
    ...(input.rawText?.trim() ? { rawText: input.rawText.trim() } : {}),
    ...observation,
    ...(input.canonicalIdentity === false
      ? {}
      : {
          canonicalItemKey: codexCanonicalConversationItemKey({
            externalThreadId: input.externalThreadId,
            externalTurnId: input.externalTurnId,
            stableItemId: input.stableItemId,
            component: input.component
          }),
          canonicalStableItemId: input.stableItemId
        }),
    observationKind: input.observationKind,
    observationComponent: input.component,
    projectionStatus: input.projectionStatus,
    projectionVersion: CODEX_APP_SERVER_CONVERSATION_ADAPTER_VERSION,
    metadata: {
      managedConversation: true,
      transcriptType: input.transcriptType,
      appServerItemType: input.metadata?.appServerItemType,
      sourceEventTimeAccuracy: eventTime ? "source" : "observation_only",
      canonicalIdentityBasis:
        input.canonicalIdentity === false
          ? "source_observation"
          : "provider_ids",
      ...input.metadata
    }
  };
};

const toolMetadata = (input: {
  kind: "call" | "output";
  type: string;
  name?: string;
  callId: string;
  value?: unknown;
  error?: unknown;
  status?: string;
  durationMs?: number;
  startedAtMs?: number;
  completedAtMs?: number;
}): RecordValue => {
  const label = input.name ?? input.callId;
  return {
    transcriptType: input.type,
    toolEventKind: input.type,
    toolSummary: `Tool ${input.kind === "call" ? "call" : "output"}: ${label}`,
    ...(input.name ? { toolName: input.name, toolTitle: input.name } : {}),
    callId: input.callId,
    toolCallId: input.callId,
    ...(input.status ? { status: input.status } : {}),
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    ...(input.startedAtMs !== undefined
      ? { startedAtMs: input.startedAtMs }
      : {}),
    ...(input.completedAtMs !== undefined
      ? { completedAtMs: input.completedAtMs }
      : {}),
    ...(input.error !== undefined ? { error: input.error } : {}),
    toolCall: {
      kind: input.kind,
      type: input.type,
      ...(input.name ? { name: input.name, title: input.name } : {}),
      id: input.callId,
      ...(input.kind === "call" && input.value !== undefined
        ? { input: input.value }
        : {}),
      ...(input.kind === "output" && input.value !== undefined
        ? { output: input.value }
        : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.durationMs !== undefined
        ? { durationMs: input.durationMs }
        : {}),
      ...(input.startedAtMs !== undefined
        ? { startedAtMs: input.startedAtMs }
        : {}),
      ...(input.completedAtMs !== undefined
        ? { completedAtMs: input.completedAtMs }
        : {})
    }
  };
};

const toolCallText = (input: {
  name: string;
  value?: unknown;
  status?: string;
}): string =>
  joined([
    `Tool call: ${input.name}`,
    input.status ? `Status: ${input.status}` : undefined,
    input.value !== undefined
      ? `Input:\n${compactDisplay(input.value, 800)}`
      : undefined
  ]);

const toolOutputText = (input: {
  callId: string;
  value?: unknown;
  status?: string;
  error?: unknown;
}): string =>
  joined([
    `Tool output: ${input.callId}`,
    input.status ? `Status: ${input.status}` : undefined,
    input.value !== undefined ? compactDisplay(input.value, 1200) : undefined,
    input.error !== undefined
      ? `Error:\n${compactDisplay(input.error, 800)}`
      : undefined
  ]);

const appServerToolParts = (input: {
  event: CodexAppServerRawEvent;
  context: CodexManagedConversationSourceContext;
  externalThreadId: string;
  externalTurnId?: string;
  item: RecordValue;
  itemType: string;
  itemId: string;
  completed: boolean;
}): RawConversationItemRequest[] => {
  let name: string;
  let callValue: unknown;
  let outputValue: unknown;
  let displayOutputValue: unknown;
  let error: unknown;
  if (input.itemType === "commandExecution") {
    name = "exec_command";
    callValue = { cmd: input.item.command };
    outputValue = input.item.aggregatedOutput;
    if (input.item.exitCode !== undefined && input.item.exitCode !== null) {
      outputValue = {
        output: input.item.aggregatedOutput ?? "",
        exitCode: input.item.exitCode
      };
    }
    displayOutputValue = outputValue;
  } else if (input.itemType === "mcpToolCall") {
    const server = string(input.item.server) ?? "mcp";
    const tool = string(input.item.tool) ?? "tool";
    const result = record(input.item.result);
    name = `${server}.${tool}`;
    callValue = input.item.arguments;
    outputValue = input.item.result;
    displayOutputValue = Object.hasOwn(result, "content")
      ? result.content
      : input.item.result;
    error = input.item.error;
  } else if (input.itemType === "dynamicToolCall") {
    name = string(input.item.tool) ?? "dynamic_tool";
    callValue = input.item.arguments;
    outputValue = input.item.contentItems;
    displayOutputValue = outputValue;
  } else {
    name = string(input.item.tool) ?? "agent_tool";
    callValue = {
      prompt: input.item.prompt,
      receiverThreadIds: input.item.receiverThreadIds
    };
    outputValue = input.item.agentsStates;
    displayOutputValue = outputValue;
  }
  const status = string(input.item.status);
  const durationMs = finiteNumber(input.item.durationMs);
  const params = record(input.event.params);
  const startedAtMs = finiteNumber(params.startedAtMs);
  const completedAtMs = finiteNumber(params.completedAtMs);
  const observationKind = input.completed
    ? "lifecycle_completed"
    : "lifecycle_started";
  const callType = "function_call";
  const result = [
    canonicalItem({
      event: input.event,
      context: input.context,
      externalThreadId: input.externalThreadId,
      externalTurnId: input.externalTurnId,
      externalItemId: input.itemId,
      stableItemId: input.itemId,
      component: "tool_call",
      transcriptType: callType,
      rawText: toolCallText({ name, value: callValue, status }),
      metadata: {
        appServerItemType: input.itemType,
        ...toolMetadata({
          kind: "call",
          type: callType,
          name,
          callId: input.itemId,
          value: callValue,
          status,
          durationMs,
          startedAtMs,
          completedAtMs
        })
      },
      observationKind,
      projectionStatus: "pending"
    })
  ];
  if (input.completed) {
    const outputType = "function_call_output";
    result.push(
      canonicalItem({
        event: input.event,
        context: input.context,
        externalThreadId: input.externalThreadId,
        externalTurnId: input.externalTurnId,
        externalItemId: input.itemId,
        stableItemId: input.itemId,
        component: "tool_result",
        transcriptType: outputType,
        rawText: toolOutputText({
          callId: input.itemId,
          value: displayOutputValue,
          status,
          error
        }),
        metadata: {
          appServerItemType: input.itemType,
          ...toolMetadata({
            kind: "output",
            type: outputType,
            callId: input.itemId,
            value: outputValue,
            error,
            status,
            durationMs,
            startedAtMs,
            completedAtMs
          })
        },
        observationKind,
        projectionStatus: "pending"
      })
    );
  }
  return result;
};

const unresolvedItem = (input: {
  event: CodexAppServerRawEvent;
  context: CodexManagedConversationSourceContext;
  externalThreadId: string;
  externalTurnId?: string;
  itemType: string;
  reason: string;
}): RawConversationItemRequest => {
  const stableItemId = `unresolved:${input.event.method}:${
    input.externalTurnId ?? input.externalThreadId
  }:${input.itemType}`;
  return canonicalItem({
    event: input.event,
    context: input.context,
    externalThreadId: input.externalThreadId,
    externalTurnId: input.externalTurnId,
    stableItemId,
    component: "unresolved",
    transcriptType: input.itemType,
    metadata: {
      appServerItemType: input.itemType,
      identityResolution: "unresolved",
      identityResolutionError: input.reason
    },
    observationKind: "control",
    projectionStatus: "raw_only",
    canonicalIdentity: false,
    observationOnly: true,
    snapshotIdentity: true
  });
};

const unresolvedBatch = (input: {
  event: CodexAppServerRawEvent;
  context: CodexManagedConversationSourceContext;
  externalThreadId: string;
  externalTurnId?: string;
  itemType: string;
  reason: string;
}): CodexConversationAdapterBatch => ({
  items: [unresolvedItem(input)],
  identityIssues: [
    {
      method: input.event.method,
      itemType: input.itemType,
      externalThreadId: input.externalThreadId,
      ...(input.externalTurnId ? { externalTurnId: input.externalTurnId } : {}),
      reason: input.reason
    }
  ]
});

export const adaptCodexAppServerConversationEvent = (
  event: CodexAppServerRawEvent,
  context: CodexManagedConversationSourceContext
): CodexConversationAdapterBatch => {
  if (/delta$/i.test(event.method)) {
    return { items: [], identityIssues: [] };
  }
  const externalThreadId = eventThreadId(event, context.externalThreadId);
  const externalTurnId = eventTurnId(event);
  const params = record(event.params);
  const item = record(params.item);
  const itemType = string(item.type);
  if (event.method === "item/started" || event.method === "item/completed") {
    const completed = event.method === "item/completed";
    if (!itemType) {
      return unresolvedBatch({
        event,
        context,
        externalThreadId,
        externalTurnId,
        itemType: "unknown",
        reason: "item lifecycle event has no item.type"
      });
    }
    if (!externalTurnId) {
      return unresolvedBatch({
        event,
        context,
        externalThreadId,
        itemType,
        reason: `projectable ${itemType} lifecycle event has no turn identity`
      });
    }
    const itemId = string(item.id);
    if (!itemId) {
      return unresolvedBatch({
        event,
        context,
        externalThreadId,
        externalTurnId,
        itemType,
        reason: `projectable ${itemType} lifecycle event has no provider item.id`
      });
    }
    const clientUserMessageId =
      itemType === "userMessage"
        ? (string(item.clientId) ??
          (externalTurnId
            ? context.clientUserMessageIds?.get(externalTurnId)
            : undefined))
        : undefined;
    const stableItemId =
      itemType === "userMessage" ? clientUserMessageId : itemId;
    if (!stableItemId) {
      return unresolvedBatch({
        event,
        context,
        externalThreadId,
        externalTurnId,
        itemType,
        reason: `projectable ${itemType} lifecycle event has no stable provider item id`
      });
    }
    if (
      [
        "commandExecution",
        "mcpToolCall",
        "dynamicToolCall",
        "collabAgentToolCall"
      ].includes(itemType)
    ) {
      return {
        items: appServerToolParts({
          event,
          context,
          externalThreadId,
          externalTurnId,
          item,
          itemType,
          itemId: stableItemId,
          completed
        }),
        identityIssues: []
      };
    }
    const observationKind = completed
      ? "lifecycle_completed"
      : "lifecycle_started";
    if (itemType === "userMessage") {
      return {
        items: [
          canonicalItem({
            event,
            context,
            externalThreadId,
            externalTurnId,
            externalItemId: itemId,
            stableItemId,
            component: "message",
            transcriptType: "user_message",
            rawText: userMessageText(item),
            metadata: {
              appServerItemType: itemType,
              clientUserMessageId: clientUserMessageId ?? null
            },
            observationKind,
            projectionStatus: "pending"
          })
        ],
        identityIssues: []
      };
    }
    if (itemType === "agentMessage") {
      return {
        items: [
          canonicalItem({
            event,
            context,
            externalThreadId,
            externalTurnId,
            externalItemId: itemId,
            stableItemId,
            component: "message",
            transcriptType: "agent_message",
            rawText: string(item.text),
            metadata: {
              appServerItemType: itemType,
              phase: string(item.phase) ?? null
            },
            observationKind,
            projectionStatus: completed ? "pending" : "raw_only"
          })
        ],
        identityIssues: []
      };
    }
    if (itemType === "reasoning") {
      const summary = reasoningSummaryText(item);
      return {
        items: [
          canonicalItem({
            event,
            context,
            externalThreadId,
            externalTurnId,
            externalItemId: itemId,
            stableItemId,
            component: "reasoning_summary",
            transcriptType: "reasoning_summary",
            rawText: summary,
            metadata: {
              appServerItemType: itemType,
              rawReasoningRetainedAsProvenance: Array.isArray(item.content)
            },
            observationKind,
            projectionStatus: completed && summary ? "pending" : "raw_only"
          })
        ],
        identityIssues: []
      };
    }
    const rawText = itemType === "plan" ? string(item.text) : undefined;
    return {
      items: [
        canonicalItem({
          event,
          context,
          externalThreadId,
          externalTurnId,
          externalItemId: itemId,
          stableItemId,
          component: "raw",
          transcriptType: itemType,
          rawText,
          metadata: { appServerItemType: itemType },
          observationKind,
          projectionStatus: "pending"
        })
      ],
      identityIssues: []
    };
  }

  if (
    (event.method === "turn/started" || event.method === "turn/completed") &&
    !externalTurnId
  ) {
    return unresolvedBatch({
      event,
      context,
      externalThreadId,
      itemType: "control",
      reason: "turn lifecycle event has no turn identity"
    });
  }

  const controlStableId =
    event.method === "turn/completed" && externalTurnId
      ? `turn:${externalTurnId}:completed`
      : event.method === "turn/started" && externalTurnId
        ? `turn:${externalTurnId}:started`
        : event.method === "thread/started"
          ? `thread:${externalThreadId}:started`
          : `${event.method}:${externalTurnId ?? externalThreadId}`;
  const canonicalControl =
    event.method === "turn/completed" && !!externalTurnId;
  const control = canonicalItem({
    event,
    context,
    externalThreadId,
    externalTurnId,
    stableItemId: controlStableId,
    component: "control",
    transcriptType: event.method,
    metadata: {
      appServerItemType: "control",
      ...(event.method === "turn/completed"
        ? { semanticControl: "turn_completed" }
        : {})
    },
    observationKind: "control",
    projectionStatus: "raw_only",
    canonicalIdentity: canonicalControl,
    snapshotIdentity: !canonicalControl
  });
  return { items: [control], identityIssues: [] };
};
