import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  sharedMemoryCandidatePreviewActionGrantBinding,
  sharedMemoryConsentActionGrantBinding,
  sharedMemoryPendingShareActionGrantBinding,
  sharedMemoryTranscriptAccessActionGrantBinding,
  sharedMemoryTranscriptRevokeActionGrantBinding
} from "./shared-memory-action-grant.js";

describe("Team Conversation source action grant bindings", () => {
  it("binds source access to the exact grant, Team, mode, version, and mutation", () => {
    const input = {
      referenceId: randomUUID(),
      mutationId: randomUUID(),
      teamId: randomUUID(),
      shareGrantId: randomUUID(),
      expectedVersion: 0,
      mode: "continuous" as const
    };
    const baseline = sharedMemoryTranscriptAccessActionGrantBinding(input);

    expect(baseline).toMatchObject({
      operationFamily: "share_grant_management",
      method: "PUT",
      path: `/v1/shared-memory/share-grants/${input.shareGrantId}/transcript-access`,
      teamId: input.teamId,
      targetId: input.shareGrantId
    });
    expect(
      sharedMemoryTranscriptAccessActionGrantBinding({
        ...input,
        mode: "snapshot"
      }).requestHash
    ).not.toBe(baseline.requestHash);
    expect(
      sharedMemoryTranscriptAccessActionGrantBinding({
        ...input,
        expectedVersion: 1
      }).requestHash
    ).not.toBe(baseline.requestHash);
    expect(
      sharedMemoryTranscriptAccessActionGrantBinding({
        ...input,
        shareGrantId: randomUUID()
      }).scopeHash
    ).not.toBe(baseline.scopeHash);
  });

  it("binds revocation to the exact reason and current grant version", () => {
    const input = {
      referenceId: randomUUID(),
      mutationId: randomUUID(),
      teamId: randomUUID(),
      shareGrantId: randomUUID(),
      expectedVersion: 3,
      reasonCode: "owner_revoked"
    };
    const baseline = sharedMemoryTranscriptRevokeActionGrantBinding(input);

    expect(baseline).toMatchObject({
      operationFamily: "share_grant_management",
      method: "POST",
      path: `/v1/shared-memory/share-grants/${input.shareGrantId}/transcript-access/revoke`
    });
    expect(
      sharedMemoryTranscriptRevokeActionGrantBinding({
        ...input,
        reasonCode: "policy_changed"
      }).requestHash
    ).not.toBe(baseline.requestHash);
  });
});

describe("Shared Memory source action grant bindings", () => {
  const source = () => ({
    kind: "personal_note" as const,
    noteId: randomUUID(),
    memoryEventId: randomUUID(),
    logicalMemoryId: randomUUID()
  });

  it("binds source identity into candidate, consent, and pending-share hashes", () => {
    const boundSource = source();
    const referenceId = randomUUID();
    const teamId = randomUUID();
    const teamWorkspaceId = randomUUID();
    const manifest = [
      { sourceId: boundSource.memoryEventId, revisionHash: "a".repeat(64) }
    ];
    const candidateInput = {
      referenceId,
      logicalMemoryId: boundSource.logicalMemoryId,
      candidateHash: "b".repeat(64),
      sourceRevision: 1,
      itemCount: 1,
      byteCount: 100,
      excludedItemCount: 0,
      manifest,
      teamId,
      teamWorkspaceId,
      representation: "memory_events" as const,
      allowedRepresentations: ["memory_events" as const],
      mode: "snapshot" as const,
      source: boundSource
    };
    const candidate =
      sharedMemoryCandidatePreviewActionGrantBinding(candidateInput);
    expect(
      sharedMemoryCandidatePreviewActionGrantBinding({
        ...candidateInput,
        source: { ...boundSource, memoryEventId: randomUUID() }
      }).requestHash
    ).not.toBe(candidate.requestHash);
    for (const changed of [
      { ...candidateInput, teamWorkspaceId: randomUUID() },
      { ...candidateInput, candidateHash: "d".repeat(64) },
      { ...candidateInput, sourceRevision: 2 },
      {
        ...candidateInput,
        manifest: [
          {
            sourceId: boundSource.memoryEventId,
            revisionHash: "e".repeat(64)
          }
        ]
      },
      {
        ...candidateInput,
        representation: "lcm_leaves" as const,
        allowedRepresentations: ["lcm_leaves" as const]
      },
      { ...candidateInput, mode: "continuous" as const }
    ]) {
      expect(
        sharedMemoryCandidatePreviewActionGrantBinding(changed).requestHash
      ).not.toBe(candidate.requestHash);
    }

    const consentInput = {
      referenceId,
      consentId: randomUUID(),
      logicalMemoryId: boundSource.logicalMemoryId,
      teamId,
      teamWorkspaceId,
      previewId: randomUUID(),
      mode: "snapshot" as const,
      allowedRepresentations: ["memory_events" as const],
      selectedRepresentation: "memory_events" as const,
      previewRevision: 1,
      previewHash: "c".repeat(64),
      source: boundSource
    };
    const consent = sharedMemoryConsentActionGrantBinding(consentInput);
    expect(
      sharedMemoryConsentActionGrantBinding({
        ...consentInput,
        source: { ...boundSource, noteId: randomUUID() }
      }).requestHash
    ).not.toBe(consent.requestHash);

    const pendingInput = {
      ...consentInput,
      mutationId: randomUUID(),
      logicalGrantId: randomUUID(),
      selectedRepresentation: "memory_events" as const
    };
    const pending = sharedMemoryPendingShareActionGrantBinding(pendingInput);
    expect(
      sharedMemoryPendingShareActionGrantBinding({
        ...pendingInput,
        source: { ...boundSource, logicalMemoryId: randomUUID() }
      }).requestHash
    ).not.toBe(pending.requestHash);
  });
});
