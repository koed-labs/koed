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
          replica: false,
          git_known: false,
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
          capturedOnThisDevice: true,
          gitAnchorKnown: false,
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
          replica: true
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
      firstConversationAt: null
    });
    await expect(
      repository.getPersonalFolderHintEvidence({ userId: owner } as never, {
        sessionIds: Array(51).fill(session)
      })
    ).rejects.toThrow();
  });

  describe("recordPersonalFolderObservation", () => {
    const observation = {
      identity: {
        folderId: "folder-1",
        originatingDeploymentId: "deployment-1",
        originatingDeviceId: "device-1",
        originatingProfileId: "profile-1",
        directoryIncarnationId: "incarnation-1"
      },
      normalizedPath: "/work/koed",
      capturedPath: "/work/koed",
      observedAt: "2026-11-01T00:00:00.000Z"
    };
    const row = (overrides: Record<string, unknown> = {}) => ({
      folder_assignment: {
        revision: 1,
        original: { state: "unresolved", reason: "historical_unresolved" },
        correction: { state: "original" }
      },
      cwd: "/work/koed",
      replica: false,
      ...overrides
    });
    const run = (rows: unknown[]) => {
      const query = vi.fn(async (sql: string) =>
        /^\s*select/i.test(sql) ? { rows } : { rows: [], rowCount: 1 }
      );
      const repository = createPersonalFolderHintEvidenceRepository({
        query
      } as unknown as pg.Pool);
      return {
        query,
        record: () =>
          repository.recordPersonalFolderObservation(
            { userId: owner } as never,
            session,
            { observation }
          )
      };
    };

    it("records the observation for an owner's Folder-less local Conversation", async () => {
      const { query, record } = run([row()]);
      await expect(record()).resolves.toEqual({ recorded: true });
      const [select, selectValues] = query.mock.calls[0] as unknown as [
        string,
        unknown[]
      ];
      expect(select).toMatch(/s\.owner_user_id = \$2/);
      expect(select).toMatch(/visibility = 'personal'/);
      expect(selectValues).toEqual([session, owner]);
      const [insert, insertValues] = query.mock.calls[1] as unknown as [
        string,
        unknown[]
      ];
      expect(insert).toMatch(/insert into session_folder_observations/);
      expect(insertValues.slice(0, 2)).toEqual([session, owner]);
    });

    it.each([
      ["an unknown or foreign Conversation", [] as unknown[]],
      ["a replica", [row({ replica: true })]],
      [
        "a Conversation that already has a Folder",
        [
          row({
            folder_assignment: {
              revision: 1,
              original: {
                state: "known",
                value: {
                  reference: { ...observation.identity, ownerUserId: owner },
                  normalizedPath: "/work/koed",
                  capturedPath: "/work/koed"
                }
              },
              correction: { state: "original" }
            }
          })
        ]
      ]
    ])("writes nothing for %s", async (_name, rows) => {
      const { query, record } = run(rows);
      await expect(record()).rejects.toMatchObject({
        statusCode: expect.any(Number) as number
      });
      expect(query).toHaveBeenCalledTimes(1);
    });
  });
});
