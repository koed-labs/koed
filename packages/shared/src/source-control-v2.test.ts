import { describe, expect, it } from "vitest";

import {
  sourceControlConnectionSchema,
  sourceControlOperationSchema,
  sourceControlResultSchema
} from "./source-control.js";
import {
  sourceControlV2RequestSchema,
  sourceControlV2ResultSchema
} from "./source-control-v2.js";

const binding = {
  executionId: "11111111-1111-4111-8111-111111111111",
  executionGeneration: 1,
  remoteIdentityHash: "a".repeat(64)
};

describe("versioned source-control merge contract", () => {
  it("keeps all version-1 union and capability shapes strict", () => {
    const merge = {
      ...binding,
      contractVersion: 1,
      kind: "review_request_merge",
      reviewRequestNumber: 7,
      mergeMethod: "squash",
      approvalProof: "b".repeat(64)
    };
    expect(sourceControlOperationSchema.safeParse(merge).success).toBe(false);
    expect(
      sourceControlResultSchema.safeParse({
        kind: "review_request_merge_result",
        operationId: binding.executionId,
        outcome: "merged"
      }).success
    ).toBe(false);
    expect(
      sourceControlConnectionSchema.safeParse({
        id: binding.executionId,
        provider: "github",
        host: "github.com",
        apiOrigin: "https://api.github.com",
        accountLabel: "Account",
        credentialReference: "source-control:test",
        credentialGeneration: 1,
        state: "active",
        capabilities: ["review_request_merge"]
      }).success
    ).toBe(false);
  });

  it("requires explicit version 2 and rejects caller-supplied authority in proposal", () => {
    const proposal = {
      ...binding,
      contractVersion: 2,
      kind: "review_request_merge_prepare",
      reviewRequestNumber: 7,
      mergeMethod: "squash"
    };
    expect(sourceControlV2RequestSchema.safeParse(proposal).success).toBe(true);
    expect(
      sourceControlV2RequestSchema.safeParse({
        ...proposal,
        contractVersion: 1
      }).success
    ).toBe(false);
    expect(
      sourceControlV2RequestSchema.safeParse({
        ...proposal,
        credential: "secret"
      }).success
    ).toBe(false);
    expect(
      sourceControlV2ResultSchema.safeParse({
        kind: "review_request_merge_result",
        operationId: binding.executionId,
        outcome: "unknown",
        providerOperationId: null,
        mergeCommitObjectId: null
      }).success
    ).toBe(true);
  });
});
