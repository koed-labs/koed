import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  createSharedMemoryCandidatePreviewSchema,
  createSharedMemoryShareBundleSchema
} from "./schemas.js";

const authority = {
  action: "workspace.memory.share_owned" as const,
  source: "device_action_grant" as const,
  referenceId: randomUUID()
};

const personalNoteCandidate = () => {
  const logicalMemoryId = randomUUID();
  const memoryEventId = randomUUID();
  return {
    source: {
      kind: "personal_note" as const,
      noteId: randomUUID(),
      memoryEventId,
      logicalMemoryId
    },
    logicalMemoryId,
    candidateHash: "a".repeat(64),
    sourceRevision: 1,
    itemCount: 1,
    excludedItemCount: 0,
    manifest: [{ sourceId: memoryEventId, revisionHash: "b".repeat(64) }],
    byteCount: 100,
    teamId: randomUUID(),
    teamWorkspaceId: randomUUID(),
    representation: "memory_events" as const,
    allowedRepresentations: ["memory_events" as const],
    mode: "snapshot" as const,
    authority
  };
};

describe("Shared Memory source schemas", () => {
  it("accepts a fixed one-event Personal Note candidate", () => {
    expect(
      createSharedMemoryCandidatePreviewSchema.parse(personalNoteCandidate())
        .source?.kind
    ).toBe("personal_note");
  });

  it("rejects invalid Personal Note selection and source bindings", () => {
    const candidate = personalNoteCandidate();
    expect(() =>
      createSharedMemoryCandidatePreviewSchema.parse({
        ...candidate,
        mode: "continuous"
      })
    ).toThrow("snapshot mode");
    expect(() =>
      createSharedMemoryCandidatePreviewSchema.parse({
        ...candidate,
        source: {
          ...candidate.source,
          logicalMemoryId: randomUUID()
        }
      })
    ).toThrow("logical Memory");
    expect(() =>
      createSharedMemoryCandidatePreviewSchema.parse({
        ...candidate,
        manifest: [{ sourceId: randomUUID(), revisionHash: "b".repeat(64) }]
      })
    ).toThrow("one manifest item");
  });

  it("rejects legacy candidates and mixed strict sources", () => {
    const candidate = personalNoteCandidate();
    const { source, ...legacy } = candidate;
    expect(source).toEqual(candidate.source);
    expect(() =>
      createSharedMemoryCandidatePreviewSchema.parse(legacy)
    ).toThrow();
    expect(() =>
      createSharedMemoryCandidatePreviewSchema.parse({
        ...candidate,
        source: { ...candidate.source, sessionId: randomUUID() }
      })
    ).toThrow();
  });

  it("fixes Personal Note share bundles to snapshot memory_events", () => {
    const candidate = personalNoteCandidate();
    const bundle = {
      source: candidate.source,
      mutationId: randomUUID(),
      logicalGrantId: randomUUID(),
      consentId: randomUUID(),
      logicalMemoryId: candidate.logicalMemoryId,
      teamId: candidate.teamId,
      teamWorkspaceId: candidate.teamWorkspaceId,
      preview: { previewId: randomUUID(), previewHash: "c".repeat(64) },
      previewRevision: 1,
      mode: "snapshot" as const,
      allowedRepresentations: ["memory_events" as const],
      selectedRepresentation: "memory_events" as const,
      authority
    };
    expect(createSharedMemoryShareBundleSchema.parse(bundle).source?.kind).toBe(
      "personal_note"
    );
    expect(() =>
      createSharedMemoryShareBundleSchema.parse({
        ...bundle,
        allowedRepresentations: ["memory_events", "lcm_leaves"]
      })
    ).toThrow("memory_events");
  });
});
