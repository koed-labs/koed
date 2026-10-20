import { recordBoundPersonalSourceCorrection } from "./personal-source-context-local-changes.js";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  personalOwnerIdSchema,
  personalSourceCorrectionInputSchema,
  personalSourceCorrectionApplySchema,
  personalSourceCorrectionPreviewSchema,
  type PersonalSourceCorrectionInput
} from "@koed/shared";
import type { ActorContext } from "./types.js";
import { withPersonalMembershipTransaction } from "./personal-membership-repository.js";
import {
  lockPersonalCorrectionSource,
  personalCorrectionContext,
  personalCorrectionPatch,
  type PersonalCorrectionSourceRow
} from "./personal-source-correction-context.js";
import { readPersonalCorrectionEffects } from "./personal-source-correction-effects.js";

const stale = () =>
  Object.assign(
    new Error(
      "Source context or Project membership changed. Preview the correction again."
    ),
    { statusCode: 409 }
  );
const versionFor = (
  row: PersonalCorrectionSourceRow,
  axis: "git" | "folder"
) =>
  axis === "git"
    ? row.repository_assignment_version
    : row.folder_assignment.revision;
const afterRow = (
  row: PersonalCorrectionSourceRow,
  axis: "git" | "folder",
  patch: Record<string, unknown>,
  revisionId: string
): PersonalCorrectionSourceRow => {
  const next: PersonalCorrectionSourceRow = {
    ...row,
    ...patch,
    repository_assignment_version:
      row.repository_assignment_version + (axis === "git" ? 1 : 0),
    git_revision_id: axis === "git" ? revisionId : row.git_revision_id
  };
  if (row.source_sync) {
    const assignment = personalCorrectionContext({
      ...next,
      source_sync: undefined
    })[axis];
    next.source_sync = {
      ...row.source_sync,
      [axis]: {
        state: "available",
        frontier: [revisionId],
        heads: [{ revisionId, assignment }]
      }
    };
  }
  return next;
};
type ReviewRow = {
  review_id: string;
  axis: "git" | "folder";
  expected_version: number;
  revision_id: string;
  patch: Record<string, unknown>;
  preview: unknown;
  applied_at: Date | null;
};

