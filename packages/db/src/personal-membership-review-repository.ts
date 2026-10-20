import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type pg from "pg";
import {
  personalIdentifierSchema,
  personalOwnerIdSchema,
  personalMembershipReviewInputSchema,
  personalMembershipReviewApplySchema,
  personalMembershipReviewPreviewSchema,
  personalMembershipSourceFromSelectorKey,
  personalMembershipSelectorKey,
  type PersonalMembershipReviewInput,
  type PersonalMembershipRevision
} from "@koed/shared";
import type { ActorContext } from "./types.js";
import { withPersonalMembershipTransaction } from "./personal-membership-repository.js";
import { retainReviewedPersonalMembershipRevision } from "./personal-membership-causal-history.js";
import { projectPersonalMembershipState } from "./personal-membership-projection.js";
import {
  readPersonalMembershipSyncState,
  loadPersonalMembershipReviewState,
  personalMembershipReviewStale,
  personalMembershipReviewUnavailable
} from "./personal-membership-review-state.js";

export const createPersonalMembershipReviewRepository = (pool: pg.Pool) => ({
  async getPersonalMembershipSyncState(
    actor: ActorContext,
    rawProjectId: string,
    rawAfterEntityId?: string
  ) {
    const projectId = personalOwnerIdSchema.parse(rawProjectId),
      afterEntityId =
        rawAfterEntityId === undefined
          ? undefined
          : personalIdentifierSchema.parse(rawAfterEntityId);
    return withPersonalMembershipTransaction(
      pool,
      actor,
      (client) =>
        readPersonalMembershipSyncState(
          client,
          actor.userId,
          projectId,
          afterEntityId
        ),
      { notify: false }
    );
  },
  async previewPersonalMembershipReview(
    actor: ActorContext,
    rawProjectId: string,
    raw: PersonalMembershipReviewInput
  ) {
    const projectId = personalOwnerIdSchema.parse(rawProjectId),
      input = personalMembershipReviewInputSchema.parse(raw);
    return withPersonalMembershipTransaction(
      pool,
      actor,
      async (client) => {
        const state = await loadPersonalMembershipReviewState(
          client,
          actor.userId,
          projectId,
          input.entityId
        );
        if (
          state.project.version !== input.expectedVersion ||
          !isDeepStrictEqual(
            [...input.expectedHeads].sort(),
            state.expectedState.entityHeads
          )
        )
          throw personalMembershipReviewStale();
        if (state.entity.state === "pending" || !state.entity.heads.length)
          throw Object.assign(
            new Error(
              "Membership history is still pending. Synchronize it before reviewing."
            ),
            { statusCode: 409 }
          );
        const catalogActive =
          state.root.state === "available" &&
          state.root.current_revision?.operation.kind === "set_project";
        let operation: PersonalMembershipRevision["operation"];
        if (
          state.entity.entity_kind === "project" &&
          (input.change.kind === "set_project" ||
            input.change.kind === "delete_project")
        ) {
          operation = input.change;
        } else if (
          state.entity.entity_kind === "direct" &&
          (input.change.kind === "include" ||
            input.change.kind === "remove_inclusion")
        ) {
          if (
            input.change.kind === "include" &&
            input.change.candidateRevisionId
          )
            throw Object.assign(
              new Error(
                "A Conversation inclusion does not use a rule candidate."
              ),
              { statusCode: 400 }
            );
          if (input.change.kind === "include" && !catalogActive)
            throw Object.assign(
              new Error(
                "Review the Project catalog before including a Conversation."
              ),
              { statusCode: 409 }
            );
          operation =
            input.change.kind === "include"
              ? {
                  kind: "include",
                  selector: {
                    kind: "session",
                    source: personalMembershipSourceFromSelectorKey(
                      state.entity.selector_key!,
                      actor.userId
                    )
                  }
                }
              : { kind: "remove_inclusion" };
        } else if (
          state.entity.entity_kind === "rule" &&
          (input.change.kind === "include" ||
            input.change.kind === "remove_inclusion")
        ) {
          if (input.change.kind === "remove_inclusion")
            operation = { kind: "remove_inclusion" };
          else {
            if (!catalogActive)
              throw Object.assign(
                new Error(
                  "Review the Project catalog before including a rule."
                ),
                { statusCode: 409 }
              );
            const candidates = state.before.ruleCandidates ?? [];
            const candidateId = input.change.candidateRevisionId;
            const candidate = candidateId
              ? candidates.find((value) => value.revisionId === candidateId)
              : candidates.length === 1
                ? candidates[0]
                : undefined;
            if (
              !candidate ||
              candidate.operation.kind !== "include" ||
              candidate.operation.selector.kind === "session" ||
              personalMembershipSelectorKey(candidate.operation.selector) !==
                state.entity.selector_key
            )
              throw Object.assign(
                new Error("Choose a retained inclusion rule to review."),
                { statusCode: 400 }
              );
            operation = candidate.operation;
          }
        } else if (
          state.entity.entity_kind === "exclusion" &&
          (input.change.kind === "exclude" ||
            input.change.kind === "clear_exclusion")
        ) {
          operation =
            input.change.kind === "exclude"
              ? {
                  kind: "exclude",
                  source: personalMembershipSourceFromSelectorKey(
                    state.entity.selector_key!,
                    actor.userId
                  )
                }
              : { kind: "clear_exclusion" };
        } else
          throw Object.assign(
            new Error("This review does not match the Project membership."),
            { statusCode: 400 }
          );
        const revisionId = randomUUID(),
          reviewId = randomUUID();
        const preview = personalMembershipReviewPreviewSchema.parse({
          reviewId,
          expectedVersion: input.expectedVersion,
          projectIdentity: state.root.project_identity,
          entityId: state.entity.entity_identity,
          before: state.before,
          after: {
            version: 1,
            project: {
              ownerUserId: actor.userId,
              projectId: state.root.project_identity
            },
            entityId: state.entity.entity_identity,
            revisionId,
            authorDeviceId: state.localDeviceId,
            replaces: state.expectedState.entityHeads,
            operation
          },
          effect: {
            catalogActive:
              state.entity.entity_kind === "project"
                ? operation.kind === "set_project"
                : catalogActive,
            sourceReady: state.before.source?.ready ?? null,
            blockedByExclusion: state.blockedByExclusion,
            included:
              state.entity.entity_kind === "direct" &&
              operation.kind === "include" &&
              catalogActive &&
              Boolean(state.before.source?.ready) &&
              !state.blockedByExclusion
          }
        });
        await client.query(
          `insert into personal_membership_resolution_reviews(review_id,owner_user_id,project_identity,entity_identity,
          expected_heads,expected_project_state,revision_id,operation,preview) values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            reviewId,
            actor.userId,
            state.root.project_identity,
            state.entity.entity_identity,
            state.expectedState.entityHeads,
            state.expectedState,
            revisionId,
            operation,
            preview
          ]
        );
        return {
          state: await readPersonalMembershipSyncState(
            client,
            actor.userId,
            projectId
          ),
          preview
        };
      },
      { notify: false }
    );
  },
  async applyPersonalMembershipReview(
    actor: ActorContext,
    rawProjectId: string,
    rawReviewId: string,
    raw: { expectedVersion: number }
  ) {
    const projectId = personalOwnerIdSchema.parse(rawProjectId),
      reviewId = personalOwnerIdSchema.parse(rawReviewId),
      input = personalMembershipReviewApplySchema.parse(raw);
    return withPersonalMembershipTransaction(pool, actor, async (client) => {
      const found = await client.query<{
        entity_identity: string;
        project_identity: string;
        expected_project_state: unknown;
        preview: unknown;
        applied_at: Date | null;
      }>(
        `select r.* from personal_membership_resolution_reviews r join personal_membership_entities root
         on root.owner_user_id=r.owner_user_id and root.project_identity=r.project_identity and root.entity_kind='project'
         where r.owner_user_id=$1 and r.review_id=$2 and root.local_project_id=$3 for update of r`,
        [actor.userId, reviewId, projectId]
      );
      const review = found.rows[0];
      if (!review) throw personalMembershipReviewUnavailable();
      const preview = personalMembershipReviewPreviewSchema.parse(
        review.preview
      );
      if (preview.expectedVersion !== input.expectedVersion)
        throw personalMembershipReviewStale();
      if (!review.applied_at) {
        const current = await loadPersonalMembershipReviewState(
          client,
          actor.userId,
          projectId,
          review.entity_identity
        );
        if (
          !isDeepStrictEqual(
            current.expectedState,
            review.expected_project_state
          )
        )
          throw personalMembershipReviewStale();
        await client.query(
          "update personal_membership_resolution_reviews set applied_at=now() where review_id=$1",
          [reviewId]
        );
        const retained = await retainReviewedPersonalMembershipRevision(
          client,
          { ownerUserId: actor.userId, reviewId }
        );
        await projectPersonalMembershipState(client, {
          ownerUserId: actor.userId,
          projectIdentity: review.project_identity,
          semanticChanged: retained.changed
        });
        await client.query(
          "select pg_notify('koed_pds_local_sync','personal_membership_changed')"
        );
      }
      return {
        state: await readPersonalMembershipSyncState(
          client,
          actor.userId,
          projectId
        ),
        preview
      };
    });
  }
});
export type PersonalMembershipReviewRepository = ReturnType<
  typeof createPersonalMembershipReviewRepository
>;
