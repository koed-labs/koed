import { z } from "zod";
import {
  crossIdentitySyncDeterministicUuid,
  crossIdentitySyncDigest
} from "./cross-identity-sync.js";
import type { SharedMemoryFidelityCeiling } from "./shared-memory-fidelity.js";

export const sharedMemorySourceKinds = [
  "captured_session",
  "personal_note"
] as const;

const capturedSessionSourceSchema = z
  .object({
    kind: z.literal("captured_session"),
    sessionId: z.uuid(),
    logicalMemoryId: z.uuid()
  })
  .strict();

const personalNoteSourceSchema = z
  .object({
    kind: z.literal("personal_note"),
    noteId: z.uuid(),
    noteRevision: z.number().int().safe().positive(),
    memoryEventId: z.uuid(),
    logicalMemoryId: z.uuid()
  })
  .strict();

export const sharedMemorySourceRefSchema = z.discriminatedUnion("kind", [
  capturedSessionSourceSchema,
  personalNoteSourceSchema
]);

export type SharedMemorySourceRef = z.infer<typeof sharedMemorySourceRefSchema>;

export interface LogicalMemorySourceRevisionIdentity {
  id: string;
  genericRevision: number;
  bindingHash: string;
}

export const logicalMemorySourceRevisionIdentity = (input: {
  source: SharedMemorySourceRef;
  ownerPrincipalId: string;
  sourceRevision: number;
}): LogicalMemorySourceRevisionIdentity => {
  if (
    !Number.isSafeInteger(input.sourceRevision) ||
    input.sourceRevision < 0 ||
    (input.source.kind === "personal_note" && input.sourceRevision === 0)
  ) {
    throw new TypeError(
      "Shared Memory source revision is outside the supported range"
    );
  }
  const genericRevision =
    input.source.kind === "captured_session"
      ? input.sourceRevision + 1
      : input.sourceRevision;
  const bindingHash = crossIdentitySyncDigest({
    kind: "logical_memory_source_revision_binding",
    version: 1,
    source: input.source,
    ownerPrincipalId: input.ownerPrincipalId,
    genericRevision,
    sourceRevision: input.sourceRevision
  });
  return {
    id: crossIdentitySyncDeterministicUuid({
      kind: "logical_memory_source_revision",
      logicalMemoryId: input.source.logicalMemoryId,
      ownerPrincipalId: input.ownerPrincipalId,
      revision: genericRevision,
      bindingHash
    }),
    genericRevision,
    bindingHash
  };
};

export const sharedMemorySourceCanReplace = (
  current: SharedMemorySourceRef | undefined,
  replacement: SharedMemorySourceRef
): boolean => {
  if (!current || current.kind !== replacement.kind) return false;
  if (current.kind === "captured_session") {
    return (
      replacement.kind === "captured_session" &&
      current.sessionId === replacement.sessionId &&
      current.logicalMemoryId === replacement.logicalMemoryId
    );
  }
  return (
    replacement.kind === "personal_note" &&
    current.noteId === replacement.noteId &&
    current.memoryEventId !== replacement.memoryEventId &&
    current.logicalMemoryId === replacement.logicalMemoryId &&
    replacement.noteRevision > current.noteRevision
  );
};

export const personalNoteSourceRevisionHash = (input: {
  source: Extract<SharedMemorySourceRef, { kind: "personal_note" }>;
  sourceOwnerPrincipalId: string;
  content: string;
  occurredAt: string;
  sourceSequence: number;
}): string =>
  crossIdentitySyncDigest({
    kind: "personal_note_source_revision",
    version: 1,
    source: input.source,
    sourceOwnerPrincipalId: input.sourceOwnerPrincipalId,
    sourceRevision: input.source.noteRevision,
    memoryEvent: {
      id: input.source.memoryEventId,
      content: input.content,
      occurredAt: input.occurredAt,
      sourceSequence: input.sourceSequence
    }
  });

export const capturedSessionSourceFrontierHash = (input: {
  source: Extract<SharedMemorySourceRef, { kind: "captured_session" }>;
  representation: SharedMemoryRepresentationCapability;
  sourceCursor: number;
  manifestHash: string;
  sourceContentHash: string;
}): string => {
  if (!Number.isSafeInteger(input.sourceCursor) || input.sourceCursor < 0) {
    throw new TypeError("Captured Session source cursor must be non-negative");
  }
  return crossIdentitySyncDigest({
    kind: "captured_session_source_frontier",
    version: 1,
    source: input.source,
    genericRevision: input.sourceCursor + 1,
    sourceCursor: input.sourceCursor,
    representation: input.representation,
    manifestHash: input.manifestHash,
    sourceContentHash: input.sourceContentHash
  });
};

export interface SharedMemorySourceSelection {
  source: SharedMemorySourceRef;
  mode: "snapshot" | "continuous";
  sourceCapabilities: SharedMemoryRepresentationCapability[];
  activationRepresentation: SharedMemoryRepresentationCapability;
  maximumFidelity: SharedMemoryFidelityCeiling;
  includeCuratedMemory: boolean;
  sourceRevision: number;
  manifest: Array<{ sourceId: string; revisionHash: string }>;
}

export type SharedMemoryRepresentationCapability =
  | SharedMemoryFidelityCeiling
  | "curated_assertions";

export const personalNoteSourceSelectionIssues = (
  input: SharedMemorySourceSelection
): string[] => {
  if (input.source.kind !== "personal_note") return [];
  const issues: string[] = [];
  if (
    input.sourceCapabilities.length !== 1 ||
    input.sourceCapabilities[0] !== "memory_events"
  ) {
    issues.push(
      "Personal Note source capabilities must contain only memory_events"
    );
  }
  if (
    input.activationRepresentation !== "memory_events" ||
    input.maximumFidelity !== "memory_events" ||
    input.includeCuratedMemory
  ) {
    issues.push(
      "Personal Note sharing requires Memory Event activation and consent"
    );
  }
  if (input.sourceRevision !== input.source.noteRevision) {
    issues.push(
      "Personal Note source revision must match the selected revision"
    );
  }
  if (
    input.manifest.length !== 1 ||
    input.manifest[0]?.sourceId !== input.source.memoryEventId
  ) {
    issues.push(
      "Personal Note sharing requires one manifest item for its Memory Event"
    );
  }
  return issues;
};

export const assertPersonalNoteSourceSelection = (
  input: SharedMemorySourceSelection
): void => {
  const [issue] = personalNoteSourceSelectionIssues(input);
  if (issue) throw new TypeError(issue);
};
