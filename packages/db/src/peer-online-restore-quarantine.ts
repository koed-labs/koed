import type pg from "pg";
import type { PeerMembershipAnchor } from "@koed/shared";
import { replay, transaction } from "./peer-online-membership-repository.js";

export async function assertPeerOnlineNotQuarantined(
  client: pg.PoolClient,
  anchor: PeerMembershipAnchor
): Promise<void> {
  const row = await client.query<{ genesis_hash: string }>(
    "select genesis_hash from peer_online_restore_quarantines where group_id=$1",
    [anchor.groupId]
  );
  if (row.rowCount) {
    if (row.rows[0]?.genesis_hash !== anchor.genesisHash)
      throw new Error("peer online quarantine anchor mismatch");
    throw new Error("peer online group quarantined after restore");
  }
}

export async function declarePeerOnlineRestoreQuarantine(
  pool: pg.Pool,
  anchor: PeerMembershipAnchor,
  reason: string
): Promise<void> {
  if (!reason.trim() || Buffer.byteLength(reason) > 2048)
    throw new Error("invalid peer online quarantine reason");
  await transaction(pool, anchor.groupId, async (client) => {
    await replay(client, anchor);
    await client.query(
      "insert into peer_online_restore_quarantines(group_id,genesis_hash,reason) values($1,$2,$3) on conflict(group_id) do nothing",
      [anchor.groupId, anchor.genesisHash, reason]
    );
  });
}
