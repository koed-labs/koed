import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  changeSharedMemoryFidelityBundleSchema,
  createSharedMemoryCandidatePreviewSchema,
  createPendingShareSchema
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
    sourceDeploymentProtocolId: randomUUID(),
    sourceOwnerPrincipalId: randomUUID(),
    source: {
      kind: "personal_note" as const,
      noteId: randomUUID(),
      noteRevision: 1,
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
    sourceCapabilities: ["memory_events" as const],
    activationRepresentation: "memory_events" as const,
    maximumFidelity: "memory_events" as const,
    includeCuratedMemory: false,
    mode: "snapshot" as const,
    authority
  };
};

describe("Shared Memory source schemas", () => {
  it("accepts snapshot and continuous one-event Personal Note candidates", () => {
    expect(
      createSharedMemoryCandidatePreviewSchema.parse(personalNoteCandidate())
        .source?.kind
    ).toBe("personal_note");
    expect(
      createSharedMemoryCandidatePreviewSchema.parse({
        ...personalNoteCandidate(),
        mode: "continuous"
      }).mode
    ).toBe("continuous");
  });

  it("rejects invalid Personal Note selection and source bindings", () => {
    const candidate = personalNoteCandidate();
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

  it("fixes Personal Note share bundles to one Memory Event at either update mode", () => {
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
      sourceCapabilities: ["memory_events" as const],
      activationRepresentation: "memory_events" as const,
      maximumFidelity: "memory_events" as const,
      includeCuratedMemory: false,
      authority
    };
    expect(createPendingShareSchema.parse(bundle).source?.kind).toBe(
      "personal_note"
    );
    expect(
      createPendingShareSchema.parse({ ...bundle, mode: "continuous" }).mode
    ).toBe("continuous");
    expect(() =>
      createPendingShareSchema.parse({
        ...bundle,
        sourceCapabilities: ["memory_events", "lcm_leaves"]
      })
    ).toThrow("Memory Event source capability");
  });

  it("accepts a Personal Note revision replacement under the fixed selection", () => {
    const candidate = personalNoteCandidate();
    const replacement = {
      source: {
        ...candidate.source,
        noteRevision: 2,
        memoryEventId: randomUUID()
      },
      mutationId: randomUUID(),
      consentId: randomUUID(),
      logicalMemoryId: candidate.logicalMemoryId,
      teamId: candidate.teamId,
      teamWorkspaceId: candidate.teamWorkspaceId,
      preview: { previewId: randomUUID(), previewHash: "c".repeat(64) },
      previewRevision: 1,
      mode: "snapshot" as const,
      sourceCapabilities: ["memory_events" as const],
      activationRepresentation: "memory_events" as const,
      maximumFidelity: "memory_events" as const,
      includeCuratedMemory: false,
      expectedGrantVersion: 1,
      authority
    };

    expect(
      changeSharedMemoryFidelityBundleSchema.parse(replacement).source.kind
    ).toBe("personal_note");
    expect(
      changeSharedMemoryFidelityBundleSchema.parse({
        ...replacement,
        mode: "continuous"
      }).mode
    ).toBe("continuous");
  });
});
