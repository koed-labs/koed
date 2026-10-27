import type pg from "pg";
import {
  personalProjectBatchInputSchema,
  personalOwnerIdSchema,
  type PersonalProjectBatchInput
} from "@koed/shared";
import type { ActorContext } from "./types.js";
import {
  createPersonalMembershipRepository,
  lockPersonalNamedProject,
  mapPersonalNamedProject,
  withPersonalMembershipTransaction
} from "./personal-membership-repository.js";
import { createPersonalProjectRuleRepository } from "./personal-project-rule-repository.js";
import { createPersonalProjectExclusionRepository } from "./personal-project-exclusion-repository.js";

/** Reuse the normal membership operations under one owner lock and transaction.
 * A stale review, unavailable source or failed mutation rolls back the entire draft. */
export const createPersonalProjectBatchRepository = (pool: pg.Pool) => ({
  async applyPersonalProjectSources(
    actor: ActorContext,
    rawProjectId: string,
    raw: PersonalProjectBatchInput
  ) {
    const projectId = personalOwnerIdSchema.parse(rawProjectId),
      input = personalProjectBatchInputSchema.parse(raw);
    return withPersonalMembershipTransaction(pool, actor, async (client) => {
      let project = mapPersonalNamedProject(
        await lockPersonalNamedProject(
          client,
          actor,
          projectId,
          input.expectedVersion
        )
      );
      const transaction = { ownerUserId: actor.userId, client };
      const membership = createPersonalMembershipRepository(pool, transaction),
        rules = createPersonalProjectRuleRepository(pool, transaction),
        exclusions = createPersonalProjectExclusionRepository(
          pool,
          transaction
        );
      for (const change of input.changes) {
        const version = { expectedVersion: project.version };
        const result = await (async () => {
          switch (change.action) {
            case "add_repository":
              return rules.addPersonalProjectRepositoryRule(actor, projectId, {
                ...version,
                repository: change.repository
              });
            case "add_folder":
              return rules.addPersonalProjectFolderRule(actor, projectId, {
                ...version,
                folder: change.folder
              });
            case "add_session":
              return membership.addPersonalProjectSession(actor, projectId, {
                ...version,
                sessionId: change.sessionId
              });
            case "remove_rule":
              return rules.removePersonalProjectRule(
                actor,
                projectId,
                change.inclusionId,
                version
              );
            case "remove_inclusion":
              return membership.removePersonalProjectInclusion(
                actor,
                projectId,
                change.inclusionId,
                version
              );
            case "exclude_session":
              return exclusions.excludePersonalProjectSession(
                actor,
                projectId,
                { ...version, sessionId: change.sessionId }
              );
          }
        })();
        project = result.project;
      }
      return { project };
    });
  }
});
export type PersonalProjectBatchRepository = ReturnType<
  typeof createPersonalProjectBatchRepository
>;
