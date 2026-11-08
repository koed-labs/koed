import { createHash } from "node:crypto";
import type pg from "pg";
import {
  inspectPeerMembership,
  peerOnlineDeletionIdentity,
  samePeerOnlineDeletionIdentity,
  lookupHistoricalPeerMember,
  validatePeerOnlineDeletion,
  validatePeerOnlineDeletionAck,
  type PeerMembershipAnchor,
  type PeerMembershipState
} from "@koed/shared";
import { reconcilePeerOnlineDeletionRecipients } from "./peer-online-deletion-roster.js";
import { replay, transaction } from "./peer-online-membership-repository.js";
import { assertPeerOnlineNotQuarantined } from "./peer-online-restore-quarantine.js";

/**
 * Internal, trusted boundary: caller must establish that the local session and
 * peer session refer to the same source. This repository does not authenticate
 * callers, transmit records, or fence non-cooperating writers. It tracks which
 * members must acknowledge each deletion; the transport must deliver and relay.
 * Rows are retained permanently, including across membership changes.
 */
export function createPeerOnlineDeletionOutbox(pool: pg.Pool) {
  return {
    /**
     * Records permanent local deletion intent, hides the local Session and
     * snapshots the recipient roster. Allowed while restore-quarantined, but
     * quarantine keeps the intent from becoming sendable.
     */
    async request(
      anchor: PeerMembershipAnchor,
      sessionKey: string,
      ownerUserId: string,
      localSessionId: string,
      localDeviceId: string
    ) {
      const groupId = anchor.groupId;
      return transaction(pool, groupId, async (client) => {
        const state = await replay(client, anchor);
        if (!localDeviceId || localDeviceId.length > 240)
          return { status: "invalid" as const };
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
          local_device_id: string | null;
        }>(
          "select owner_user_id,local_session_id,local_device_id from peer_online_deletion_outbox where group_id=$1 and session_key=$2 for update",
          [groupId, sessionKey]
        );
        const prior = existing.rows[0];
        if (
          prior &&
          (prior.owner_user_id !== ownerUserId ||
            prior.local_session_id !== localSessionId ||
            (prior.local_device_id !== null &&
              prior.local_device_id !== localDeviceId))
        )
          return { status: "invalid" as const };
        await client.query(
          `insert into peer_online_deletion_outbox(group_id,session_key,owner_user_id,local_session_id,local_device_id) values($1,$2,$3,$4,$5)
           on conflict(group_id,session_key) do update set local_device_id=coalesce(peer_online_deletion_outbox.local_device_id,excluded.local_device_id)`,
          [groupId, sessionKey, ownerUserId, localSessionId, localDeviceId]
        );
        await client.query(
          "delete from peer_online_checkpoints where group_id=$1 and session_key=$2",
          [groupId, sessionKey]
        );
        await hideSession(client, ownerUserId, localSessionId);
        await reconcilePeerOnlineDeletionRecipients(
          client,
          groupId,
          state,
          prior ? undefined : sessionKey
        );
        return { status: "pending" as const };
      });
    },
    /**
     * Pending deletions owed to one recipient, oldest first. `immediate` ignores
     * backoff, for a newly established authenticated session. A null
     * `prepared_deletion` must be re-prepared at the current head before sending.
     */
    async due(
      anchor: PeerMembershipAnchor,
      recipientDeviceId: string,
      options: { immediate?: boolean } = {}
    ) {
      return transaction(pool, anchor.groupId, async (client) => {
        const state = await replay(client, anchor);
        await assertPeerOnlineNotQuarantined(client, anchor);
        await reconcilePeerOnlineDeletionRecipients(
          client,
          anchor.groupId,
          state
        );
        const result = await client.query<OutboxRow>(
          `select o.session_key,o.owner_user_id,o.local_session_id,s.binding,s.binding_hash,
                  s.deletion,s.deletion_hash,o.prepared_deletion
           from peer_online_deletion_recipients r
           join peer_online_deletion_outbox o using(group_id,session_key)
           join peer_online_sessions s using(group_id,session_key)
           where r.group_id=$1 and r.recipient_device_id=$2 and r.state='pending'
             and ($3::boolean or r.next_attempt_at <= now())
           order by o.created_at,o.session_key`,
          [anchor.groupId, recipientDeviceId, options.immediate === true]
        );
        return result.rows.map((row) => sendable(state, anchor, row));
      });
    },
    /** Records a delivery attempt and schedules the next with capped, jittered backoff. */
    async recordAttempt(
      anchor: PeerMembershipAnchor,
      sessionKey: string,
      recipientDeviceId: string
    ) {
      return transaction(pool, anchor.groupId, async (client) => {
        await replay(client, anchor);
        await assertPeerOnlineNotQuarantined(client, anchor);
        const updated = await client.query(
          `update peer_online_deletion_recipients
           set attempts=attempts+1,
               next_attempt_at=now() + make_interval(secs => least(3600, 30 * power(2, least(attempts, 7))) * (0.75 + random() * 0.25))
           where group_id=$1 and session_key=$2 and recipient_device_id=$3 and state='pending'`,
          [anchor.groupId, sessionKey, recipientDeviceId]
        );
        return {
          status: updated.rowCount
            ? ("scheduled" as const)
            : ("ignored" as const)
        };
      });
    },
    /**
     * Records a signed acknowledgement, which may arrive directly or relayed. It
     * is verified with the recipient's historical key and must name this
     * installation's deletion identity and a rostered recipient.
     */
    async recordAck(anchor: PeerMembershipAnchor, ack: string) {
      return transaction(pool, anchor.groupId, async (client) => {
        const state = await replay(client, anchor);
        await assertPeerOnlineNotQuarantined(client, anchor);
        await reconcilePeerOnlineDeletionRecipients(
          client,
          anchor.groupId,
          state
        );
        const checked = validatePeerOnlineDeletionAck(ack, (group, id) => {
          if (group !== anchor.groupId) return undefined;
          const member = lookupHistoricalPeerMember(state, id);
          return member.status === "found"
            ? member.member.signingPublicKey
            : undefined;
        });
        if (checked.status !== "accepted")
          return { status: "invalid" as const };
        const row = (
          await client.query<{
            deletion: string | null;
            deletion_hash: string | null;
            state: string | null;
            ack_hash: string | null;
          }>(
            `select s.deletion,s.deletion_hash,r.state,r.ack_hash
             from peer_online_deletion_outbox o
             join peer_online_sessions s using(group_id,session_key)
             left join peer_online_deletion_recipients r
               on r.group_id=o.group_id and r.session_key=o.session_key and r.recipient_device_id=$3
             where o.group_id=$1 and o.session_key=$2
             for update of o`,
            [
              anchor.groupId,
              checked.identity.sessionKey,
              checked.recipientDeviceId
            ]
          )
        ).rows[0];
        const floor =
          row?.deletion && row.deletion_hash
            ? verifiedFloor(row.deletion, row.deletion_hash)
            : undefined;
        if (
          !row ||
          row.state === null ||
          !floor ||
          !samePeerOnlineDeletionIdentity(floor.identity, checked.identity)
        )
          return { status: "invalid" as const };
        if (row.state === "acked") return { status: "duplicate" as const };
        await client.query(
          `update peer_online_deletion_recipients set state='acked', ack=$4, ack_hash=$5, acked_at=now()
           where group_id=$1 and session_key=$2 and recipient_device_id=$3`,
          [
            anchor.groupId,
            checked.identity.sessionKey,
            checked.recipientDeviceId,
            ack,
            checked.ackHash
          ]
        );
        return { status: "acknowledged" as const };
      });
    },
    /**
     * Completion per local deletion. Completion stops retries only; floors,
     * records and intent are retained for the life of the group.
     */
    async status(anchor: PeerMembershipAnchor) {
      return transaction(pool, anchor.groupId, async (client) => {
        const state = await replay(client, anchor);
        await reconcilePeerOnlineDeletionRecipients(
          client,
          anchor.groupId,
          state
        );
        const result = await client.query<{
          session_key: string;
          local_device_id: string | null;
          pending: number;
          acked: number;
          revoked_unconfirmed: number;
        }>(
          `select o.session_key,o.local_device_id,
                  count(r.*) filter (where r.state='pending')::int as pending,
                  count(r.*) filter (where r.state='acked')::int as acked,
                  count(r.*) filter (where r.state='revoked_unconfirmed')::int as revoked_unconfirmed
           from peer_online_deletion_outbox o
           left join peer_online_deletion_recipients r using(group_id,session_key)
           where o.group_id=$1 group by o.session_key,o.local_device_id,o.created_at
           order by o.created_at,o.session_key`,
          [anchor.groupId]
        );
        return result.rows.map((row) => ({
          sessionKey: row.session_key,
          state:
            row.local_device_id === null
              ? ("roster_unknown" as const)
              : row.pending > 0
                ? ("pending" as const)
                : row.revoked_unconfirmed > 0
                  ? ("complete_unconfirmed" as const)
                  : ("complete" as const),
          recipients: {
            pending: row.pending,
            acked: row.acked,
            revokedUnconfirmed: row.revoked_unconfirmed
          }
        }));
      });
    },
    async pending(anchor: PeerMembershipAnchor) {
      return transaction(pool, anchor.groupId, async (client) => {
        const state = await replay(client, anchor);
        await assertPeerOnlineNotQuarantined(client, anchor);
        const result = await client.query<OutboxRow>(
          `select o.session_key,o.owner_user_id,o.local_session_id,s.binding,s.binding_hash,
                  s.deletion,s.deletion_hash,o.prepared_deletion
           from peer_online_deletion_outbox o join peer_online_sessions s using(group_id,session_key)
           where o.group_id=$1 order by o.created_at,o.session_key`,
          [anchor.groupId]
        );
        return result.rows.map((row) => sendable(state, anchor, row));
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

type OutboxRow = {
  session_key: string;
  owner_user_id: string;
  local_session_id: string;
  binding: string;
  binding_hash: string;
  deletion: string | null;
  deletion_hash: string | null;
  prepared_deletion: string | null;
};

/** Withholds a prepared record that is stale at the current head or names another identity. */
function sendable(
  state: PeerMembershipState,
  anchor: PeerMembershipAnchor,
  { binding_hash, deletion, deletion_hash, ...row }: OutboxRow
) {
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
