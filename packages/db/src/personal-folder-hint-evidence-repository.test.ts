import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { createPersonalFolderHintEvidenceRepository } from "./personal-folder-hint-evidence-repository.js";

const owner = "00000000-0000-4000-8000-000000000002";
const session = "00000000-0000-4000-8000-000000000001";

describe("Folder hint evidence repository", () => {
  it("binds the query to the owner and returns only recorded facts", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          id: session,
          folder_assignment: {
            revision: 1,
            original: { state: "unresolved", reason: "missing" },
            correction: { state: "original" }
          },
          cwd: "/work/koed",
          first_at: new Date("2026-10-01T00:00:00.000Z"),
          remote: "gr_koed",
          known_copy: false,
          git_eligible: false,
          git_known: false,
          git_revision: 3,
          source_runtime: "claude-code",
          external_session_id: "cli-1"
        }
      ]
    }));
    const repository = createPersonalFolderHintEvidenceRepository({
      query
    } as unknown as pg.Pool);
    const result = await repository.getPersonalFolderHintEvidence(
      { userId: owner } as never,
      { sessionIds: [session] }
    );
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/s\.owner_user_id = \$1/);
    expect(sql).toMatch(/visibility = 'personal'/);
    expect(sql).not.toMatch(/\b(insert|update|delete)\b/i);
    expect(values).toEqual([owner, [session]]);
    expect(result).toEqual({
      ownerUserId: owner,
      evidence: [
        {
          sessionId: session,
          folderAssignment: {
            revision: 1,
            original: { state: "unresolved", reason: "missing" },
            correction: { state: "original" }
          },
          recordedCwd: "/work/koed",
          firstConversationAt: "2026-10-01T00:00:00.000Z",
          recordedRemoteFingerprint: "gr_koed",
          capturedOnThisDevice: false,
          recordingDeviceProvenance: "unknown",
          gitInferenceEligibility: false,
          gitAnchorKnown: false,
          gitRevision: 3,
          sourceRuntime: "claude-code",
          externalSessionId: "cli-1"
        }
      ]
    });
  });

  it("marks replicas as not captured on this device and rejects oversized batches", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          id: session,
          folder_assignment: {
            revision: 1,
            original: { state: "unresolved", reason: "missing" },
            correction: { state: "original" }
          },
          cwd: null,
          first_at: null,
          remote: null,
          known_copy: true,
          git_eligible: false
        }
      ]
    }));
    const repository = createPersonalFolderHintEvidenceRepository({
      query
    } as unknown as pg.Pool);
    const result = await repository.getPersonalFolderHintEvidence(
      { userId: owner } as never,
      { sessionIds: [session] }
    );
    expect(result.evidence[0]).toMatchObject({
      capturedOnThisDevice: false,
      recordingDeviceProvenance: "known-copy",
      gitInferenceEligibility: false,
      firstConversationAt: null
    });
    await expect(
      repository.getPersonalFolderHintEvidence({ userId: owner } as never, {
        sessionIds: Array(51).fill(session)
      })
    ).rejects.toThrow();
  });
});
