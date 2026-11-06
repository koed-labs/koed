import type pg from "pg";
import {
  personalOwnerIdSchema,
  personalConversationOrganizationInputSchema,
  personalConversationOrganizationResultSchema,
  type PersonalConversationOrganizationInput,
  type PersonalConversationOrganizationSnapshot
} from "@koed/shared";
import type { ActorContext } from "./types.js";
import {
  createPersonalMembershipRepository,
  withPersonalMembershipTransaction
} from "./personal-membership-repository.js";
import { createPersonalProjectExclusionRepository } from "./personal-project-exclusion-repository.js";
import { createPersonalSourceCorrectionRepository } from "./personal-source-correction-repository.js";

const stale = () =>
  Object.assign(
    new Error(
      "Conversation context or Project membership changed. Review the changes again."
    ),
    { statusCode: 409 }
  );

/** Moves, advanced moves and their inverses share the same owner transaction.
 * No new authority is introduced: every edit uses the existing source,
 * membership and synchronized-exclusion mutation guards. */
export const createPersonalConversationOrganizationRepository = (
  pool: pg.Pool
) => ({
  async organizePersonalConversation(
    actor: ActorContext,
    rawSessionId: string,
    raw: PersonalConversationOrganizationInput
  ) {
    const sessionId = personalOwnerIdSchema.parse(rawSessionId);
    const edit = personalConversationOrganizationInputSchema.parse(raw);
    if (edit.expectedContext.sessionId !== sessionId) throw stale();
    return withPersonalMembershipTransaction(pool, actor, async (client) => {
      const transaction = { ownerUserId: actor.userId, client };
      const sources = createPersonalSourceCorrectionRepository(
        pool,
        transaction
      );
      const memberships = createPersonalMembershipRepository(pool, transaction);
      const exclusions = createPersonalProjectExclusionRepository(
        pool,
        transaction
      );
      const { context } = await sources.getPersonalSourceContext(
        actor,
        sessionId
      );
      if (JSON.stringify(context) !== JSON.stringify(edit.expectedContext))
        throw stale();
      if (edit.corrections.length) {
        const catalog = await client.query<{
          project_id: string;
          version: number;
        }>(
          "select project_id,version from personal_named_projects where owner_user_id=$1 and deleted_at is null order by project_id for update",
          [actor.userId]
        );
        const reviewed = new Map(
          edit.reviewedProjects.map((p) => [p.projectId, p.expectedVersion])
        );
        if (
          catalog.rows.length !== reviewed.size ||
          catalog.rows.some((p) => reviewed.get(p.project_id) !== p.version)
        )
          throw stale();
      }
      const before: PersonalConversationOrganizationSnapshot = {
        context,
        projects: []
      };
      // Verify every affected Project before the first mutation. The owner lock
      // holds this review stable through source correction and membership edits.
      for (const project of [...edit.reviewedProjects].sort((a, b) =>
        a.projectId.localeCompare(b.projectId)
      )) {
        const result = await exclusions.explainPersonalProjectSession(
          actor,
          project.projectId,
          {
            sessionId,
            expectedVersion: project.expectedVersion
          }
        );
        before.projects.push(result);
      }
      for (const correction of edit.corrections) {
        const review = await sources.previewPersonalSourceCorrection(
          actor,
          sessionId,
          correction
        );
        await sources.applyPersonalSourceCorrection(
          actor,
          sessionId,
          review.preview.reviewId,
          {
            expectedVersion: review.preview.expectedVersion
          }
        );
      }
      const versions = new Map(
        before.projects.map((p) => [p.project.projectId, p.project.version])
      );
      for (const desired of edit.memberships) {
        const projectId = desired.projectId;
        const review = () =>
          exclusions.explainPersonalProjectSession(actor, projectId, {
            sessionId,
            expectedVersion: versions.get(projectId)!
          });
        let current = await review();
        const advance = (result: { project: { version: number } }) =>
          versions.set(projectId, result.project.version);
        const direct = () =>
          current.explanation.reasons.filter(
            (reason) => reason.kind === "session"
          );
        const excluded = () =>
          current.explanation.exclusion?.clearedAt === null;
        if (
          current.explanation.syncExclusion &&
          (current.explanation.syncExclusion.state !== "available" ||
            (current.explanation.syncExclusion.blocked && !excluded()))
        )
          throw Object.assign(
            new Error(
              "Review the Project's synchronized exclusion before changing this membership."
            ),
            { statusCode: 409 }
          );

        if (
          excluded() &&
          (!desired.excluded || desired.direct !== !!direct().length)
        ) {
          if (!desired.restoreExclusion) throw stale();
          advance(
            await exclusions.restorePersonalProjectSession(actor, projectId, {
              sessionId,
              expectedVersion: versions.get(projectId)!,
              ...desired.restoreExclusion
            })
          );
          current = await review();
        } else if (desired.restoreExclusion) {
          // Never accept a stale restoration as a fresh ordinary inclusion.
          throw stale();
        }
        if (desired.direct && !direct().length) {
          advance(
            await memberships.addPersonalProjectSession(actor, projectId, {
              sessionId,
              expectedVersion: versions.get(projectId)!
            })
          );
        } else if (!desired.direct) {
          for (const inclusion of direct()) {
            advance(
              await memberships.removePersonalProjectInclusion(
                actor,
                projectId,
                inclusion.inclusionId,
                {
                  expectedVersion: versions.get(projectId)!
                }
              )
            );
          }
        }
        if (desired.excluded && !excluded()) {
          advance(
            await exclusions.excludePersonalProjectSession(actor, projectId, {
              sessionId,
              expectedVersion: versions.get(projectId)!
            })
          );
        }
      }
      const after: PersonalConversationOrganizationSnapshot = {
        context: (await sources.getPersonalSourceContext(actor, sessionId))
          .context,
        projects: []
      };
      for (const [projectId, expectedVersion] of versions) {
        after.projects.push(
          await exclusions.explainPersonalProjectSession(actor, projectId, {
            sessionId,
            expectedVersion
          })
        );
      }
      const organization = personalConversationOrganizationResultSchema.parse({
        before,
        after
      });
      return { context: after.context, organization };
    });
  }
});
export type PersonalConversationOrganizationRepository = ReturnType<
  typeof createPersonalConversationOrganizationRepository
>;
