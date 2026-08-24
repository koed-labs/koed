import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  assertPersonalNoteSourceSelection,
  capturedSessionSourceFrontierHash,
  logicalMemorySourceRevisionIdentity,
  personalNoteSourceRevisionHash,
  sharedMemorySourceCanReplace,
  sharedMemorySourceRefSchema
} from "./shared-memory-source.js";
import { sharedSourcePreviewHash } from "./shared-source-artifact.js";

const noteSource = () => ({
  kind: "personal_note" as const,
  noteId: randomUUID(),
  noteRevision: 1,
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
    expect(() =>
      sharedMemorySourceRefSchema.parse({
        kind: "unsupported_source",
        sourceId: randomUUID(),
        logicalMemoryId: randomUUID()
      })
    ).toThrow();
  });

  it("allows only identical Captured Sessions or a newer revision of the same Personal Note", () => {
    const session = {
      kind: "captured_session" as const,
      sessionId: randomUUID(),
      logicalMemoryId: randomUUID()
    };
    expect(sharedMemorySourceCanReplace(session, session)).toBe(true);
    expect(
      sharedMemorySourceCanReplace(session, {
        ...session,
        sessionId: randomUUID()
      })
    ).toBe(false);

    const note = noteSource();
    const newer = {
      ...note,
      noteRevision: note.noteRevision + 1,
      memoryEventId: randomUUID()
    };
    expect(sharedMemorySourceCanReplace(note, newer)).toBe(true);
    expect(sharedMemorySourceCanReplace(note, note)).toBe(false);
    expect(
      sharedMemorySourceCanReplace(note, { ...newer, noteId: randomUUID() })
    ).toBe(false);
    expect(
      sharedMemorySourceCanReplace(note, {
        ...newer,
        logicalMemoryId: randomUUID()
      })
    ).toBe(false);
  });

  it("fixes Personal Note sharing to one selected Memory Event revision", () => {
    const source = noteSource();
    const valid = {
      source,
      mode: "snapshot" as const,
      sourceCapabilities: ["memory_events" as const],
      activationRepresentation: "memory_events" as const,
      maximumFidelity: "memory_events" as const,
      includeCuratedMemory: false,
      sourceRevision: 1,
      manifest: [
        { sourceId: source.memoryEventId, revisionHash: "0".repeat(64) }
      ]
    };
    expect(() => assertPersonalNoteSourceSelection(valid)).not.toThrow();
    expect(() =>
      assertPersonalNoteSourceSelection({ ...valid, mode: "continuous" })
    ).not.toThrow();
    expect(() =>
      assertPersonalNoteSourceSelection({
        ...valid,
        sourceCapabilities: ["memory_events", "lcm_leaves"]
      })
    ).toThrow("memory_events");
    expect(() =>
      assertPersonalNoteSourceSelection({ ...valid, sourceRevision: 2 })
    ).toThrow("selected revision");
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
      sourceContentHash: "5".repeat(64)
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

  it("binds a Captured Session frontier to its cursor and semantic content", () => {
    const source = {
      kind: "captured_session" as const,
      sessionId: randomUUID(),
      logicalMemoryId: randomUUID()
    };
    const input = {
      source,
      representation: "memory_events" as const,
      sourceCursor: 0,
      manifestHash: "1".repeat(64),
      sourceContentHash: "2".repeat(64)
    };
    const hash = capturedSessionSourceFrontierHash(input);
    expect(capturedSessionSourceFrontierHash(input)).toBe(hash);
    expect(
      capturedSessionSourceFrontierHash({ ...input, sourceCursor: 1 })
    ).not.toBe(hash);
    expect(
      capturedSessionSourceFrontierHash({
        ...input,
        sourceContentHash: "3".repeat(64)
      })
    ).not.toBe(hash);
    expect(() =>
      capturedSessionSourceFrontierHash({ ...input, sourceCursor: -1 })
    ).toThrow("non-negative");
  });

  it("derives one canonical identity for each exact source revision", () => {
    const ownerPrincipalId = randomUUID();
    const sessionSource = {
      kind: "captured_session" as const,
      sessionId: randomUUID(),
      logicalMemoryId: randomUUID()
    };
    const cursorZero = logicalMemorySourceRevisionIdentity({
      source: sessionSource,
      ownerPrincipalId,
      sourceRevision: 0
    });
    expect(cursorZero.genericRevision).toBe(1);
    expect(
      logicalMemorySourceRevisionIdentity({
        source: sessionSource,
        ownerPrincipalId,
        sourceRevision: 0
      })
    ).toEqual(cursorZero);
    expect(
      logicalMemorySourceRevisionIdentity({
        source: sessionSource,
        ownerPrincipalId,
        sourceRevision: 1
      }).id
    ).not.toBe(cursorZero.id);

    const note = noteSource();
    expect(
      logicalMemorySourceRevisionIdentity({
        source: note,
        ownerPrincipalId,
        sourceRevision: note.noteRevision
      }).genericRevision
    ).toBe(note.noteRevision);
    expect(() =>
      logicalMemorySourceRevisionIdentity({
        source: note,
        ownerPrincipalId,
        sourceRevision: 0
      })
    ).toThrow("outside the supported range");
  });
});
