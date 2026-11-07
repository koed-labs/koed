import { createHash, createPublicKey } from "node:crypto";
import type pg from "pg";
import {
  inspectPeerMembership,
  lookupHistoricalPeerMember,
  validatePeerOnlineBinding,
  validatePeerOnlineDeletion,
  verifyPeerOnlineCheckpoint,
  type PeerMembershipAnchor,
  type PeerMembershipState
} from "@koed/shared";
import { hideSession } from "./peer-online-deletion-outbox.js";
import { replay, transaction } from "./peer-online-membership-repository.js";
import { assertPeerOnlineNotQuarantined } from "./peer-online-restore-quarantine.js";
import {
  isPeerOnlineSessionCurrent,
  type PeerOnlineSessionContext
} from "./peer-online-session-fence.js";

const checkpointDomain = "koed/peer-online-checkpoint/v1/record\n";
const sessionCheckpointLimit = 16;
const groupCheckpointLimit = 128;
const sessionByteLimit = 32 * 1024 * 1024;
const groupByteLimit = 128 * 1024 * 1024;
type Session = {
  binding_hash: string;
  deletion_hash: string | null;
  checkpoint_sequence: string | null;
  checkpoint_hash: string | null;
};

function historicalKey(
  state: PeerMembershipState,
  deviceId: string
): string | undefined {
  const result = lookupHistoricalPeerMember(state, deviceId);
  return result.status === "found" ? result.member.signingPublicKey : undefined;
}

async function session(
  client: pg.PoolClient,
  groupId: string,
  key: string
): Promise<Session | undefined> {
  return (
    await client.query<Session>(
      "select binding_hash, deletion_hash, checkpoint_sequence, checkpoint_hash from peer_online_sessions where group_id=$1 and session_key=$2 for update",
      [groupId, key]
    )
  ).rows[0];
}

/** Internal persistence boundary only. Does not materialize, acknowledge, or resist database rollback.
 * Restrict writes to cooperating repositories and rate-limit inputs before invoking. */
export function createPeerOnlineFloorRepository(pool: pg.Pool) {
  return {
    async acceptDeletion(
      anchor: PeerMembershipAnchor,
      bindingJson: string,
      deletionJson: string,
      localDeviceId: string,
      sessionContext: PeerOnlineSessionContext | undefined
    ) {
      return transaction(pool, anchor.groupId, async (client) => {
        const state = await replay(client, anchor);
        await assertPeerOnlineNotQuarantined(client, anchor);
        if (!isPeerOnlineSessionCurrent(state, localDeviceId, sessionContext))
          return { status: "fenced" as const };
        const view = inspectPeerMembership(state);
        const result = validatePeerOnlineDeletion(bindingJson, deletionJson, {
          historicalOriginKey: (group, id) =>
            group === anchor.groupId ? historicalKey(state, id) : undefined,
          currentAuthorKey: (group, head, id) =>
            group === anchor.groupId && head === view.head
              ? view.members.find((m) => m.deviceId === id)?.signingPublicKey
              : undefined
        });
        if (result.status !== "accepted") return { status: "invalid" as const };
        const existing = await session(
          client,
          anchor.groupId,
          result.sessionKey
        );
        if (existing && existing.binding_hash !== result.bindingHash)
          return { status: "invalid" as const };
        if (existing?.deletion_hash)
          return {
            status:
              existing.deletion_hash === result.eventHash
                ? ("duplicate" as const)
                : ("deleted" as const)
          };
        await client.query(
          `insert into peer_online_sessions (group_id,session_key,binding_hash,binding,deletion_hash,deletion) values ($1,$2,$3,$4,$5,$6)
          on conflict (group_id,session_key) do update set deletion_hash=excluded.deletion_hash,deletion=excluded.deletion`,
          [
            anchor.groupId,
            result.sessionKey,
            result.bindingHash,
            bindingJson,
            result.eventHash,
            deletionJson
          ]
        );
        await client.query(
          "delete from peer_online_checkpoints where group_id=$1 and session_key=$2",
          [anchor.groupId, result.sessionKey]
        );
        // A received group-wide deletion also removes an already materialized
        // replica from local Recall in the same transaction as the floor.
        const replica = (
          await client.query<{
            owner_user_id: string;
            local_session_id: string;
          }>(
            "select owner_user_id,local_session_id from peer_online_replicas where group_id=$1 and session_key=$2 for update",
            [anchor.groupId, result.sessionKey]
          )
        ).rows[0];
        if (replica)
          await hideSession(
            client,
            replica.owner_user_id,
            replica.local_session_id
          );
        return { status: "accepted" as const };
      });
    },
    async acceptCheckpoint(
      anchor: PeerMembershipAnchor,
      bindingJson: string,
      envelope: string,
      payload: Uint8Array,
      localDeviceId: string,
      sessionContext: PeerOnlineSessionContext | undefined
    ) {
      return transaction(pool, anchor.groupId, async (client) => {
        const state = await replay(client, anchor);
        await assertPeerOnlineNotQuarantined(client, anchor);
        const result = await acceptPeerOnlineCheckpointInTransaction(
          client,
          anchor,
          state,
          bindingJson,
          envelope,
          payload,
          localDeviceId,
          sessionContext
        );
        return result.status === "accepted"
          ? { status: result.status, hash: result.hash }
          : { status: result.status };
      });
    }
  };
}

