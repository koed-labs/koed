import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withHq713Fixture } from "../../tests/hq-integration/hq713-fixture.js";
import { readTeamSharing } from "./sharing-read.js";
import { waitForHq713TeamEmbedding } from "../../tests/hq-integration/hq713-memory.js";

const testUrl =
  process.env.KOED_HQ713_TEST_DATABASE_URL ??
  (process.env.CI ? process.env.DATABASE_URL : undefined);

describe.skipIf(!testUrl)(
  "HQ-723 published Project content counts in Postgres",
  () => {
    it("counts available and frozen Project summaries, deduplicates share-again, and excludes revoked or unavailable grants", async () => {
      await withHq713Fixture(async (fixture) => {
        const marker = `sharing-read-${randomUUID()}`;
        const captured = await fixture.seedCapturedSession(fixture.alice, {
          projectId: fixture.ids.alicePersonalProjectId,
          sessionLabel: marker
        });
        const first = await fixture.shareCapturedSession(fixture.alice, {
          sessionId: captured.sessionId,
          workspaceProjectId: fixture.ids.workspaceProjectId,
          teamWorkspaceId: fixture.ids.workspaceId,
          summaryText: marker,
          includeCuratedMemory: false
        });
        const counts = async () => {
          const read = await readTeamSharing(
            fixture.team.db,
            fixture.alice.teamUserId
          );
          const project = read.projects.find(
            (item) => item.id === fixture.ids.workspaceProjectId
          );
          expect(project).toBeDefined();
          return project!.contentCounts!;
        };

        await waitForHq713TeamEmbedding(fixture, first.grantId, "lcm_leaves");
        expect((await counts()).chatSummaries).toBe(1);
        expect((await counts()).sharedMemoryItems).toBeGreaterThan(0);

        await fixture.makeChatPrivate(fixture.alice, {
          sessionId: captured.sessionId,
          grantId: first.grantId,
          projectId: fixture.ids.alicePersonalProjectId
        });
        const frozen = await fixture.team.db.query<{ frozen_at: Date | null }>(
          "select frozen_at from team_memory_share_grants where id=$1",
          [first.grantId]
        );
        expect(frozen.rows[0]?.frozen_at).toBeInstanceOf(Date);
        expect((await counts()).chatSummaries).toBe(1);
        expect((await counts()).sharedMemoryItems).toBeGreaterThan(0);

        const later = await fixture.advanceCapturedSession(fixture.alice, {
          sessionId: captured.sessionId,
          projectId: fixture.ids.alicePersonalProjectId,
          sessionLabel: `Later summary ${randomUUID()}`
        });
        const offer = await fixture.alice.personalEdge.request<{
          offerId: string;
          mutationId: string;
        }>(
          "POST",
          `/v1/local-edge/projects/${fixture.ids.alicePersonalProjectId}/project-share-policy/explicit-offers`,
          {
            body: {
              teamBackendId: fixture.teamBackendId,
              workspaceProjectId: fixture.ids.workspaceProjectId,
              sessionId: captured.sessionId,
              reason: "share_again"
            },
            expectedStatus: 200
          }
        );
        const second = await fixture.shareCapturedSession(fixture.alice, {
          sessionId: captured.sessionId,
          workspaceProjectId: fixture.ids.workspaceProjectId,
          teamWorkspaceId: fixture.ids.workspaceId,
          summaryText: later.laterSummaryText,
          mutationId: offer.body.mutationId,
          includeCuratedMemory: false
        });
        const settled = await fixture.alice.personalEdge.request<{
          state: string;
        }>(
          "POST",
          `/v1/local-edge/projects/${fixture.ids.alicePersonalProjectId}/project-share-policy/explicit-offers/${offer.body.offerId}/settle`,
          {
            body: { teamBackendId: fixture.teamBackendId },
            expectedStatus: 200
          }
        );
        expect(settled.body.state).toBe("activated");
        await waitForHq713TeamEmbedding(fixture, second.grantId, "lcm_leaves");
        expect((await counts()).chatSummaries).toBe(1);

        await fixture.team.db.query(
          "update team_memory_share_grants set lifecycle='revoked',revoked_at=now() where id=$1",
          [first.grantId]
        );
        expect((await counts()).chatSummaries).toBe(1);

        const consent = await fixture.team.db.query<{ consent_id: string }>(
          "select consent_id from team_memory_share_grants where id=$1",
          [second.grantId]
        );
        await fixture.team.db.query(
          "update source_owner_representation_consents set expires_at=now()-interval '1 second' where id=$1",
          [consent.rows[0]!.consent_id]
        );
        expect((await counts()).chatSummaries).toBe(0);
        expect((await counts()).sharedMemoryItems).toBe(0);
        await fixture.team.db.query(
          "update source_owner_representation_consents set expires_at=null where id=$1",
          [consent.rows[0]!.consent_id]
        );
        expect((await counts()).chatSummaries).toBe(1);

        await fixture.team.db.query(
          "update team_memory_representations set state='invalidated',invalidated_at=now() where share_grant_id=$1 and state in ('available','stale')",
          [second.grantId]
        );
        expect((await counts()).chatSummaries).toBe(0);
        expect((await counts()).sharedMemoryItems).toBe(0);
      });
    }, 300_000);
  }
);
