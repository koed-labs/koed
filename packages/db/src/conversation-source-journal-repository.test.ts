import { describe, expect, it, vi } from "vitest";
import type pg from "pg";

import { createConversationSourceJournalRepository } from "./conversation-source-journal-repository.js";

describe("conversation source download authorization", () => {
  it("revalidates expiry and the exact initiating operation on retry and replay", async () => {
    const now = new Date("2026-08-04T09:00:00.000Z");
    const ownerUserId = "11111111-1111-4111-8111-111111111111";
    const authorizationId = "22222222-2222-4222-8222-222222222222";
    const credentialId = "33333333-3333-4333-8333-333333333333";
    const artifactId = "44444444-4444-4444-8444-444444444444";
    const handoffId = "55555555-5555-4555-8555-555555555555";
    const capabilityHash = "a".repeat(64);
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: authorizationId,
            owner_user_id: ownerUserId,
            device_credential_id: credentialId,
            artifact_id: artifactId,
            recipient_key: {
              targetDeploymentId: "66666666-6666-4666-8666-666666666666"
            },
            initiating_operation_kind: "handoff",
            initiating_operation_id: handoffId,
            first_segment_index: 0,
            last_segment_index: 3,
            created_at: now,
            expires_at: new Date("2026-08-04T09:05:00.000Z"),
            last_used_at: null,
            revoked_at: null,
            revocation_reason: null
          }
        ]
      })
      // The database returns no row once the handoff is canceled. Repeated
      // retry/replay lookups must remain authoritative rather than cached.
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const repository = createConversationSourceJournalRepository({
      query
    } as unknown as pg.Pool);
    const lookup = () =>
      repository.getConversationSourceDownloadAuthorization(
        { userId: ownerUserId },
        {
          authorizationId,
          deviceCredentialId: credentialId,
          capabilityHash
        }
      );

    await expect(lookup()).resolves.toMatchObject({
      id: authorizationId,
      initiatingOperationKind: "handoff",
      initiatingOperationId: handoffId
    });
    await expect(lookup()).resolves.toBeNull();
    await expect(lookup()).resolves.toBeNull();

    expect(query).toHaveBeenCalledTimes(3);
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("download_auth.expires_at > now()");
    expect(sql).toContain("handoff.id = download_auth.initiating_operation_id");
    expect(sql).toContain(
      "handoff.target_device_id::text =\n                         credential.device_instance_id"
    );
    expect(sql).toContain(
      "download_auth.recipient_key ->> 'targetDeploymentId'"
    );
    expect(sql).toContain(
      "handoff.source_generation_id =\n                         artifact.source_generation_id"
    );
    expect(sql).toContain("fork.id = download_auth.initiating_operation_id");
    expect(sql).toContain(
      "fork.target_device_id::text =\n                         credential.device_instance_id"
    );
    expect(sql).toContain(
      "fork.parent_source_generation_id =\n                         artifact.source_generation_id"
    );
    expect(sql).toContain("fork.state = 'source_attested'");
    expect(sql).not.toMatch(/handoff\.state in \([^)]*'failed'/s);
    expect(sql).not.toMatch(/handoff\.state in \([^)]*'quarantined'/s);
    expect(query.mock.calls.map((call): unknown => call[1])).toEqual([
      [ownerUserId, authorizationId, credentialId, capabilityHash],
      [ownerUserId, authorizationId, credentialId, capabilityHash],
      [ownerUserId, authorizationId, credentialId, capabilityHash]
    ]);
  });
});
