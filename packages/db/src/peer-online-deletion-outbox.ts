import { createHash } from "node:crypto";
import type pg from "pg";
import {
  inspectPeerMembership,
  peerOnlineDeletionIdentity,
  samePeerOnlineDeletionIdentity,
  lookupHistoricalPeerMember,
  validatePeerOnlineDeletion,
  type PeerMembershipAnchor,
  type PeerMembershipState
} from "@koed/shared";
import { replay, transaction } from "./peer-online-membership-repository.js";
import { assertPeerOnlineNotQuarantined } from "./peer-online-restore-quarantine.js";

/**
 * Internal, trusted boundary: caller must establish that the local session and
 * peer session refer to the same source. This repository does not authenticate
 * callers, transmit records, acknowledge peers, or fence non-cooperating writers.
 * Pending rows are retained permanently, including across membership changes.
 */
export function createPeerOnlineDeletionOutbox(pool: pg.Pool) {
  return {
    async request(
      groupId: string,
      sessionKey: string,
      ownerUserId: string,
      localSessionId: string
    ) {
      return transaction(pool, groupId, async (client) => {
        const peer = await client.query(
          "select 1 from peer_online_sessions where group_id=$1 and session_key=$2 for update",
          [groupId, sessionKey]
        );
        if (!peer.rowCount) return { status: "invalid" as const };
        const session = await client.query(
          "select 1 from sessions where id=$1 and owner_user_id=$2 and visibility='personal' for update",
          [localSessionId, ownerUserId]
        );
        if (!session.rowCount) return { status: "invalid" as const };
        const existing = await client.query<{
          owner_user_id: string;
          local_session_id: string;
        }>(
          "select owner_user_id,local_session_id from peer_online_deletion_outbox where group_id=$1 and session_key=$2 for update",
          [groupId, sessionKey]
        );
        if (
          existing.rows[0] &&
          (existing.rows[0].owner_user_id !== ownerUserId ||
            existing.rows[0].local_session_id !== localSessionId)
        )
          return { status: "invalid" as const };
        await client.query(
          "insert into peer_online_deletion_outbox(group_id,session_key,owner_user_id,local_session_id) values($1,$2,$3,$4) on conflict(group_id,session_key) do nothing",
          [groupId, sessionKey, ownerUserId, localSessionId]
        );
        await client.query(
          "delete from peer_online_checkpoints where group_id=$1 and session_key=$2",
          [groupId, sessionKey]
        );
        await hideSession(client, ownerUserId, localSessionId);
        return { status: "pending" as const };
      });
    },
    async pending(anchor: PeerMembershipAnchor) {
      return transaction(pool, anchor.groupId, async (client) => {
        const state = await replay(client, anchor);
        await assertPeerOnlineNotQuarantined(client, anchor);
        const result = await client.query<{
          session_key: string;
          owner_user_id: string;
          local_session_id: string;
          binding: string;
          binding_hash: string;
          deletion: string | null;
          deletion_hash: string | null;
          prepared_deletion: string | null;
        }>(
          `select o.session_key,o.owner_user_id,o.local_session_id,s.binding,s.binding_hash,
                  s.deletion,s.deletion_hash,o.prepared_deletion
           from peer_online_deletion_outbox o join peer_online_sessions s using(group_id,session_key)
           where o.group_id=$1 order by o.created_at,o.session_key`,
          [anchor.groupId]
        );
        return result.rows.map(
          ({ binding_hash, deletion, deletion_hash, ...row }) => {
            const checked = row.prepared_deletion
              ? validateDeletion(
                  state,
                  anchor,
                  row.binding,
                  binding_hash,
                  row.prepared_deletion
                )
              : undefined;
            const preparedIdentity = row.prepared_deletion
              ? peerOnlineDeletionIdentity(row.prepared_deletion)
              : undefined;
            const floor =
              deletion && deletion_hash
                ? verifiedFloor(deletion, deletion_hash)
                : undefined;
            return {
              ...row,
              prepared_deletion:
                checked?.status === "accepted" &&
                checked.sessionKey === row.session_key &&
                preparedIdentity !== undefined &&
                floor !== undefined &&
                samePeerOnlineDeletionIdentity(preparedIdentity, floor.identity)
                  ? row.prepared_deletion
                  : null
            };
          }
        );
      });
    },
    async prepare(
      anchor: PeerMembershipAnchor,
      sessionKey: string,
      deletion: string
    ) {
      return transaction(pool, anchor.groupId, async (client) => {
        const state = await replay(client, anchor);
        await assertPeerOnlineNotQuarantined(client, anchor);
        const row = (
          await client.query<{
            binding: string;
            binding_hash: string;
            deletion: string | null;
            deletion_hash: string | null;
          }>(
            `select binding,binding_hash,deletion,deletion_hash
             from peer_online_sessions where group_id=$1 and session_key=$2 for update`,
            [anchor.groupId, sessionKey]
          )
        ).rows[0];
        if (!row) return { status: "invalid" as const };
        const outbox = (
          await client.query<{
            prepared_deletion: string | null;
            owner_user_id: string;
            local_session_id: string;
          }>(
            `select prepared_deletion,owner_user_id,local_session_id
             from peer_online_deletion_outbox where group_id=$1 and session_key=$2 for update`,
            [anchor.groupId, sessionKey]
          )
        ).rows[0];
        if (!outbox) return { status: "invalid" as const };
        const result = validateDeletion(
          state,
          anchor,
          row.binding,
          row.binding_hash,
          deletion
        );
        const nextIdentity = peerOnlineDeletionIdentity(deletion);
        const floor =
          row.deletion && row.deletion_hash
            ? verifiedFloor(row.deletion, row.deletion_hash)
            : undefined;
        const previousPrepared = outbox.prepared_deletion
          ? peerOnlineDeletionIdentity(outbox.prepared_deletion)
          : undefined;
        if (
          result.status !== "accepted" ||
          result.sessionKey !== sessionKey ||
          !nextIdentity ||
          ((row.deletion !== null || row.deletion_hash !== null) && !floor) ||
          (floor &&
            !samePeerOnlineDeletionIdentity(nextIdentity, floor.identity)) ||
          (outbox.prepared_deletion !== null && !previousPrepared) ||
          (previousPrepared &&
            !samePeerOnlineDeletionIdentity(nextIdentity, previousPrepared))
        )
          return { status: "invalid" as const };
        await client.query(
          "update peer_online_deletion_outbox set prepared_deletion=$3 where group_id=$1 and session_key=$2",
          [anchor.groupId, sessionKey, deletion]
        );
        if (!floor)
          await client.query(
            "update peer_online_sessions set deletion_hash=$3, deletion=$4 where group_id=$1 and session_key=$2",
            [anchor.groupId, sessionKey, result.eventHash, deletion]
          );
        return { status: "prepared" as const };
      });
    }
  };
}

