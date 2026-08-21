import { z } from "zod";
import { crossIdentitySyncDigest } from "./cross-identity-sync.js";
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
    memoryEventId: z.uuid(),
    logicalMemoryId: z.uuid()
  })
  .strict();

export const sharedMemorySourceRefSchema = z.discriminatedUnion("kind", [
  capturedSessionSourceSchema,
  personalNoteSourceSchema
]);

export type SharedMemorySourceRef = z.infer<typeof sharedMemorySourceRefSchema>;

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
    sourceRevision: 1,
    memoryEvent: {
      id: input.source.memoryEventId,
      content: input.content,
      occurredAt: input.occurredAt,
      sourceSequence: input.sourceSequence
    }
  });

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
  if (input.mode !== "snapshot") {
    issues.push("Personal Note sharing requires snapshot mode");
  }
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
  if (input.sourceRevision !== 1) {
    issues.push("Personal Note sharing requires source revision 1");
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
