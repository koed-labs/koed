import type pg from "pg";
import {
  crossIdentitySyncDeterministicUuid,
  sharingRuleSourceIdentityHash,
  SharedMemoryConflictError,
  type SharingRuleSourceIdentity
} from "@koed/shared";

/** Prove the native authoritative source before retaining an opaque Personal
 * origin digest. The caller holds its owner/source authority transaction. */
export const verifiedNativeSharingRuleSourceIdentityHash = async (
  client: pg.PoolClient,
  input: {
    ownerUserId: string;
    logicalMemoryId: string;
    sourceSessionId: string;
    publisherCredentialId: string;
    identity: SharingRuleSourceIdentity;
  }
): Promise<string> => {
  const result = await client.query<{
    protocol_deployment_id: string;
    source_owner_principal_id: string;
  }>(
    `select credential.metadata->>'protocolDeploymentId' as protocol_deployment_id,
       credential.metadata->>'sourceOwnerPrincipalId' as source_owner_principal_id
     from device_credentials credential
     join logical_memories memory on memory.id=$3 and memory.owner_user_id=$2
       and memory.owner_principal_id::text=credential.metadata->>'sourceOwnerPrincipalId'
     join captured_session_logical_memories source on source.logical_memory_id=memory.id
       and source.source_session_id=$4
     where credential.id=$1 and credential.owner_user_id=$2
       and credential.revoked_at is null
       and (credential.expires_at is null or credential.expires_at>now())
       and credential.operation_families @> ARRAY['share_grant_management','sync']::text[]`,
    [
      input.publisherCredentialId,
      input.ownerUserId,
      input.logicalMemoryId,
      input.sourceSessionId
    ]
  );
  const native = result.rows[0];
  if (
    !native ||
    crossIdentitySyncDeterministicUuid({
      protocol: "koed.captured-session-sync/v2",
      sourceDeploymentId: native.protocol_deployment_id,
      sourceUserId: native.source_owner_principal_id,
      originSessionId: input.sourceSessionId,
      identity: "logical-memory"
    }) !== input.logicalMemoryId
  )
    throw new SharedMemoryConflictError(
      "Only the native source publisher may bind its Personal origin"
    );
  return sharingRuleSourceIdentityHash(input.ownerUserId, input.identity);
};

/** The caller holds the owner/source and rule locks. A native publisher may
 * attach its verified Personal origin once; a receiver must resolve that origin
 * rather than inventing a new Captured Session identity. Only its digest rests
 * in the Team membership row. */
export const bindSharingRuleSourceIdentity = async (
  client: pg.PoolClient,
  input: {
    ownerUserId: string;
    ruleId: string;
    membershipId: string;
    logicalMemoryId: string;
    sourceSessionId: string;
    publisherCredentialId: string;
    identity?: SharingRuleSourceIdentity;
  }
) => {
  if (!input.identity) return;
  const hash = await verifiedNativeSharingRuleSourceIdentityHash(client, {
    ...input,
    identity: input.identity
  });
  const collision = await client.query(
    `select id from team_memory_sharing_rule_members where rule_id=$1
       and portable_source_hash=$2 and id<>$3`,
    [input.ruleId, hash, input.membershipId]
  );
  if (collision.rowCount)
    throw new SharedMemoryConflictError(
      "This Personal origin already identifies another rule member"
    );
  const bound = await client.query(
    `update team_memory_sharing_rule_members set portable_source_hash=$2
       where id=$1 and rule_id=$3 and owner_user_id=$4 and logical_memory_id=$5
         and (portable_source_hash is null or portable_source_hash=$2)
       returning id`,
    [
      input.membershipId,
      hash,
      input.ruleId,
      input.ownerUserId,
      input.logicalMemoryId
    ]
  );
  if (!bound.rowCount)
    throw new SharedMemoryConflictError("The verified Personal origin changed");
};

/** Publisher authorization is checked by the caller. Missing identity evidence
 * returns no binding; local UUIDs and provider IDs are never substitutes. */
export const resolveSharingRuleSourceIdentity = async (
  client: pg.PoolClient,
  input: {
    ownerUserId: string;
    ruleId: string;
    identity: SharingRuleSourceIdentity;
  }
): Promise<string | null> => {
  const result = await client.query<{ logical_memory_id: string }>(
    `select member.logical_memory_id from team_memory_sharing_rule_members member
       join logical_memories memory on memory.id=member.logical_memory_id
         and memory.owner_user_id=member.owner_user_id
       where member.rule_id=$1 and member.owner_user_id=$2
         and member.portable_source_hash=$3`,
    [
      input.ruleId,
      input.ownerUserId,
      sharingRuleSourceIdentityHash(input.ownerUserId, input.identity)
    ]
  );
  return result.rows.length === 1 ? result.rows[0]!.logical_memory_id : null;
};

/** The caller has locked the exact current publication authority and validated
 * the original authoritative sync context. A transfer changes the rule writer,
 * never the source credential or origin. Only native-bound existing members may
 * use this exception, backed by the owner's committed native transfer receipt. */
export const hasReviewedSharingRulePublisherTransfer = async (
  client: pg.PoolClient,
  input: {
    ownerUserId: string;
    ruleId: string;
    logicalMemoryId: string;
    publisherCredentialId: string;
    publisherFence: number;
  }
): Promise<boolean> => {
  const proof = await client.query(
    `select 1 from team_memory_sharing_rule_members member
       join audit_events transfer on transfer.owner_user_id=member.owner_user_id
         and transfer.target_table='team_memory_sharing_rules' and transfer.target_id=member.rule_id
         and transfer.action='shared_memory.publisher_transferred'
       where member.owner_user_id=$1 and member.rule_id=$2 and member.logical_memory_id=$3
         and member.state='present' and member.portable_source_hash is not null
         and transfer.metadata->'result'->>'publisherCredentialId'=$4
         and (transfer.metadata->'result'->>'publisherFence')::bigint<=$5::bigint`,
    [
      input.ownerUserId,
      input.ruleId,
      input.logicalMemoryId,
      input.publisherCredentialId,
      input.publisherFence
    ]
  );
  return Boolean(proof.rowCount);
};
