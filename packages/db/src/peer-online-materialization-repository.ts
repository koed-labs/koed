import { createHash } from "node:crypto";
import type pg from "pg";
import { createCapturedSessionRepository } from "./captured-session-repository.js";
import {
  createConversationItemRepository,
  type ConversationItemRepositoryOptions
} from "./conversation-item-repository.js";
import type { ConversationItemInput } from "./types.js";

type SessionInput = {
  sourceKind: string;
  sourceAdapterVersion: string;
  externalSessionId: string;
};
type Input = {
  ownerUserId: string;
  groupId: string;
  sessionKey: string;
  bindingHash: string;
  checkpointSequence: string;
  checkpointHash: string;
  sourceSession: SessionInput;
  items: ConversationItemInput[];
};
type Replica = {
  owner_user_id: string;
  binding_hash: string;
  local_session_id: string;
  checkpoint_sequence: string;
  checkpoint_hash: string;
  item_count: number;
};
const digest = (value: unknown) =>
  createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item: unknown) => {
        if (item && typeof item === "object" && !Array.isArray(item))
          return Object.fromEntries(
            Object.entries(item).sort(([a], [b]) =>
              a < b ? -1 : a > b ? 1 : 0
            )
          );
        return item;
      })
    )
    .digest("base64url");

/** Internal primitive, not a sync endpoint. Caller MUST hold the group lock and owner lock in
 * this transaction, replay fresh membership, authenticate origin, binding, envelope and
 * decrypted payload, and persist the corresponding checkpoint receipt in this same transaction.
 * Caller must roll back on any error. No ACK may be sent until commit. This does not
 * implement deletion, delivery, or authenticate this input. */
