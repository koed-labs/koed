import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  sharedMemoryCandidatePreviewActionGrantBinding,
  sharedMemoryFidelityBundleActionGrantBinding,
  sharedMemoryPendingShareActionGrantBinding,
  sharedMemoryPreviewActionGrantBinding,
  sharedMemoryTranscriptAccessActionGrantBinding,
  sharedMemoryTranscriptRevokeActionGrantBinding
} from "./shared-memory-action-grant.js";

describe("Shared Memory fidelity action grant bindings", () => {
  const base = () => ({
    referenceId: randomUUID(),
    mutationId: randomUUID(),
    consentId: randomUUID(),
    logicalGrantId: randomUUID(),
    logicalMemoryId: randomUUID(),
    remoteReplicaId: randomUUID(),
    teamId: randomUUID(),
    teamWorkspaceId: randomUUID(),
    shareGrantId: randomUUID(),
    previewId: randomUUID(),
    previewRevision: 2,
    previewHash: "a".repeat(64),
    source: {
      kind: "captured_session" as const,
      sessionId: randomUUID(),
      logicalMemoryId: randomUUID()
    },
    sourceDeploymentProtocolId: randomUUID(),
    sourceOwnerPrincipalId: randomUUID(),
    sourceCapabilities: [
      "memory_events" as const,
      "lcm_leaves" as const,
      "lcm_rollups" as const,
      "curated_assertions" as const
    ],
    activationRepresentation: "lcm_rollups" as const,
    mode: "continuous" as const,
    maximumFidelity: "lcm_leaves" as const,
    includeCuratedMemory: false,
    expectedGrantVersion: 3
  });

  it("binds preview consent to the ceiling and independent Curated Memory choice", () => {
    const input = base();
    const baseline = sharedMemoryPreviewActionGrantBinding({
      ...input
    });

    expect(baseline.body).toMatchObject({
      source: input.source,
      sourceCapabilities: input.sourceCapabilities,
      activationRepresentation: "lcm_rollups",
      maximumFidelity: "lcm_leaves",
      includeCuratedMemory: false
    });
    expect(
      sharedMemoryPreviewActionGrantBinding({
        ...input,
        maximumFidelity: "memory_events"
      }).requestHash
    ).not.toBe(baseline.requestHash);
    expect(
      sharedMemoryPreviewActionGrantBinding({
        ...input,
        includeCuratedMemory: true
      }).requestHash
    ).not.toBe(baseline.requestHash);
  });

  it("uses maximum fidelity fields throughout Pending Shares", () => {
    const input = base();
    const binding = sharedMemoryPendingShareActionGrantBinding(input);
    expect(binding.body).toMatchObject({
      maximumFidelity: "lcm_leaves",
      includeCuratedMemory: false
    });
    expect(binding.body).not.toHaveProperty("allowedRepresentations");
    expect(binding.body).not.toHaveProperty("selectedRepresentation");
  });

  it("binds fidelity changes without conflating Conversation Source Access", () => {
    const input = base();
    const fidelity = sharedMemoryFidelityBundleActionGrantBinding(input);
    const source = sharedMemoryTranscriptAccessActionGrantBinding({
      ...input,
      expectedVersion: input.expectedGrantVersion
    });

    expect(fidelity).toMatchObject({
      path: `/v1/shared-memory/share-grants/${input.shareGrantId}/fidelity-bundle`
    });
    expect(fidelity.action).toMatch(/^shared_memory\.change_fidelity\./);
    expect(source.path).toBe(
      `/v1/shared-memory/share-grants/${input.shareGrantId}/transcript-access`
    );
    expect(source.requestHash).not.toBe(fidelity.requestHash);
  });

  it("canonicalizes omitted Share expiry as no expiry", () => {
    const input = base();
    const candidateInput = {
      ...input,
      candidateHash: "b".repeat(64),
      sourceRevision: 1,
      itemCount: 1,
      byteCount: 100,
      excludedItemCount: 0,
      manifest: [{ sourceId: randomUUID(), revisionHash: "c".repeat(64) }]
    };

    for (const bind of [
      (expiresAt?: string | null) =>
        sharedMemoryCandidatePreviewActionGrantBinding({
          ...candidateInput,
          expiresAt
        }),
      (expiresAt?: string | null) =>
        sharedMemoryPendingShareActionGrantBinding({ ...input, expiresAt }),
      (expiresAt?: string | null) =>
        sharedMemoryFidelityBundleActionGrantBinding({ ...input, expiresAt })
    ]) {
      const omitted = bind();
      const explicit = bind(null);
      expect(omitted.action).toBe(explicit.action);
      expect(omitted.scopeHash).toBe(explicit.scopeHash);
      expect(omitted.requestHash).toBe(explicit.requestHash);
    }
  });
});

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
    noteRevision: 1,
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
      sourceDeploymentProtocolId: randomUUID(),
      sourceOwnerPrincipalId: randomUUID(),
      logicalMemoryId: boundSource.logicalMemoryId,
      candidateHash: "b".repeat(64),
      sourceRevision: 1,
      itemCount: 1,
      byteCount: 100,
      excludedItemCount: 0,
      manifest,
      teamId,
      teamWorkspaceId,
      sourceCapabilities: ["memory_events" as const],
      activationRepresentation: "memory_events" as const,
      maximumFidelity: "memory_events" as const,
      includeCuratedMemory: false,
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
        sourceCapabilities: ["lcm_leaves" as const],
        activationRepresentation: "lcm_leaves" as const,
        maximumFidelity: "lcm_leaves" as const
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
      sourceCapabilities: ["memory_events" as const],
      activationRepresentation: "memory_events" as const,
      maximumFidelity: "memory_events" as const,
      includeCuratedMemory: false,
      previewRevision: 1,
      previewHash: "c".repeat(64),
      source: boundSource
    };
    const pendingInput = {
      ...consentInput,
      mutationId: randomUUID(),
      logicalGrantId: randomUUID()
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
