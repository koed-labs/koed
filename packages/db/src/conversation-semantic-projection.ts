import { chunkTextForModel, estimateTokens } from "@koed/core";
import type { MemoryActor } from "@koed/core";
import type { Visibility } from "./types.js";
import { isRecord } from "./value-helpers.js";

export type ConversationSemanticUnitType = "user_turn" | "agent_turn";

export type ConversationSemanticProjectionRow = {
  id: string;
  owner_user_id: string | null;
  visibility: Visibility;
  session_id: string | null;
  turn_id: string | null;
  source_kind: string;
  metadata: Record<string, unknown> | null;
  source_transport: string;
  source_path: string | null;
  source_event_type: string | null;
  source_record_type: string;
  source_sequence: number | null;
  event_time: Date | null;
  observed_at: Date;
  raw_json: unknown;
  source_adapter_version: string;
  external_session_id: string | null;
  external_thread_id: string | null;
  external_turn_id: string | null;
  external_item_id: string | null;
  raw_text: string | null;
  logical_source_id: string | null;
  transport_chunk_index: number;
  transport_chunk_count: number;
  transport_chunk_text: string | null;
  transport_chunk_encoding: string | null;
  source_hash: string;
  idempotency_key: string;
  session_workspace_id: string | null;
  session_cwd: string | null;
  session_metadata: Record<string, unknown> | null;
};

export type ConversationSemanticProjectionItem = {
  row: ConversationSemanticProjectionRow;
  sourceIds: string[];
  sourceIdentity: string;
  sourceHash: string;
  actorType: MemoryActor;
  content: string;
  includeInLcm: boolean;
  projectionMetadata: Record<string, unknown>;
};

export type ConversationSemanticProjectionItemManifest = {
  sourceIds: string[];
  sourceIdentity: string;
  sourceHash: string;
  actor: MemoryActor;
  kind: string;
  toolName?: string;
  toolCallId?: string;
  toolEventKind?: string;
  sourceSequence: number | null;
  sourceEventTime: string | null;
  offsetStart: number;
  offsetEnd: number;
  itemSplitIndex?: number;
  itemSplitCount?: number;
  itemSplitReason?: "embedding_token_limit";
  originalItemTokenCount?: number;
};

export type ConversationSemanticProjectionChunk = {
  content: string;
  tokenCount: number;
  chunkIndex: number;
  chunkCount: number;
  sourceIds: string[];
  sourceIdentities: string[];
  sourceHashes: string[];
  sourceEventTime: Date | null;
  sourceSequence: number | null;
  itemManifest: ConversationSemanticProjectionItemManifest[];
};

export type SemanticBundleSealReason =
  | "user_turn"
  | "next_user_turn"
  | "token_limit"
  | "stop_hook"
  | "catch_up_stale";

export type ConversationSemanticProjectionGroup = {
  unitType: ConversationSemanticUnitType;
  items: ConversationSemanticProjectionItem[];
};

export type PendingAgentSemanticBundle = {
  items: ConversationSemanticProjectionItem[];
};

const stringField = (
  value: Record<string, unknown>,
  key: string
): string | null => {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field : null;
};

const projectionIsRawReasoningLabel = (label: string): boolean =>
  /reasoning[_/ -]?raw|raw[_/ -]?reasoning|raw[_/ -]?content|reasoningTextDelta|ReasoningTextDelta|reasoning[_/ -]?text[_/ -]?delta|ReasoningRawContent|ReasoningRawContentDelta/i.test(
    label
  );

const projectionIsReasoningLabel = (label: string): boolean =>
  /reasoning|thought/i.test(label);

const projectionIsReasoningSummaryLabel = (label: string): boolean =>
  projectionIsReasoningLabel(label) && !projectionIsRawReasoningLabel(label);

export const conversationSemanticUnitTypeForActor = (
  actorType: MemoryActor | null
): ConversationSemanticUnitType | null => {
  if (actorType === "user") {
    return "user_turn";
  }
  if (
    actorType === "agent" ||
    actorType === "assistant" ||
    actorType === "subagent" ||
    actorType === "tool"
  ) {
    return "agent_turn";
  }
  return null;
};

export const uniqueOrderedStrings = (values: Iterable<string>): string[] => {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      ordered.push(value);
    }
  }
  return ordered;
};

export const joinedSemanticContentTokenCount = (
  contents: string[],
  model?: string | null
): number =>
  estimateTokens(contents.join("\n\n"), {
    model: model ?? "gpt-5.4-mini"
  });

