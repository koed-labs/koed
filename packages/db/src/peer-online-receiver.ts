import type { KeyObject } from "node:crypto";
import type pg from "pg";
import {
  decryptPeerOnlinePayload,
  derivePeerOnlineSourceIdentityCommitment,
  inspectPeerMembership,
  parsePeerOnlineSessionSnapshot,
  type PeerMembershipAnchor
} from "@koed/shared";
import { acceptPeerOnlineCheckpointInTransaction } from "./peer-online-floor-repository.js";
import {
  isPeerOnlineSessionCurrent,
  type PeerOnlineSessionContext
} from "./peer-online-session-fence.js";
import { materializePeerOnlineCheckpoint } from "./peer-online-materialization-repository.js";
import { replay, transaction } from "./peer-online-membership-repository.js";
import { assertPeerOnlineNotQuarantined } from "./peer-online-restore-quarantine.js";
import type { ConversationItemInput } from "./types.js";

export type PeerOnlineCheckpointAck = {
  sessionKey: string;
  sequence: string;
  hash: string;
};

/**
 * `accepted` and `duplicate` are durable: they are returned only after the
 * receipt and the read-only replica committed together, so the caller may
 * acknowledge them. Every other status must not be acknowledged.
 */
export type PeerOnlineReceiveResult =
  | { status: "accepted" | "duplicate"; ack: PeerOnlineCheckpointAck }
  | {
      status: "pending" | "deleted" | "invalid" | "quota_exceeded" | "fenced";
    };

export type PeerOnlineReceiverIdentity = {
  anchor: PeerMembershipAnchor;
  deviceId: string;
  encryptionPrivateKey: KeyObject;
};

class Rejected extends Error {}

/** Binds a peer-online group to exactly one local owner User. Immutable once set. */
export async function bindPeerOnlineGroupOwner(
  pool: pg.Pool,
  anchor: PeerMembershipAnchor,
  ownerUserId: string
): Promise<void> {
  await transaction(pool, anchor.groupId, async (client) => {
    await assertPeerOnlineNotQuarantined(client, anchor);
    const group = await client.query<{ genesis_hash: string }>(
      "select genesis_hash from peer_online_membership_groups where group_id=$1",
      [anchor.groupId]
    );
    if (group.rows[0]?.genesis_hash !== anchor.genesisHash)
      throw new Error("Peer-online group is not initialized for this anchor.");
    await client.query(
      "insert into peer_online_group_owners(group_id,owner_user_id) values($1,$2) on conflict (group_id) do nothing",
      [anchor.groupId, ownerUserId]
    );
    const bound = await client.query<{ owner_user_id: string }>(
      "select owner_user_id from peer_online_group_owners where group_id=$1",
      [anchor.groupId]
    );
    if (bound.rows[0]?.owner_user_id !== ownerUserId)
      throw new Error("Peer-online group is bound to a different owner.");
  });
}

/**
 * Receives one authenticated peer's checkpoint. In a single group-locked
 * transaction it replays fresh membership, verifies the origin signature,
 * binding, predecessor chain and deletion floors, records the receipt,
 * decrypts the payload for this device, validates the snapshot plaintext and
 * materializes the read-only replica. Any failure rolls back the receipt too.
 *
 * The caller passes trusted transport-session context separately from the
 * wire input; this function independently authenticates the origin producer.
 */
