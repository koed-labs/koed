import { createHash } from "node:crypto";
import { approvalActivityMetadata } from "@koed/shared";
import { approvalReviewTranscriptDisplayFromText } from "@koed/shared/personal-desktop";
import { adaptCodexAppServerConversationEvent } from "./codex-conversation-source-adapter.js";
import type { RawConversationItemRequest } from "./conversation-source-types.js";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

export const isCodexPersistedCompletedItem = (value: unknown): boolean => {
  const raw = record(value);
  return (
    raw?.type === "event_msg" && record(raw.payload)?.type === "item_completed"
  );
};

const itemTypes: Readonly<Record<string, string>> = {
  UserMessage: "userMessage",
  AgentMessage: "agentMessage",
  HookPrompt: "hookPrompt",
  FunctionCallOutput: "functionCallOutput",
  Plan: "plan",
  Reasoning: "reasoning",
  CommandExecution: "commandExecution",
  DynamicToolCall: "dynamicToolCall",
  CollabAgentToolCall: "collabAgentToolCall",
  SubAgentActivity: "subAgentActivity",
  WebSearch: "webSearch",
  ImageView: "imageView",
  ImageGeneration: "imageGeneration",
  EnteredReviewMode: "enteredReviewMode",
  ExitedReviewMode: "exitedReviewMode",
  FileChange: "fileChange",
  McpToolCall: "mcpToolCall",
  ContextCompaction: "contextCompaction"
};

const extensionTypes: Readonly<Record<string, string>> = {
  "clock.sleep": "sleep",
  "image_gen.generation": "imageGeneration",
  "web.search": "webSearch"
};

const durationMs = (value: unknown): number | undefined => {
  const duration = record(value);
  if (!duration) throw new Error("codex_completed_item_invalid_duration");
  const { secs, nanos } = duration;
  if (
    typeof secs !== "number" ||
    !Number.isSafeInteger(secs) ||
    secs < 0 ||
    typeof nanos !== "number" ||
    !Number.isInteger(nanos) ||
    nanos < 0 ||
    nanos >= 1_000_000_000
  )
    throw new Error("codex_completed_item_invalid_duration");
  const result = secs * 1000 + Math.floor(nanos / 1_000_000);
  if (!Number.isSafeInteger(result))
    throw new Error("codex_completed_item_invalid_duration");
  return result;
};

const normalizedItem = (item: RecordValue): RecordValue => {
  const type = text(item.type);
  const publicType =
    type === "Extension"
      ? typeof item.kind === "string" &&
        Object.hasOwn(extensionTypes, item.kind)
        ? extensionTypes[item.kind]
        : undefined
      : type && Object.hasOwn(itemTypes, type)
        ? itemTypes[type]
        : undefined;
  if (!publicType) throw new Error("codex_completed_item_unsupported_type");
  const normalized: RecordValue = { ...item, type: publicType };
  for (const [native, publicName] of [
    ["client_id", "clientId"],
    ["aggregated_output", "aggregatedOutput"],
    ["exit_code", "exitCode"],
    ["content_items", "contentItems"],
    ["receiver_thread_ids", "receiverThreadIds"],
    ["agents_states", "agentsStates"],
    ["agent_thread_id", "agentThreadId"],
    ["agent_path", "agentPath"]
  ] as const) {
    if (item[native] !== undefined) normalized[publicName] = item[native];
  }
  if (type === "AgentMessage") {
    if (
      !Array.isArray(item.content) ||
      item.content.some(
        (entry) =>
          record(entry)?.type !== "Text" ||
          typeof record(entry)?.text !== "string"
      )
    )
      throw new Error("codex_completed_item_invalid_message");
    normalized.text = item.content.map((entry) => record(entry)!.text).join("");
  }
  if (type === "UserMessage") {
    if (
      !Array.isArray(item.content) ||
      item.content.some((entry) => {
        const input = record(entry);
        if (!input || typeof input.type !== "string") return true;
        if (input.type === "text") return typeof input.text !== "string";
        if (["local_image", "local_audio"].includes(input.type))
          return typeof input.path !== "string";
        if (["skill", "mention"].includes(input.type))
          return (
            typeof input.name !== "string" || typeof input.path !== "string"
          );
        if (input.type === "audio") return typeof input.audio_url !== "string";
        if (input.type === "image")
          return (
            typeof input.image_url !== "string" &&
            typeof input.file_id !== "string"
          );
        return true;
      })
    )
      throw new Error("codex_completed_item_invalid_message");
  }
  if (type === "Reasoning") {
    if (
      !Array.isArray(item.summary_text) ||
      item.summary_text.some((entry) => typeof entry !== "string")
    ) {
      throw new Error("codex_completed_item_invalid_reasoning");
    }
    normalized.summary = item.summary_text;
    normalized.content = item.raw_content;
  }
  if (type === "CollabAgentToolCall") {
    const tools: Readonly<Record<string, string>> = {
      spawn_agent: "spawnAgent",
      send_input: "sendInput",
      resume_agent: "resumeAgent",
      wait: "wait",
      close_agent: "closeAgent",
      send_message: "sendMessage",
      followup_task: "followupTask",
      interrupt_agent: "interruptAgent",
      list_agents: "listAgents"
    };
    if (typeof item.tool !== "string" || !Object.hasOwn(tools, item.tool))
      throw new Error("codex_completed_item_invalid_collaboration");
    normalized.tool = tools[item.tool];
    const states =
      item.agents_states === undefined ? {} : record(item.agents_states);
    if (!states) throw new Error("codex_completed_item_invalid_collaboration");
    normalized.agentsStates = Object.fromEntries(
      Object.entries(states).map(([id, state]) => {
        const variant = typeof state === "string" ? state : undefined;
        const message = record(state);
        if (
          variant &&
          [
            "pending_init",
            "running",
            "interrupted",
            "shutdown",
            "not_found"
          ].includes(variant)
        )
          return [
            id,
            {
              status:
                variant === "pending_init"
                  ? "pendingInit"
                  : variant === "not_found"
                    ? "notFound"
                    : variant,
              message: null
            }
          ];
        if (message && Object.keys(message).length === 1) {
          if (
            Object.hasOwn(message, "completed") &&
            (message.completed === null ||
              typeof message.completed === "string")
          )
            return [id, { status: "completed", message: message.completed }];
          if (typeof message.errored === "string")
            return [id, { status: "errored", message: message.errored }];
        }
        throw new Error("codex_completed_item_invalid_collaboration");
      })
    );
  }
  if (normalized.status === "in_progress") normalized.status = "inProgress";
  if (item.duration !== undefined && item.duration !== null)
    normalized.durationMs = durationMs(item.duration);
  return normalized;
};

