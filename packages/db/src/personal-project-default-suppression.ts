import { personalProjectDefaultIdentity } from "@koed/shared/personal-project-default";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { personalProjectRuleTargetSchema } from "@koed/shared";

/** Caller holds the existing owner membership transaction. Retaining a choice
 * cannot delete Memory or prevent a later explicit inclusion. */
export const suppressPersonalProjectDefault = async (
  client: pg.PoolClient,
  ownerUserId: string,
  raw: unknown
) => {
  const target = personalProjectRuleTargetSchema.parse(raw);
  const identity = personalProjectDefaultIdentity(target);
  await client.query(
    `insert into personal_project_defaults(owner_user_id,source_key,source_scope,target,state,revision_id)
    values($1,$2,$3,$4,'suppressed',$5) on conflict(owner_user_id,source_key) do update set
    state='suppressed',revision_id=excluded.revision_id,updated_at=now() where personal_project_defaults.state<>'suppressed'`,
    [
      ownerUserId,
      identity.sourceKey,
      identity.sourceScope,
      target,
      randomUUID()
    ]
  );
};
