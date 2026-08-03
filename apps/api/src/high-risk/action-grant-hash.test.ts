import {
  highRiskActionGrantCanonicalHash,
  HIGH_RISK_ACTION_GRANT_HASH_DOMAINS,
  sharedMemoryRevokeActionGrantBinding
} from "@koed/shared";
import { describe, expect, it } from "vitest";

import {
  retentionAdminRequestHash,
  retentionAdminScopeHash
} from "../retention/routes.js";
import { teamAdminRequestHash, teamAdminScopeHash } from "../team/routes.js";
import {
  managedConversationTransferRequestHash,
  managedConversationTransferScopeHash
} from "./action-grant-protocol.js";

const ids = {
  team: "11111111-1111-4111-8111-111111111111",
  member: "22222222-2222-4222-8222-222222222222",
  hold: "33333333-3333-4333-8333-333333333333",
  workspace: "44444444-4444-4444-8444-444444444444",
  grant: "55555555-5555-4555-8555-555555555555",
  mutation: "66666666-6666-4666-8666-666666666666",
  reference: "77777777-7777-4777-8777-777777777777",
  execution: "88888888-8888-4888-8888-888888888888",
  operation: "99999999-9999-4999-8999-999999999999",
  device: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
} as const;

describe("high-risk Action Grant hash regression vectors", () => {
  it("keeps Team producer and verifier hashes on the canonical shared API", () => {
    const scope = {
      action: "team.member.role_update",
      teamId: ids.team,
      targetId: ids.member
    };
    const request = {
      method: "PATCH",
      path: `/v1/teams/${ids.team}/members/${ids.member}/role`,
      body: { role: "admin", expectedVersion: 7 }
    };

    expect(teamAdminScopeHash(scope)).toBe(
      "a9bcb2549733d8d2239425a5499ea048296d3ba888cbea85f255e24bdc9e51a1"
    );
    expect(teamAdminScopeHash(scope)).toBe(
      highRiskActionGrantCanonicalHash(
        HIGH_RISK_ACTION_GRANT_HASH_DOMAINS.teamAdminScope,
        { operationFamily: "admin", ...scope }
      )
    );
    expect(teamAdminRequestHash(request)).toBe(
      "d6a261ad3ff08e0ac8a936b92de3622fa8ed1e8de5854144f6181708982623e9"
    );
    expect(teamAdminRequestHash(request)).toBe(
      highRiskActionGrantCanonicalHash(
        HIGH_RISK_ACTION_GRANT_HASH_DOMAINS.teamAdminRequest,
        request
      )
    );
  });

  it("keeps retention producer and verifier hashes on the canonical shared API", () => {
    const scope = {
      action: "team.legal_hold.release_confirm",
      teamId: ids.team,
      targetId: ids.hold
    };
    const request = {
      method: "POST",
      path: `/v1/retention/legal-holds/${ids.hold}/release/confirm`,
      body: { expectedVersion: 3, confirmation: "release" }
    };

    expect(retentionAdminScopeHash(scope)).toBe(
      "7d658f7400d7d58011c150247d0ce81cf0a3a6074938a64fd36c209765658c99"
    );
    expect(retentionAdminScopeHash(scope)).toBe(
      highRiskActionGrantCanonicalHash(
        HIGH_RISK_ACTION_GRANT_HASH_DOMAINS.retentionAdminScope,
        { operationFamily: "admin", ...scope }
      )
    );
    expect(retentionAdminRequestHash(request)).toBe(
      "28ee272b0ad429eb21b1ca6a98c513eebbb267b2baac2072e50f3e65b21979b7"
    );
    expect(retentionAdminRequestHash(request)).toBe(
      highRiskActionGrantCanonicalHash(
        HIGH_RISK_ACTION_GRANT_HASH_DOMAINS.retentionAdminRequest,
        request
      )
    );
  });

  it("keeps shared-memory producer and verifier hashes on the canonical shared API", () => {
    const binding = sharedMemoryRevokeActionGrantBinding({
      referenceId: ids.reference,
      mutationId: ids.mutation,
      teamId: ids.team,
      teamWorkspaceId: ids.workspace,
      shareGrantId: ids.grant,
      expectedGrantVersion: 2,
      reasonCode: "owner_revoked"
    });

    expect(binding.scopeHash).toBe(
      "75d80ec0dd12e89915beca973aa810975dedc1935df735e5d34c11d9c7f57e7a"
    );
    expect(binding.scopeHash).toBe(
      highRiskActionGrantCanonicalHash(
        HIGH_RISK_ACTION_GRANT_HASH_DOMAINS.sharedMemoryScope,
        {
          operationFamily: binding.operationFamily,
          action: binding.action,
          teamId: binding.teamId,
          targetId: binding.targetId
        }
      )
    );
    expect(binding.requestHash).toBe(
      "0c7755c0da6fe9ed019e5f9433200a0e0b3b9c3c80075eec45ab06ee72881eb3"
    );
    expect(binding.requestHash).toBe(
      highRiskActionGrantCanonicalHash(
        HIGH_RISK_ACTION_GRANT_HASH_DOMAINS.sharedMemoryRequest,
        {
          operationFamily: binding.operationFamily,
          action: binding.action,
          teamId: binding.teamId,
          targetId: binding.targetId,
          method: binding.method,
          path: binding.path,
          body: binding.body
        }
      )
    );
  });

  it("keeps managed-conversation producer and verifier hashes on the canonical shared API", () => {
    const scope = {
      action: "managed_conversation.handoff" as const,
      executionId: ids.execution
    };
    const request = {
      method: "POST" as const,
      path: `/v1/managed-conversations/${ids.execution}/handoffs`,
      body: {
        operationId: ids.operation,
        targetDeviceId: ids.device
      }
    };

    expect(managedConversationTransferScopeHash(scope)).toBe(
      "88779c20f0f606538cb12cd69402ad71ea0a8b3c07da2b0f30b7f8858892a00c"
    );
    expect(managedConversationTransferScopeHash(scope)).toBe(
      highRiskActionGrantCanonicalHash(
        HIGH_RISK_ACTION_GRANT_HASH_DOMAINS.managedConversationTransferScope,
        { operationFamily: "managed_execution", ...scope }
      )
    );
    expect(managedConversationTransferRequestHash(request)).toBe(
      "d15acef231b33f681f6fecc3178638f0448b8cffeba6e6f1815be4b00619bf5c"
    );
    expect(managedConversationTransferRequestHash(request)).toBe(
      highRiskActionGrantCanonicalHash(
        HIGH_RISK_ACTION_GRANT_HASH_DOMAINS.managedConversationTransferRequest,
        request
      )
    );
  });
});