// Reuse canonical live-item components while retaining the exact persisted envelope.
export const adaptCodexPersistedCompletedItem = (
  source: RawConversationItemRequest,
  threadKind: "conversation" | "subagent"
): RawConversationItemRequest[] => {
  const raw = record(source.rawJson);
  const payload = record(raw?.payload);
  const native = record(payload?.item);
  const threadId = text(payload?.thread_id);
  const turnId = text(payload?.turn_id);
  if (
    !raw ||
    !payload ||
    !native ||
    !threadId ||
    !turnId ||
    threadId !== source.externalThreadId ||
    !text(native.id)
  ) {
    throw new Error("codex_completed_item_identity_mismatch");
  }
  const item = normalizedItem(native);
  for (const key of ["started_at_ms", "completed_at_ms"]) {
    const value = payload[key];
    if (
      value != null &&
      (typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > 8_640_000_000_000_000)
    )
      throw new Error("codex_completed_item_invalid_time");
  }
  const batch = adaptCodexAppServerConversationEvent(
    {
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item,
        startedAtMs: payload.started_at_ms,
        completedAtMs:
          typeof payload.completed_at_ms === "number" &&
          payload.completed_at_ms > 0
            ? payload.completed_at_ms
            : undefined
      },
      observedAt: source.eventTime ?? "1970-01-01T00:00:00.000Z",
      sequence: source.sourceSequence ?? 0
    },
    {
      sessionId: source.sessionId ?? "",
      externalThreadId: threadId,
      nativeUserItemIdentity: true
    }
  );
  if (batch.identityIssues.length)
    throw new Error("codex_completed_item_identity_unresolved");
  return batch.items.map((adapted, index) => {
    const semanticMetadata = { ...adapted.metadata };
    delete semanticMetadata.managedConversation;
    const sourceMetadata = { ...source.metadata };
    // Refine the raw envelope's provisional classification using decoded content.
    if (
      record(sourceMetadata.approvalActivity)?.kind ===
      "approval_helper_conversation"
    )
      delete sourceMetadata.approvalActivity;
    const component = adapted.observationComponent ?? "raw";
    const approvalReviewTranscriptDisplay =
      item.type === "userMessage" && typeof adapted.rawText === "string"
        ? approvalReviewTranscriptDisplayFromText(adapted.rawText)
        : undefined;
    const sourceHash = createHash("sha256")
      .update(
        JSON.stringify({
          raw: source.rawJson,
          component
        })
      )
      .digest("hex");
    return {
      ...source,
      externalTurnId: turnId,
      externalItemId: text(native.id),
      canonicalItemKey: adapted.canonicalItemKey,
      canonicalStableItemId: adapted.canonicalStableItemId,
      observationComponent: component,
      observationKind: "reconciliation",
      canonicalSourcePriority: 200,
      sourceSequence: Math.min(
        2_000_000_000,
        (source.sourceSequence ?? 0) + index
      ),
      sourceHash,
      idempotencyKey: `${source.idempotencyKey}:${component}`,
      rawText: adapted.rawText,
      eventTime: adapted.eventTime ?? source.eventTime,
      projectionStatus: adapted.projectionStatus,
      metadata: approvalActivityMetadata({
        actor:
          item.type === "userMessage"
            ? "user"
            : item.type === "agentMessage"
              ? "agent"
              : undefined,
        content: adapted.rawText,
        metadata: {
          ...sourceMetadata,
          ...semanticMetadata,
          sourceEventTimeAccuracy: adapted.eventTime
            ? "source"
            : source.metadata.sourceEventTimeAccuracy,
          canonicalIdentityBasis: "provider_ids",
          persistedCompletedItem: true,
          threadKind,
          ...(approvalReviewTranscriptDisplay
            ? {
                approvalReviewTranscriptDisplay,
                ...(threadKind === "subagent" ? { approvalReview: true } : {})
              }
            : {}),
          ...(threadKind === "subagent" && item.type === "userMessage"
            ? { transcriptType: "agent_message" }
            : {}),
          ...(threadKind === "subagent" && item.type === "agentMessage"
            ? { transcriptType: "subagent_message" }
            : {})
        }
      })
    };
  });
};
