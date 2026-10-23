import type pg from "pg";
import { sharingRulePublisherSchema } from "@koed/shared";

/** Call only from owner-authorized queries. Never add publisher identity to a
 * Team representation, recall result, or reader-facing grant DTO. */
export const sharingRulePublisherSql = (ruleAlias: "rule") => `(
  select jsonb_build_object(
    'credentialId',publisher.id,'deviceInstanceId',publisher.device_instance_id,
    'label',nullif(btrim(publisher.device_label),''),
    'available',publisher.revoked_at is null
      and (publisher.expires_at is null or publisher.expires_at>now())
      and publisher.operation_families @> ARRAY['share_grant_management','sync']::text[]
  ) from device_credentials publisher
  where publisher.id=${ruleAlias}.publisher_credential_id
    and publisher.owner_user_id=${ruleAlias}.owner_user_id
)`;

export const readSharingRulePublisher = async (
  client: pg.PoolClient,
  ownerUserId: string,
  credentialId: string
) => {
  const result = await client.query<{ publisher: unknown }>(
    `select ${sharingRulePublisherSql("rule")} as publisher
       from (values ($1::uuid,$2::uuid)) rule(publisher_credential_id,owner_user_id)`,
    [credentialId, ownerUserId]
  );
  return result.rows[0]?.publisher == null
    ? null
    : sharingRulePublisherSchema.parse(result.rows[0].publisher);
};