/** Checkpoint floor acceptance inside a caller-owned transaction that already
 * holds the group lock and replayed `state` under it. Records the receipt only;
 * the caller decides whether to materialize and must roll back on any failure. */
export async function acceptPeerOnlineCheckpointInTransaction(
  client: pg.PoolClient,
  anchor: PeerMembershipAnchor,
  state: PeerMembershipState,
  bindingJson: string,
  envelope: string,
  payload: Uint8Array,
  localDeviceId: string,
  sessionContext: PeerOnlineSessionContext | undefined
) {
  await assertPeerOnlineNotQuarantined(client, anchor);
  if (!isPeerOnlineSessionCurrent(state, localDeviceId, sessionContext))
    return { status: "fenced" as const };
  const view = inspectPeerMembership(state);
  const binding = validatePeerOnlineBinding(bindingJson, (group, id) =>
    group === anchor.groupId ? historicalKey(state, id) : undefined
  );
  if (!binding || binding.identity.groupId !== anchor.groupId)
    return { status: "invalid" as const };
  const member = view.members.find(
    (m) => m.deviceId === binding.identity.originDeviceId
  );
  if (!member || !view.head) return { status: "invalid" as const };
  const key = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: member.signingPublicKey },
    format: "jwk"
  });
  const verified = verifyPeerOnlineCheckpoint(
    envelope,
    payload,
    { ...binding.identity, bindingHash: binding.bindingHash },
    key
  );
  if (!verified || verified.unsigned.membershipHeadHash !== view.head)
    return { status: "invalid" as const };
  const existing = await session(client, anchor.groupId, binding.sessionKey);
  if (existing && existing.binding_hash !== binding.bindingHash)
    return { status: "invalid" as const };
  if (existing?.deletion_hash) return { status: "deleted" as const };
  const localFloor = await client.query(
    "select 1 from peer_online_deletion_outbox where group_id=$1 and session_key=$2",
    [anchor.groupId, binding.sessionKey]
  );
  if (localFloor.rowCount) return { status: "deleted" as const };
  const hash = createHash("sha256")
    .update(checkpointDomain)
    .update(envelope)
    .digest("base64url");
  const { sequence, predecessorHash } = verified.unsigned;
  const old = await client.query<{
    hash: string;
    envelope: string;
    payload: string;
  }>(
    "select hash,envelope,payload from peer_online_checkpoints where group_id=$1 and session_key=$2 and sequence=$3",
    [anchor.groupId, binding.sessionKey, sequence]
  );
  if (old.rows[0])
    return old.rows[0].hash === hash &&
      old.rows[0].envelope === envelope &&
      old.rows[0].payload === verified.payload.toString("base64")
      ? {
          status: "duplicate" as const,
          sessionKey: binding.sessionKey,
          sequence,
          hash
        }
      : { status: "invalid" as const };
  const expected =
    existing?.checkpoint_sequence == null
      ? 0n
      : BigInt(existing.checkpoint_sequence) + 1n;
  const current = BigInt(sequence);
  if (current > expected) return { status: "pending" as const };
  if (
    current !== expected ||
    (current === 0n
      ? predecessorHash !== null
      : predecessorHash !== existing?.checkpoint_hash)
  )
    return { status: "invalid" as const };
  const encodedPayload = verified.payload.toString("base64");
  const usage = (
    await client.query<{
      group_count: string;
      session_count: string;
      group_bytes: string;
      session_bytes: string;
    }>(
      `select count(*) as group_count,
    count(*) filter (where session_key=$2) as session_count,
    coalesce(sum(octet_length(envelope)::bigint + octet_length(payload)), 0) as group_bytes,
    coalesce(sum(octet_length(envelope)::bigint + octet_length(payload)) filter (where session_key=$2), 0) as session_bytes
    from peer_online_checkpoints where group_id=$1`,
      [anchor.groupId, binding.sessionKey]
    )
  ).rows[0]!;
  const bytes = Buffer.byteLength(envelope) + Buffer.byteLength(encodedPayload);
  if (
    BigInt(usage.group_count) >= BigInt(groupCheckpointLimit) ||
    BigInt(usage.session_count) >= BigInt(sessionCheckpointLimit) ||
    BigInt(usage.group_bytes) + BigInt(bytes) > BigInt(groupByteLimit) ||
    BigInt(usage.session_bytes) + BigInt(bytes) > BigInt(sessionByteLimit)
  )
    return { status: "quota_exceeded" as const };
  await client.query(
    `insert into peer_online_sessions (group_id,session_key,binding_hash,binding,checkpoint_sequence,checkpoint_hash) values ($1,$2,$3,$4,$5,$6)
    on conflict (group_id,session_key) do update set checkpoint_sequence=excluded.checkpoint_sequence,checkpoint_hash=excluded.checkpoint_hash`,
    [
      anchor.groupId,
      binding.sessionKey,
      binding.bindingHash,
      bindingJson,
      sequence,
      hash
    ]
  );
  await client.query(
    "insert into peer_online_checkpoints (group_id,session_key,sequence,hash,envelope,payload) values ($1,$2,$3,$4,$5,$6)",
    [
      anchor.groupId,
      binding.sessionKey,
      sequence,
      hash,
      envelope,
      encodedPayload
    ]
  );
  return {
    status: "accepted" as const,
    hash,
    sessionKey: binding.sessionKey,
    sourceIdentityCommitment: binding.sourceIdentityCommitment,
    verified
  };
}
