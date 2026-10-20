import { isDeepStrictEqual } from "node:util";
import type pg from "pg";
import type { PersonalMembershipRevision } from "@koed/shared";
import type { PersonalMembershipEntityRow } from "./personal-membership-causal-history.js";

/** Follow each causal branch to its closest inclusion. A removed rule retains
 * its selector; concurrent different selectors require an explicit choice.
 */
export const loadPersonalMembershipRuleCandidates = async (
  client: pg.PoolClient,
  entity: PersonalMembershipEntityRow
): Promise<PersonalMembershipRevision[]> => {
  if (entity.entity_kind !== "rule" || entity.state === "pending") return [];
  const result = await client.query<{ revision: PersonalMembershipRevision }>(
    `select revision from personal_membership_revisions where owner_user_id=$1
      and project_identity=$2 and entity_identity=$3 order by revision_id`,
    [entity.owner_user_id, entity.project_identity, entity.entity_identity]
  );
  const revisions = new Map(
    result.rows.map(({ revision }) => [revision.revisionId, revision])
  );
  const pending = [...entity.heads],
    visited = new Set<string>();
  const candidates: PersonalMembershipRevision[] = [];
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const revision = revisions.get(id);
    if (!revision)
      throw new TypeError("PersonalMembershipFrontierUnavailableError");
    if (revision.operation.kind === "include") {
      if (
        !candidates.some((candidate) =>
          isDeepStrictEqual(candidate.operation, revision.operation)
        )
      )
        candidates.push(revision);
    } else pending.push(...revision.replaces);
  }
  return candidates.sort((a, b) => a.revisionId.localeCompare(b.revisionId));
};
