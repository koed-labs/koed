import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  sharedMemoryConsentActionGrantBinding,
  sharedMemoryFidelityActionGrantBinding,
  sharedMemoryPreviewActionGrantBinding,
  sharedMemoryShareBundleActionGrantBinding,
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
    mode: "continuous" as const,
    maximumFidelity: "lcm_leaves" as const,
    includeCuratedMemory: false,
    expectedGrantVersion: 3
  });

  it("binds preview consent to the ceiling and independent Curated Memory choice", () => {
    const input = base();
    const baseline = sharedMemoryPreviewActionGrantBinding({
      ...input,
      representation: "lcm_rollups"
    });

    expect(baseline.body).toMatchObject({
      representation: "lcm_rollups",
      maximumFidelity: "lcm_leaves",
      includeCuratedMemory: false
    });
    expect(
      sharedMemoryPreviewActionGrantBinding({
        ...input,
        representation: "lcm_rollups",
        maximumFidelity: "memory_events"
      }).requestHash
    ).not.toBe(baseline.requestHash);
    expect(
      sharedMemoryPreviewActionGrantBinding({
        ...input,
        representation: "lcm_rollups",
        includeCuratedMemory: true
      }).requestHash
    ).not.toBe(baseline.requestHash);
  });

  it("uses maximum fidelity fields throughout consent and share bundles", () => {
    const input = base();
    for (const binding of [
      sharedMemoryConsentActionGrantBinding(input),
      sharedMemoryShareBundleActionGrantBinding(input)
    ]) {
      expect(binding.body).toMatchObject({
        maximumFidelity: "lcm_leaves",
        includeCuratedMemory: false
      });
      expect(binding.body).not.toHaveProperty("allowedRepresentations");
      expect(binding.body).not.toHaveProperty("selectedRepresentation");
    }
  });

  it("binds fidelity changes without conflating Conversation Source Access", () => {
    const input = base();
    const fidelity = sharedMemoryFidelityActionGrantBinding(input);
    const source = sharedMemoryTranscriptAccessActionGrantBinding({
      ...input,
      expectedVersion: input.expectedGrantVersion
    });

    expect(fidelity).toMatchObject({
      action: `shared_memory.change_fidelity.${input.teamWorkspaceId}.lcm_leaves.curated_false`,
      path: `/v1/shared-memory/share-grants/${input.shareGrantId}/fidelity`
    });
    expect(source.path).toBe(
      `/v1/shared-memory/share-grants/${input.shareGrantId}/transcript-access`
    );
    expect(source.requestHash).not.toBe(fidelity.requestHash);
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