export const conversationSemanticItemKind = (
  item: ConversationSemanticProjectionItem
): string => {
  const metadata = item.row.metadata ?? {};
  const toolCall = isRecord(metadata.toolCall) ? metadata.toolCall : {};
  const transcriptType = stringField(metadata, "transcriptType");
  const toolEventKind =
    stringField(metadata, "toolEventKind") ??
    stringField(toolCall, "kind") ??
    transcriptType ??
    item.row.source_event_type ??
    item.row.source_record_type;
  if (item.actorType === "tool") {
    return /output|result/i.test(toolEventKind ?? "")
      ? "tool_result"
      : "tool_call";
  }
  if (transcriptType && projectionIsReasoningSummaryLabel(transcriptType)) {
    return "reasoning_summary";
  }
  if (/reasoning|thought/i.test(transcriptType ?? "")) {
    return "reasoning_summary";
  }
  if (item.actorType === "subagent") {
    return "subagent_message";
  }
  if (item.actorType === "agent" || item.actorType === "assistant") {
    return /final/i.test(transcriptType ?? "")
      ? "final_message"
      : "agent_message";
  }
  return (
    transcriptType ?? item.row.source_event_type ?? item.row.source_record_type
  );
};

export const conversationSemanticItemManifest = (
  item: ConversationSemanticProjectionItem,
  offsetStart: number,
  offsetEnd: number
): ConversationSemanticProjectionItemManifest => {
  const metadata = item.row.metadata ?? {};
  const toolCall = isRecord(metadata.toolCall) ? metadata.toolCall : {};
  const toolName =
    stringField(metadata, "toolName") ??
    stringField(toolCall, "name") ??
    stringField(toolCall, "title");
  const toolCallId =
    stringField(metadata, "toolCallId") ??
    stringField(metadata, "callId") ??
    stringField(toolCall, "id");
  const toolEventKind =
    stringField(metadata, "toolEventKind") ?? stringField(toolCall, "kind");

  return {
    sourceIds: item.sourceIds,
    sourceIdentity: item.sourceIdentity,
    sourceHash: item.sourceHash,
    actor: item.actorType,
    kind: conversationSemanticItemKind(item),
    ...(toolName ? { toolName } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolEventKind ? { toolEventKind } : {}),
    sourceSequence: item.row.source_sequence,
    sourceEventTime: item.row.event_time?.toISOString() ?? null,
    offsetStart,
    offsetEnd
  };
};

export const conversationSemanticUnitChunks = (
  items: ConversationSemanticProjectionItem[],
  input: {
    model?: string | null;
    maxTokens: number;
    hardMaxTokens: number;
  }
): ConversationSemanticProjectionChunk[] => {
  type PendingSegment = {
    item: ConversationSemanticProjectionItem;
    content: string;
    sourceIds: string[];
    sourceIdentity: string;
    sourceHash: string;
    sourceEventTime: Date | null;
    sourceSequence: number | null;
  };

  const { model, maxTokens, hardMaxTokens } = input;
  const chunks: Omit<
    ConversationSemanticProjectionChunk,
    "chunkIndex" | "chunkCount"
  >[] = [];
  let pendingSegments: PendingSegment[] = [];

  const flushPending = () => {
    if (pendingSegments.length === 0) {
      return;
    }
    let offset = 0;
    const itemManifest: ConversationSemanticProjectionItemManifest[] = [];
    for (const [index, segment] of pendingSegments.entries()) {
      if (index > 0) {
        offset += 2;
      }
      const offsetStart = offset;
      const offsetEnd = offsetStart + segment.content.length;
      itemManifest.push(
        conversationSemanticItemManifest(segment.item, offsetStart, offsetEnd)
      );
      offset = offsetEnd;
    }
    const content = pendingSegments
      .map((segment) => segment.content)
      .join("\n\n");
    chunks.push({
      content,
      tokenCount: estimateTokens(content, {
        model: model ?? "gpt-5.4-mini"
      }),
      sourceIds: uniqueOrderedStrings(
        pendingSegments.flatMap((segment) => segment.sourceIds)
      ),
      sourceIdentities: uniqueOrderedStrings(
        pendingSegments.map((segment) => segment.sourceIdentity)
      ),
      sourceHashes: uniqueOrderedStrings(
        pendingSegments.map((segment) => segment.sourceHash)
      ),
      sourceEventTime:
        pendingSegments
          .map((segment) => segment.sourceEventTime)
          .filter((value): value is Date => value instanceof Date)
          .sort((left, right) => left.getTime() - right.getTime())[0] ?? null,
      sourceSequence: (() => {
        const minSourceSequence = pendingSegments
          .map((segment) => segment.sourceSequence)
          .filter((value): value is number => typeof value === "number")
          .sort((left, right) => left - right)[0];
        return typeof minSourceSequence === "number"
          ? minSourceSequence * 1_000_000
          : null;
      })(),
      itemManifest
    });
    pendingSegments = [];
  };

  for (const item of items) {
    const segment: PendingSegment = {
      item,
      content: item.content,
      sourceIds: item.sourceIds,
      sourceIdentity: item.sourceIdentity,
      sourceHash: item.sourceHash,
      sourceEventTime: item.row.event_time,
      sourceSequence: item.row.source_sequence
    };
    const segmentTokens = estimateTokens(segment.content, {
      model: model ?? "gpt-5.4-mini"
    });

    if (segmentTokens > hardMaxTokens) {
      flushPending();
      const splitChunks = chunkTextForModel(segment.content, {
        model: model ?? "gpt-5.4-mini",
        maxTokens: hardMaxTokens,
        overlapTokens: 100
      });
      const effectiveSplitChunks =
        splitChunks.length > 0 ? splitChunks : [segment.content];
      effectiveSplitChunks.forEach((splitContent, splitIndex) => {
        chunks.push({
          content: splitContent,
          tokenCount: estimateTokens(splitContent, {
            model: model ?? "gpt-5.4-mini"
          }),
          sourceIds: segment.sourceIds,
          sourceIdentities: [segment.sourceIdentity],
          sourceHashes: [segment.sourceHash],
          sourceEventTime: segment.sourceEventTime,
          sourceSequence:
            typeof segment.sourceSequence === "number"
              ? segment.sourceSequence * 1_000_000 + splitIndex
              : splitIndex,
          itemManifest: [
            {
              ...conversationSemanticItemManifest(item, 0, splitContent.length),
              itemSplitIndex: splitIndex,
              itemSplitCount: effectiveSplitChunks.length,
              itemSplitReason: "embedding_token_limit",
              originalItemTokenCount: segmentTokens
            }
          ]
        });
      });
      continue;
    }

    if (
      pendingSegments.length > 0 &&
      joinedSemanticContentTokenCount(
        [...pendingSegments.map((pending) => pending.content), segment.content],
        model
      ) > maxTokens
    ) {
      flushPending();
    }

    pendingSegments.push(segment);
  }

  flushPending();
  const effectiveChunks =
    chunks.length > 0
      ? chunks
      : [
          {
            content: "",
            tokenCount: 0,
            sourceIds: [],
            sourceIdentities: [],
            sourceHashes: [],
            sourceEventTime: null,
            sourceSequence: null,
            itemManifest: []
          }
        ];

  return effectiveChunks.map((chunk, index) => ({
    ...chunk,
    chunkIndex: index,
    chunkCount: effectiveChunks.length
  }));
};

