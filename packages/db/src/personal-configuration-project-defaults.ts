import type pg from "pg";
import {
  decodePdsPersonalProjectDefaultDecision,
  personalProjectDefaultDecisionSchema,
  type PersonalProjectDefaultDecision,
  type PersonalConfigurationRecord
} from "@koed/shared";
import { personalProjectDefaultIdentity } from "@koed/shared/personal-project-default";
import {
  withPersonalConfigurationPublication,
  type PersonalConfigurationPublicationScope
} from "./personal-configuration-authority.js";
import type { PersonalConfigurationLocalDevice } from "./personal-configuration-membership.js";

/** Source decisions share the authenticated encrypted configuration channel.
 * Initialized sources publish as managed; catalog/rule history carries their provenance. */
export const createPersonalConfigurationProjectDefaultRepository = (
  pool: pg.Pool
) => ({
  async listPersonalConfigurationProjectDefaults(
    input: PersonalConfigurationPublicationScope & {
      afterSourceKey?: string;
      limit?: number;
    }
  ): Promise<{
    snapshots: PersonalProjectDefaultDecision[];
    nextSourceKey: string | null;
  }> {
    return withPersonalConfigurationPublication(
      pool,
      input,
      { snapshots: [], nextSourceKey: null },
      async (client) => {
        const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
        const result = await client.query<{
          source_key: string;
          target: unknown;
          state: string;
        }>(
          "select source_key,target,state from personal_project_defaults where owner_user_id=$1 and ($2::text is null or source_key>$2) order by source_key limit $3",
          [input.userId, input.afterSourceKey ?? null, limit]
        );
        return {
          snapshots: result.rows.map((row) =>
            personalProjectDefaultDecisionSchema.parse({
              version: 1,
              sourceKey: row.source_key,
              target: row.target,
              state: row.state === "initialized" ? "managed" : row.state
            })
          ),
          nextSourceKey:
            result.rows.length === limit ? result.rows.at(-1)!.source_key : null
        };
      }
    );
  }
});

/** The enclosing record has a verified active witness. An equal key alone is
 * never sufficient. Decisions only prevent automatic creation; they do not
 * remove User memberships, create source rows, or establish local execution. */
export const applyVerifiedConfigurationProjectDefault = async (
  client: pg.PoolClient,
  input: {
    ownerUserId: string;
    record: PersonalConfigurationRecord;
    localDevice?: PersonalConfigurationLocalDevice;
    allowApplication: boolean;
  }
): Promise<{ bindingId: null; applied: boolean }> => {
  if (input.record.revision.payload.kind !== "project_default")
    throw new TypeError("PdsCryptoConfigurationPayloadKindError");
  if (!input.allowApplication || !input.localDevice)
    return { bindingId: null, applied: false };
  const decision = decodePdsPersonalProjectDefaultDecision(
    input.record.revision.payload.snapshot
  );
  const target =
    decision.target.kind === "folder"
      ? {
          ...decision.target,
          folder: { ...decision.target.folder, ownerUserId: input.ownerUserId }
        }
      : decision.target;
  const identity = personalProjectDefaultIdentity(target);
  if (identity.sourceKey !== decision.sourceKey)
    throw new TypeError("PdsCryptoDefaultSourceIdentityError");
  const updated = await client.query(
    `insert into personal_project_defaults(owner_user_id,source_key,source_scope,target,state)
    values($1,$2,$3,$4,$5) on conflict(owner_user_id,source_key) do update set
      state=excluded.state,revision_id=gen_random_uuid(),updated_at=now()
    where (case personal_project_defaults.state when 'initialized' then 0 when 'managed' then 0 when 'retired' then 1 else 2 end)
      < (case excluded.state when 'managed' then 0 when 'retired' then 1 else 2 end)
    returning source_key`,
    [
      input.ownerUserId,
      identity.sourceKey,
      identity.sourceScope,
      target,
      decision.state
    ]
  );
  if (updated.rowCount) {
    await client.query(
      `insert into personal_project_default_reconciliation(owner_user_id) values($1)
      on conflict(owner_user_id) do update set generation=personal_project_default_reconciliation.generation+1,pending=true,retry_at=now(),updated_at=now()`,
      [input.ownerUserId]
    );
    await client.query(
      "select pg_notify('koed_project_defaults','source_decision_changed')"
    );
  }
  return { bindingId: null, applied: true };
};
