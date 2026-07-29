import { createHash } from "node:crypto";

export const codexTranscriptAdapterVersion = "codex-transcript-v1";

export interface CodexTranscriptCaptureItem {
  actor: "user" | "assistant" | "agent" | "subagent" | "tool" | "system";
  eventType: string;
  content: string;
  metadata: Record<string, unknown>;
}

export interface CodexTranscriptParsedItem {
  item: CodexTranscriptCaptureItem | null;
  itemDiscriminator: string;
  sourceOffset: number;
}

export interface CodexTranscriptObservation {
  record: unknown;
  sourceLineNumber: number;
  transcriptByteOffset?: number;
  explicitTurnId?: string;
  startsTurn: boolean;
  completesTurn: boolean;
  externalItemId?: string;
  sourceRecordType: string;
  sourceEventType?: string;
  eventTime?: string;
  eventTimeAccuracy:
    | "source"
    | "interpolated_between_sources"
    | "observed_fallback";
  fallbackRawText?: string;
  parsedItems: CodexTranscriptParsedItem[];
}

export interface CodexTranscriptRawItem {
  [key: string]: unknown;
  sourceKind: "codex";
  sourceAdapterVersion: typeof codexTranscriptAdapterVersion;
  sourceTransport: "transcript" | "historical_import";
  sessionId?: string;
  externalSessionId?: string;
  externalThreadId?: string;
  externalTurnId?: string;
  externalItemId?: string;
  sourceRecordType: string;
  sourceEventType?: string;
  sourceLineNumber: number;
  sourceSequence: number;
  eventTime?: string;
  rawJson: unknown;
  rawText?: string;
  sourceHash: string;
  idempotencyKey: string;
  projectionStatus: "pending";
  projectionVersion: typeof codexTranscriptAdapterVersion;
  metadata: Record<string, unknown>;
}

export interface CodexTranscriptAdapterInput {
  observations: CodexTranscriptObservation[];
  sessionId?: string;
  sourceSessionId?: string;
  sourceTransport: "transcript" | "historical_import";
  sourceFingerprint?: string;
  threadKind: "conversation" | "subagent";
  parentThreadId?: string;
}

const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const safeSourceSequence = (value: number): number =>
  Math.max(0, Math.min(value, 2_000_000_000));

export const codexTranscriptRecordHash = (record: unknown): string =>
  hash(record);

export const codexTranscriptItemKey = (input: {
  sourceSessionId: string;
  transcriptPosition: number;
  itemDiscriminator: string;
  recordHash: string;
}): string =>
  `conversation-item:${hash({
    version: 3,
    aiClient: "codex",
    sourceSessionId: input.sourceSessionId,
    transcriptPosition: input.transcriptPosition,
    itemDiscriminator: input.itemDiscriminator,
    recordHash: input.recordHash
  })}`;

const semanticTurnId = (input: {
  sourceSessionId?: string;
  sourceSequence: number;
}): string =>
  `transcript-user-turn:${hash({
    sourceSessionId: input.sourceSessionId,
    sourceSequence: input.sourceSequence
  })}`;

const rawItemsForObservation = (
  observation: CodexTranscriptObservation
): CodexTranscriptParsedItem[] =>
  observation.parsedItems.length > 0
    ? observation.parsedItems
    : [{ item: null, itemDiscriminator: "raw", sourceOffset: 0 }];

const observationMetadata = (input: {
  adapter: CodexTranscriptAdapterInput;
  observation: CodexTranscriptObservation;
  parsed: CodexTranscriptParsedItem;
  assignedTurnId?: string;
}): Record<string, unknown> => ({
  ...(input.parsed.item?.metadata ?? {}),
  ...(input.observation.transcriptByteOffset === undefined
    ? {}
    : { transcriptByteOffset: input.observation.transcriptByteOffset }),
  transcriptSourceLineNumber: input.observation.sourceLineNumber,
  transcriptItemDiscriminator: input.parsed.itemDiscriminator,
  sourceEventTimeAccuracy: input.observation.eventTimeAccuracy,
  ...(input.assignedTurnId
    ? { transcriptAssignedTurnId: input.assignedTurnId }
    : {}),
  threadKind: input.adapter.threadKind,
  parentThreadId: input.adapter.parentThreadId,
  ...(input.adapter.sourceTransport === "historical_import"
    ? { observedViaHistoricalImport: true }
    : { observedViaTranscript: true }),
  ...(input.adapter.sourceFingerprint
    ? { sourceFingerprint: input.adapter.sourceFingerprint }
    : {})
});

