import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  assertPersonalNoteSourceSelection,
  personalNoteSourceRevisionHash,
  sharedMemorySourceRefSchema
} from "./shared-memory-source.js";
import { sharedSourcePreviewHash } from "./shared-source-artifact.js";

const noteSource = () => ({
  kind: "personal_note" as const,
  noteId: randomUUID(),
  memoryEventId: randomUUID(),
  logicalMemoryId: randomUUID()
});

describe("Shared Memory source binding", () => {
  it("accepts strict Captured Session and Personal Note sources", () => {
    expect(
      sharedMemorySourceRefSchema.parse({
        kind: "captured_session",
        sessionId: randomUUID(),
        logicalMemoryId: randomUUID()
      }).kind
    ).toBe("captured_session");
    expect(sharedMemorySourceRefSchema.parse(noteSource()).kind).toBe(
      "personal_note"
    );
  });

  it("rejects mixed and incomplete source shapes", () => {
    expect(() =>
      sharedMemorySourceRefSchema.parse({
        ...noteSource(),
        sessionId: randomUUID()
      })
    ).toThrow();
    expect(() =>
      sharedMemorySourceRefSchema.parse({
        kind: "personal_note",
        noteId: randomUUID(),
        logicalMemoryId: randomUUID()
      })
    ).toThrow();
  });

  it("fixes Personal Note sharing to one snapshot Memory Event", () => {
    const source = noteSource();
    const valid = {
      source,
      mode: "snapshot" as const,
      representation: "memory_events" as const,
      allowedRepresentations: ["memory_events" as const],
      sourceRevision: 1,
      manifest: [
        { sourceId: source.memoryEventId, revisionHash: "0".repeat(64) }
      ]
    };
    expect(() => assertPersonalNoteSourceSelection(valid)).not.toThrow();
    expect(() =>
      assertPersonalNoteSourceSelection({ ...valid, mode: "continuous" })
    ).toThrow("snapshot mode");
    expect(() =>
      assertPersonalNoteSourceSelection({
        ...valid,
        allowedRepresentations: ["memory_events", "lcm_leaves"]
      })
    ).toThrow("memory_events");
    expect(() =>
      assertPersonalNoteSourceSelection({ ...valid, sourceRevision: 2 })
    ).toThrow("source revision 1");
    expect(() =>
      assertPersonalNoteSourceSelection({
        ...valid,
        manifest: [{ sourceId: randomUUID(), revisionHash: "0".repeat(64) }]
      })
    ).toThrow("one manifest item");
  });

  it("binds source identity into protected artifact previews", () => {
    const source = noteSource();
    const preview = {
      schemaVersion: 1 as const,
      previewId: randomUUID(),
      artifactId: randomUUID(),
      logicalMemoryId: source.logicalMemoryId,
      source,
      representation: "memory_events" as const,
      binding: {
        sourceRevision: 1,
        sourceHash: "1".repeat(64),
        representationPolicyRevision: 1,
        representationPolicyHash: "2".repeat(64),
        contentPolicyVersion: 1,
        contentPolicyHash: "3".repeat(64),
        classifierVersion: 1,
        classifierHash: "4".repeat(64)
      },
      items: [],
      redactedContentHash: "5".repeat(64)
    };

    expect(sharedSourcePreviewHash(preview)).not.toBe(
      sharedSourcePreviewHash({
        ...preview,
        source: { ...source, noteId: randomUUID() }
      })
    );
  });

  it("binds a Personal Note revision to its owner and immutable event", () => {
    const source = noteSource();
    const input = {
      source,
      sourceOwnerPrincipalId: randomUUID(),
      content: "Immutable Note body",
      occurredAt: "2026-08-18T12:00:00.000Z",
      sourceSequence: 7
    };
    const hash = personalNoteSourceRevisionHash(input);
    expect(personalNoteSourceRevisionHash(input)).toBe(hash);
    expect(
      personalNoteSourceRevisionHash({ ...input, content: "Changed" })
    ).not.toBe(hash);
    expect(
      personalNoteSourceRevisionHash({
        ...input,
        sourceOwnerPrincipalId: randomUUID()
      })
    ).not.toBe(hash);
    expect(
      personalNoteSourceRevisionHash({
        ...input,
        source: { ...source, memoryEventId: randomUUID() }
      })
    ).not.toBe(hash);
  });
});
