import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
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