const rawItemForObservation = (input: {
  adapter: CodexTranscriptAdapterInput;
  observation: CodexTranscriptObservation;
  parsed: CodexTranscriptParsedItem;
  assignedTurnId?: string;
  recordHash: string;
  position: number;
}): CodexTranscriptRawItem => {
  const itemDiscriminator = input.parsed.itemDiscriminator;
  return {
    sourceKind: "codex",
    sourceAdapterVersion: codexTranscriptAdapterVersion,
    sourceTransport: input.adapter.sourceTransport,
    sessionId: input.adapter.sessionId,
    externalSessionId: input.adapter.sourceSessionId,
    externalThreadId: input.adapter.sourceSessionId,
    externalTurnId: input.assignedTurnId,
    externalItemId: input.observation.externalItemId,
    sourceRecordType: input.observation.sourceRecordType,
    sourceEventType: input.observation.sourceEventType,
    sourceLineNumber: input.observation.sourceLineNumber,
    sourceSequence: safeSourceSequence(
      input.position * 2 + input.parsed.sourceOffset
    ),
    eventTime: input.observation.eventTime,
    rawJson: input.observation.record,
    rawText: input.parsed.item?.content ?? input.observation.fallbackRawText,
    sourceHash: hash({ recordHash: input.recordHash, itemDiscriminator }),
    idempotencyKey: codexTranscriptItemKey({
      sourceSessionId: input.adapter.sourceSessionId ?? "unknown-session",
      transcriptPosition: input.position,
      itemDiscriminator,
      recordHash: input.recordHash
    }),
    projectionStatus: "pending",
    projectionVersion: codexTranscriptAdapterVersion,
    metadata: observationMetadata(input)
  };
};

const observationItems = (input: {
  adapter: CodexTranscriptAdapterInput;
  observation: CodexTranscriptObservation;
  assignedTurnId?: string;
}): CodexTranscriptRawItem[] => {
  const recordHash = codexTranscriptRecordHash(input.observation.record);
  const position =
    input.observation.transcriptByteOffset ??
    input.observation.sourceLineNumber;
  const parsedItems = rawItemsForObservation(input.observation);
  return parsedItems.map((parsed) =>
    rawItemForObservation({
      ...input,
      parsed,
      recordHash,
      position
    })
  );
};

export const adaptCodexTranscriptV1 = (
  input: CodexTranscriptAdapterInput
): CodexTranscriptRawItem[] => {
  const items: CodexTranscriptRawItem[] = [];
  let activeTranscriptTurnId: string | undefined;
  let activeSemanticTurnId: string | undefined;

  for (const observation of input.observations) {
    const position =
      observation.transcriptByteOffset ?? observation.sourceLineNumber;
    const sourceSequenceBase = safeSourceSequence(position * 2);
    if (observation.explicitTurnId && observation.startsTurn) {
      activeTranscriptTurnId = observation.explicitTurnId;
      activeSemanticTurnId = observation.explicitTurnId;
    }
    const hasUserPrompt = observation.parsedItems.some(
      (parsed) => parsed.item?.actor === "user"
    );
    if (
      hasUserPrompt &&
      !observation.explicitTurnId &&
      !activeTranscriptTurnId
    ) {
      activeSemanticTurnId = semanticTurnId({
        sourceSessionId: input.sourceSessionId,
        sourceSequence: sourceSequenceBase
      });
    }
    const assignedTurnId =
      observation.explicitTurnId ??
      activeTranscriptTurnId ??
      activeSemanticTurnId;
    items.push(
      ...observationItems({ adapter: input, observation, assignedTurnId })
    );
    if (
      observation.explicitTurnId &&
      observation.completesTurn &&
      activeTranscriptTurnId === observation.explicitTurnId
    ) {
      activeTranscriptTurnId = undefined;
      activeSemanticTurnId = undefined;
    }
  }
  return items;
};