export async function materializePeerOnlineCheckpoint(
  pool: pg.Pool,
  client: pg.PoolClient,
  input: Input,
  options: Omit<ConversationItemRepositoryOptions, "transactionClient"> = {}
) {
  const quarantine = await client.query(
    "select 1 from peer_online_restore_quarantines where group_id=$1",
    [input.groupId]
  );
  if (quarantine.rowCount)
    throw new Error("peer online group quarantined after restore");
  if (
    input.items.length > 10000 ||
    input.items.some(
      (item) =>
        item.sessionId ||
        item.turnId ||
        item.observationOnly ||
        (item.visibility && item.visibility !== "personal") ||
        item.sourceKind !== input.sourceSession.sourceKind ||
        item.sourceAdapterVersion !== input.sourceSession.sourceAdapterVersion
    )
  )
    throw new Error("invalid peer online source items");
  const floor = (
    await client.query<{
      binding_hash: string;
      deletion_hash: string | null;
      checkpoint_sequence: string;
      checkpoint_hash: string;
      local_floor: boolean;
    }>(
      `select s.binding_hash,s.deletion_hash,s.checkpoint_sequence,s.checkpoint_hash,
       exists(select 1 from peer_online_deletion_outbox o where o.group_id=s.group_id and o.session_key=s.session_key) as local_floor
     from peer_online_sessions s where s.group_id=$1 and s.session_key=$2 for update`,
      [input.groupId, input.sessionKey]
    )
  ).rows[0];
  if (
    !floor ||
    floor.deletion_hash ||
    floor.local_floor ||
    floor.binding_hash !== input.bindingHash ||
    floor.checkpoint_sequence !== input.checkpointSequence ||
    floor.checkpoint_hash !== input.checkpointHash
  )
    throw new Error("peer online checkpoint floor mismatch");
  const receipt = await client.query(
    "select 1 from peer_online_checkpoints where group_id=$1 and session_key=$2 and sequence=$3 and hash=$4",
    [
      input.groupId,
      input.sessionKey,
      input.checkpointSequence,
      input.checkpointHash
    ]
  );
  if (!receipt.rowCount)
    throw new Error("peer online checkpoint receipt missing");
  const replica = (
    await client.query<Replica>(
      "select * from peer_online_replicas where group_id=$1 and session_key=$2 for update",
      [input.groupId, input.sessionKey]
    )
  ).rows[0];
  if (
    replica &&
    (replica.owner_user_id !== input.ownerUserId ||
      replica.binding_hash !== input.bindingHash)
  )
    throw new Error("peer online replica binding mismatch");
  if (
    replica &&
    (BigInt(input.checkpointSequence) !==
      BigInt(replica.checkpoint_sequence) + 1n ||
      input.items.length < replica.item_count)
  )
    throw new Error("peer online checkpoint sequence mismatch");
  if (!replica && input.checkpointSequence !== "0")
    throw new Error("peer online checkpoint predecessor missing");
  const digests = input.items.map(digest);
  const previous = await client.query<{ source_digest: string }>(
    "select source_digest from peer_online_source_items where group_id=$1 and session_key=$2 order by source_ordinal",
    [input.groupId, input.sessionKey]
  );
  if (
    previous.rows.length !== (replica?.item_count ?? 0) ||
    previous.rows.some((row, index) => row.source_digest !== digests[index])
  )
    throw new Error("peer online checkpoint source history changed");
  let sessionId = replica?.local_session_id;
  const sessionDigest = digest(input.sourceSession);
  if (sessionId) {
    const source = await client.query(
      "select 1 from sessions where id=$1 and owner_user_id=$2 and metadata->>'peerOnlineSourceDigest'=$3 and personal_deleted_at is null for update",
      [sessionId, input.ownerUserId, sessionDigest]
    );
    if (!source.rowCount)
      throw new Error("peer online source session changed or deleted");
  } else {
    const session = await createCapturedSessionRepository(pool, {
      transactionClient: client,
      verifiedSourceIdentityOnly: true
    }).createCapturedSession(
      { userId: input.ownerUserId },
      {
        ...input.sourceSession,
        metadata: { peerOnlineSourceDigest: sessionDigest },
        idempotencyKey: `peer-online:${input.groupId}:${input.sessionKey}`,
        sourceHash: input.bindingHash,
        sourceFingerprint: input.sessionKey
      }
    );
    if (
      session.ownerUserId !== input.ownerUserId ||
      session.metadata.peerOnlineSourceDigest !== sessionDigest
    )
      throw new Error("peer online source session collision");
    sessionId = session.id;
    await client.query(
      "insert into peer_online_replicas(group_id,session_key,binding_hash,owner_user_id,local_session_id,checkpoint_sequence,checkpoint_hash,item_count) values($1,$2,$3,$4,$5,$6,$7,0)",
      [
        input.groupId,
        input.sessionKey,
        input.bindingHash,
        input.ownerUserId,
        sessionId,
        input.checkpointSequence,
        input.checkpointHash
      ]
    );
  }
  await client.query(
    "select set_config('koed.peer_online_append_session',$1,true)",
    [sessionId]
  );
  const suffix = input.items.slice(previous.rows.length).map((item, index) => ({
    ...item,
    sessionId,
    sourceTransport: "peer_online",
    idempotencyKey: `peer-online-item:${digest([input.groupId, input.sessionKey, previous.rows.length + index])}`
  }));
  const stored = await createConversationItemRepository(pool, {
    ...options,
    transactionClient: client
  }).createConversationItems({ userId: input.ownerUserId }, { items: suffix });
  if (
    stored.length !== suffix.length ||
    stored.some((item) => item.sessionId !== sessionId)
  )
    throw new Error("peer online checkpoint source materialization incomplete");
  for (let i = 0; i < stored.length; i++)
    await client.query(
      "insert into peer_online_source_items(group_id,session_key,source_ordinal,source_digest,conversation_item_id) values($1,$2,$3,$4,$5)",
      [
        input.groupId,
        input.sessionKey,
        previous.rows.length + i,
        digests[previous.rows.length + i],
        stored[i]!.id
      ]
    );
  await client.query(
    "select set_config('koed.peer_online_append_session','',true)"
  );
  await client.query(
    "update peer_online_replicas set checkpoint_sequence=$3,checkpoint_hash=$4,item_count=$5 where group_id=$1 and session_key=$2",
    [
      input.groupId,
      input.sessionKey,
      input.checkpointSequence,
      input.checkpointHash,
      input.items.length
    ]
  );
  return { sessionId };
}