export const conversationSemanticUnitActor = (
  unitType: ConversationSemanticUnitType,
  sourceActors: string[]
): MemoryActor => {
  if (unitType === "user_turn") {
    return "user";
  }
  if (sourceActors.length === 1 && sourceActors[0] === "tool") {
    return "tool";
  }
  if (sourceActors.length === 1 && sourceActors[0] === "subagent") {
    return "subagent";
  }
  return "agent";
};

export const conversationSemanticProjectionGroups = (
  unitType: ConversationSemanticUnitType,
  items: ConversationSemanticProjectionItem[]
): ConversationSemanticProjectionGroup[] => {
  if (unitType === "agent_turn") {
    let lastNonToolIndex = -1;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      if (items[index]?.actorType !== "tool") {
        lastNonToolIndex = index;
        break;
      }
    }
    if (lastNonToolIndex >= 0 && lastNonToolIndex < items.length - 1) {
      const trailingTools = items.slice(lastNonToolIndex + 1);
      if (
        trailingTools.every(
          (item) => conversationSemanticItemKind(item) === "tool_call"
        )
      ) {
        return [
          { unitType, items: items.slice(0, lastNonToolIndex + 1) },
          { unitType, items: trailingTools }
        ].filter((group) => group.items.length > 0);
      }
    }
  }
  return items.length > 0 ? [{ unitType, items }] : [];
};

export const conversationSemanticEventMetadata = (input: {
  first: ConversationSemanticProjectionItem;
  chunk: ConversationSemanticProjectionChunk;
  allSourceIds: string[];
  sourceActors: string[];
  unitType: ConversationSemanticUnitType;
  sealedReason: string;
  includeInLcm: boolean;
  projectionVersion: string;
  model?: string | null;
  rebuild?: {
    reason: "source_event_deleted";
    memoryEventId: string;
  };
}): Record<string, unknown> => ({
  ...input.first.projectionMetadata,
  rawConversationItemId: input.chunk.sourceIds[0] ?? input.allSourceIds[0],
  rawConversationItemIds: input.chunk.sourceIds,
  logicalSourceId: input.chunk.sourceIdentities[0],
  logicalSourceIds: input.chunk.sourceIdentities,
  projectionVersion: input.projectionVersion,
  semanticUnitType: input.unitType,
  semanticSourceActors: input.sourceActors,
  semanticBundleSealedReason: input.sealedReason,
  includeInLcm: input.includeInLcm,
  ...(input.rebuild
    ? {
        semanticBundleRebuildReason: input.rebuild.reason,
        semanticBundleRebuiltFromMemoryEventId: input.rebuild.memoryEventId
      }
    : {}),
  tokenCount: input.chunk.tokenCount,
  tokenModel: input.model ?? undefined,
  semanticItemManifest: input.chunk.itemManifest,
  sourceAdapterVersion: input.first.row.source_adapter_version,
  sourceChunkIndex: input.chunk.chunkIndex,
  sourceChunkCount: input.chunk.chunkCount,
  sourceItemCount: input.allSourceIds.length,
  externalSessionId: input.first.row.external_session_id,
  externalThreadId: input.first.row.external_thread_id,
  externalTurnId: input.first.row.external_turn_id
});