const deletionDomain = "koed/peer-online-deletion/v1/record\n";

function verifiedFloor(json: string, expectedHash: string) {
  try {
    const identity = peerOnlineDeletionIdentity(json);
    const hash = createHash("sha256")
      .update(deletionDomain)
      .update(json)
      .digest("base64url");
    return identity && hash === expectedHash ? { identity } : undefined;
  } catch {
    return undefined;
  }
}

function validateDeletion(
  state: PeerMembershipState,
  anchor: PeerMembershipAnchor,
  binding: string,
  bindingHash: string,
  deletion: string
) {
  const view = inspectPeerMembership(state);
  return validatePeerOnlineDeletion(
    binding,
    deletion,
    {
      historicalOriginKey: (group, id) => {
        if (group !== anchor.groupId) return undefined;
        const member = lookupHistoricalPeerMember(state, id);
        return member.status === "found"
          ? member.member.signingPublicKey
          : undefined;
      },
      currentAuthorKey: (group, head, id) =>
        group === anchor.groupId && head === view.head
          ? view.members.find((member) => member.deviceId === id)
              ?.signingPublicKey
          : undefined
    },
    bindingHash
  );
}

/** Marks a personal Session and its derived Recall rows deleted. Caller owns the transaction. */
export async function hideSession(
  client: pg.PoolClient,
  owner: string,
  session: string
) {
  for (const table of [
    "sessions",
    "memory_events",
    "memory_nodes",
    "conversation_items"
  ]) {
    const key = table === "sessions" ? "id" : "session_id";
    await client.query(
      `update ${table} set personal_deleted_at=coalesce(personal_deleted_at,now()), personal_deleted_by_user_id=coalesce(personal_deleted_by_user_id,$1), personal_deletion_reason=coalesce(personal_deletion_reason,'peer_online_deletion') where owner_user_id=$1 and ${key}=$2 and visibility='personal'`,
      [owner, session]
    );
  }
  await client.query(
    `update memory_embeddings set personal_deleted_at=coalesce(personal_deleted_at,now()), personal_deleted_by_user_id=coalesce(personal_deleted_by_user_id,$1), personal_deletion_reason=coalesce(personal_deletion_reason,'peer_online_deletion')
    where owner_user_id=$1 and visibility='personal' and (memory_event_id in (select id from memory_events where owner_user_id=$1 and session_id=$2) or memory_node_id in (select id from memory_nodes where owner_user_id=$1 and session_id=$2))`,
    [owner, session]
  );
}