export function createPeerOnlineCheckpointReceiver(
  pool: pg.Pool,
  local: PeerOnlineReceiverIdentity
) {
  const { anchor } = local;
  return {
    async receive(
      input: {
        bindingJson: string;
        envelope: string;
        payload: Uint8Array;
      },
      sessionContext: PeerOnlineSessionContext | undefined
    ): Promise<PeerOnlineReceiveResult> {
      try {
        return await transaction(pool, anchor.groupId, async (client) => {
          const owner = (
            await client.query<{ owner_user_id: string }>(
              "select o.owner_user_id from peer_online_group_owners o join peer_online_membership_groups g using (group_id) where o.group_id=$1 and g.genesis_hash=$2",
              [anchor.groupId, anchor.genesisHash]
            )
          ).rows[0]?.owner_user_id;
          if (!owner) return { status: "fenced" as const };
          const state = await replay(client, anchor);
          await assertPeerOnlineNotQuarantined(client, anchor);
          const view = inspectPeerMembership(state);
          if (
            !view.head ||
            !isPeerOnlineSessionCurrent(state, local.deviceId, sessionContext)
          )
            return { status: "fenced" as const };

          const accepted = await acceptPeerOnlineCheckpointInTransaction(
            client,
            anchor,
            state,
            input.bindingJson,
            input.envelope,
            input.payload,
            local.deviceId,
            sessionContext
          );
          if (accepted.status === "duplicate") {
            const replica = (
              await client.query<{ checkpoint_sequence: string }>(
                "select checkpoint_sequence from peer_online_replicas where group_id=$1 and session_key=$2",
                [anchor.groupId, accepted.sessionKey]
              )
            ).rows[0];
            if (
              !replica ||
              BigInt(replica.checkpoint_sequence) < BigInt(accepted.sequence)
            )
              return { status: "invalid" as const };
            return {
              status: "duplicate" as const,
              ack: {
                sessionKey: accepted.sessionKey,
                sequence: accepted.sequence,
                hash: accepted.hash
              }
            };
          }
          if (accepted.status !== "accepted")
            return { status: accepted.status };

          const unsigned = accepted.verified.unsigned;
          // A Session has one origin; its own checkpoints never come back as replicas.
          if (unsigned.originDeviceId === local.deviceId) throw new Rejected();
          const plaintext = decryptPeerOnlinePayload(
            input.envelope,
            input.payload,
            {
              groupId: unsigned.groupId,
              originDeviceId: unsigned.originDeviceId,
              originSessionId: unsigned.originSessionId,
              membershipHeadHash: unsigned.membershipHeadHash,
              sequence: unsigned.sequence,
              predecessorHash: unsigned.predecessorHash,
              bindingHash: unsigned.bindingHash
            },
            {
              groupId: anchor.groupId,
              head: view.head,
              members: view.members.map(
                ({ deviceId, encryptionSpkiSha256 }) => ({
                  deviceId,
                  encryptionSpkiSha256
                })
              )
            },
            local.deviceId,
            local.encryptionPrivateKey,
            input.bindingJson,
            state
          );
          if (!plaintext) throw new Rejected();
          const snapshot = parsePeerOnlineSessionSnapshot(plaintext);
          plaintext.fill(0);
          if (
            !snapshot ||
            derivePeerOnlineSourceIdentityCommitment(snapshot.sourceSession) !==
              accepted.sourceIdentityCommitment
          )
            throw new Rejected();

          const { sourceSession } = snapshot;
          const items: ConversationItemInput[] = snapshot.items.map(
            (item, index) => ({
              ...item,
              sourceKind: sourceSession.sourceKind,
              sourceAdapterVersion: sourceSession.sourceAdapterVersion,
              sourceTransport: "peer_online",
              externalSessionId: sourceSession.externalSessionId,
              sourceSequence:
                item.sourceSequence === undefined
                  ? undefined
                  : Number(item.sourceSequence),
              sourceLineNumber:
                item.sourceLineNumber === undefined
                  ? undefined
                  : Number(item.sourceLineNumber),
              rawJson: JSON.parse(item.rawJson) as unknown,
              // Replaced by the materializer with a receiver-derived key.
              idempotencyKey: `peer-online-item:${index}`
            })
          );
          try {
            await materializePeerOnlineCheckpoint(pool, client, {
              ownerUserId: owner,
              groupId: anchor.groupId,
              sessionKey: accepted.sessionKey,
              bindingHash: unsigned.bindingHash,
              checkpointSequence: unsigned.sequence,
              checkpointHash: accepted.hash,
              sourceSession,
              items
            });
          } catch (error) {
            // Materializer validation failures are plain Errors; database
            // failures carry a SQLSTATE code and must propagate.
            if (error instanceof Error && !("code" in error))
              throw new Rejected();
            throw error;
          }
          return {
            status: "accepted" as const,
            ack: {
              sessionKey: accepted.sessionKey,
              sequence: unsigned.sequence,
              hash: accepted.hash
            }
          };
        });
      } catch (error) {
        if (error instanceof Rejected) return { status: "invalid" };
        throw error;
      }
    }
  };
}