export const createPersonalSourceCorrectionRepository = (pool: pg.Pool) => ({
  async getPersonalSourceContext(actor: ActorContext, rawSessionId: string) {
    const sessionId = personalOwnerIdSchema.parse(rawSessionId);
    return withPersonalMembershipTransaction(
      pool,
      actor,
      async (client) => ({
        context: personalCorrectionContext(
          await lockPersonalCorrectionSource(client, actor, sessionId)
        )
      }),
      { notify: false }
    );
  },
  async previewPersonalSourceCorrection(
    actor: ActorContext,
    rawSessionId: string,
    raw: PersonalSourceCorrectionInput
  ) {
    const sessionId = personalOwnerIdSchema.parse(rawSessionId),
      input = personalSourceCorrectionInputSchema.parse(raw);
    return withPersonalMembershipTransaction(
      pool,
      actor,
      async (client) => {
        const row = await lockPersonalCorrectionSource(
          client,
          actor,
          sessionId
        );
        if (versionFor(row, input.axis) !== input.expectedVersion)
          throw stale();
        if (
          row.source_body_pending ||
          row.source_sync?.availability === "pending" ||
          row.source_sync?.[input.axis].state === "pending"
        )
          throw Object.assign(
            new Error(
              "The source or its context history is pending. Synchronize it before correcting it."
            ),
            { statusCode: 409 }
          );
        const revisionId = randomUUID(),
          reviewId = randomUUID();
        const patch = await personalCorrectionPatch(
          client,
          actor,
          row,
          input,
          revisionId
        );
        const before = personalCorrectionContext(row),
          after = personalCorrectionContext(
            afterRow(row, input.axis, patch, revisionId)
          );
        const projects = await readPersonalCorrectionEffects(
          client,
          actor,
          sessionId,
          patch
        );
        const preview = personalSourceCorrectionPreviewSchema.parse({
          reviewId,
          axis: input.axis,
          expectedVersion: input.expectedVersion,
          before,
          after,
          projects
        });
        await client.query(
          `insert into personal_source_context_reviews(review_id,owner_user_id,session_id,logical_session_id,axis,expected_version,revision_id,patch,preview) values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            reviewId,
            actor.userId,
            sessionId,
            row.logical_session_id,
            input.axis,
            input.expectedVersion,
            revisionId,
            patch,
            preview
          ]
        );
        return { context: before, preview };
      },
      { notify: false }
    );
  },
  async applyPersonalSourceCorrection(
    actor: ActorContext,
    rawSessionId: string,
    rawReviewId: string,
    raw: { expectedVersion: number }
  ) {
    const sessionId = personalOwnerIdSchema.parse(rawSessionId),
      reviewId = personalOwnerIdSchema.parse(rawReviewId);
    const { expectedVersion } = personalSourceCorrectionApplySchema.parse(raw);
    return withPersonalMembershipTransaction(
      pool,
      actor,
      async (client) => {
        const row = await lockPersonalCorrectionSource(
          client,
          actor,
          sessionId
        );
        const found = await client.query<ReviewRow>(
          "select * from personal_source_context_reviews where owner_user_id=$1 and session_id=$2 and logical_session_id=$3 and review_id=$4 for update",
          [actor.userId, sessionId, row.logical_session_id, reviewId]
        );
        const review = found.rows[0];
        if (!review)
          throw Object.assign(new Error("Source correction review not found"), {
            statusCode: 404
          });
        const preview = personalSourceCorrectionPreviewSchema.parse(
            review.preview
          ),
          context = personalCorrectionContext(row);
        if (expectedVersion !== review.expected_version) throw stale();
        if (review.applied_at) {
          if (JSON.stringify(context) !== JSON.stringify(preview.after))
            throw stale();
          return { context, preview };
        }
        if (
          versionFor(row, review.axis) !== expectedVersion ||
          JSON.stringify(context) !== JSON.stringify(preview.before)
        )
          throw stale();
        if (row.source_body_pending) throw stale();
        const effects = await readPersonalCorrectionEffects(
          client,
          actor,
          sessionId,
          review.patch
        );
        if (JSON.stringify(effects) !== JSON.stringify(preview.projects))
          throw stale();
        const after = afterRow(
          row,
          review.axis,
          review.patch,
          review.revision_id
        );
        if (
          JSON.stringify(personalCorrectionContext(after)) !==
          JSON.stringify(preview.after)
        )
          throw stale();
        await client.query(
          "select set_config('koed.personal_source_context_review_id',$1,true)",
          [reviewId]
        );
        if (review.axis === "git") {
          await client.query(
            "update sessions set repository_override_identity=$3,repository_assignment_revision_id=$4,repository_assignment_version=repository_assignment_version+1,updated_at=now() where owner_user_id=$1 and id=$2",
            [
              actor.userId,
              sessionId,
              review.patch.repository_override_identity,
              review.revision_id
            ]
          );
        } else {
          await client.query(
            "update sessions set folder_assignment=$3,updated_at=now() where owner_user_id=$1 and id=$2",
            [actor.userId, sessionId, review.patch.folder_assignment]
          );
        }
        await client.query(
          "insert into personal_source_context_changes(revision_id,owner_user_id,logical_session_id,axis,version,previous,value) values($1,$2,$3,$4,$5,$6,$7)",
          [
            review.revision_id,
            actor.userId,
            row.logical_session_id,
            review.axis,
            expectedVersion + 1,
            {
              context,
              repositoryAutomaticIdentity: row.repository_automatic_identity,
              repositoryOverrideIdentity: row.repository_override_identity
            },
            {
              context: preview.after,
              repositoryAutomaticIdentity: after.repository_automatic_identity,
              repositoryOverrideIdentity: after.repository_override_identity
            }
          ]
        );
        await recordBoundPersonalSourceCorrection(client, {
          ownerUserId: actor.userId,
          sessionId,
          axis: review.axis,
          revisionId: review.revision_id,
          assignment: preview.after[review.axis]
        });
        await client.query(
          "update personal_source_context_reviews set applied_at=now() where review_id=$1",
          [reviewId]
        );
        await client.query(
          "select pg_notify('koed_pds_local_sync','personal_source_context_changed')"
        );
        return { context: preview.after, preview };
      },
      { kind: "personal_source_context_changed" }
    );
  }
});
export type PersonalSourceCorrectionRepository = ReturnType<
  typeof createPersonalSourceCorrectionRepository
>;
