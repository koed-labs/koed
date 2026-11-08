import type pg from "pg";
import { inspectPeerMembership, type PeerMembershipState } from "@koed/shared";

/**
 * Brings every local deletion's recipient roster in line with the replayed
 * membership state. Caller must hold the group's advisory transaction lock.
 *
 * Active members other than the requesting device become pending recipients:
 * `member_at_request` for `requestSessionKey`, `admitted_later` otherwise. A
 * pending recipient no longer active becomes `revoked_unconfirmed`; one that is
 * active again returns to pending. Acknowledged rows are never changed. A
 * conflicted or incomplete membership view changes nothing.
 */
export async function reconcilePeerOnlineDeletionRecipients(
  client: pg.PoolClient,
  groupId: string,
  state: PeerMembershipState,
  requestSessionKey?: string
): Promise<void> {
  const view = inspectPeerMembership(state);
  if (view.conflict || view.incomplete || view.head === null) return;
  const active = view.members.map((member) => member.deviceId);
  await client.query(
    `insert into peer_online_deletion_recipients
       (group_id,session_key,recipient_device_id,added_reason)
     select o.group_id,o.session_key,m.device_id,
            case when o.session_key = $3 then 'member_at_request' else 'admitted_later' end
     from peer_online_deletion_outbox o
     cross join unnest($2::text[]) as m(device_id)
     where o.group_id=$1 and o.local_device_id is not null and m.device_id <> o.local_device_id
     on conflict (group_id,session_key,recipient_device_id) do nothing`,
    [groupId, active, requestSessionKey ?? null]
  );
  await client.query(
    `update peer_online_deletion_recipients set state='revoked_unconfirmed'
     where group_id=$1 and state='pending' and not (recipient_device_id = any($2::text[]))`,
    [groupId, active]
  );
  await client.query(
    `update peer_online_deletion_recipients set state='pending', next_attempt_at=now()
     where group_id=$1 and state='revoked_unconfirmed' and recipient_device_id = any($2::text[])`,
    [groupId, active]
  );
}
