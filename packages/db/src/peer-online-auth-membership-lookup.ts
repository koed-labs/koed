import type pg from "pg";
import {
  inspectPeerMembership,
  type PeerMembershipAnchor,
  type PeerMembershipMember,
  type PeerOnlineAuthMember,
  type PeerOnlineAuthMembershipSnapshot
} from "@koed/shared";
import { assertPeerOnlineNotQuarantined } from "./peer-online-restore-quarantine.js";
import { replay, transaction } from "./peer-online-membership-repository.js";
import {
  assertPeerOnlinePoolBounded,
  throwIfPeerOnlineAborted
} from "./peer-online-cancellable-transaction.js";

export type PeerOnlineAuthMembershipLookup = (
  groupId: string,
  localDeviceId: string,
  peerDeviceId: string,
  signal: AbortSignal
) => Promise<PeerOnlineAuthMembershipSnapshot | null>;

export type CreatePeerOnlineAuthMembershipLookupOptions = {
  anchor: PeerMembershipAnchor;
  expectedOwnerUserId: string;
};

const unavailableStateErrors = new Set([
  "peer membership group not found",
  "peer membership anchor mismatch",
  "corrupt peer membership evidence",
  "peer membership storage bounds exceeded",
  "peer online quarantine anchor mismatch",
  "peer online group quarantined after restore"
]);

function isUnavailableStateError(error: unknown): boolean {
  return error instanceof Error && unavailableStateErrors.has(error.message);
}

function authMember(member: PeerMembershipMember): PeerOnlineAuthMember {
  return {
    deviceId: member.deviceId,
    signingPublicKey: member.signingPublicKey,
    transportSpkiSha256: member.transportSpkiSha256
  };
}

function assertLookupConfiguration(
  pool: pg.Pool,
  options: CreatePeerOnlineAuthMembershipLookupOptions
): void {
  assertPeerOnlinePoolBounded(pool);
  if (
    !options.anchor.groupId ||
    !options.anchor.genesisHash ||
    !options.expectedOwnerUserId
  )
    throw new Error("Peer Online membership lookup requires trusted anchors");
}

async function readSnapshot(
  pool: pg.Pool,
  anchor: PeerMembershipAnchor,
  expectedOwnerUserId: string,
  localDeviceId: string,
  peerDeviceId: string,
  signal: AbortSignal
): Promise<PeerOnlineAuthMembershipSnapshot | null> {
  return transaction(
    pool,
    anchor.groupId,
    async (client) => {
      throwIfPeerOnlineAborted(signal);
      await assertPeerOnlineNotQuarantined(client, anchor);
      throwIfPeerOnlineAborted(signal);
      const owner = await client.query<{ owner_user_id: string }>(
        "select owner_user_id::text as owner_user_id from peer_online_group_owners where group_id=$1",
        [anchor.groupId]
      );
      throwIfPeerOnlineAborted(signal);
      if (
        owner.rows.length !== 1 ||
        owner.rows[0]!.owner_user_id !== expectedOwnerUserId
      )
        return null;
      const state = await replay(client, anchor, signal);
      const view = inspectPeerMembership(state);
      if (!view.head || view.conflict || view.incomplete) return null;
      const local = view.members.find(
        (member) => member.deviceId === localDeviceId
      );
      const peer = view.members.find(
        (member) => member.deviceId === peerDeviceId
      );
      if (!local || !peer || local.deviceId === peer.deviceId) return null;
      return {
        revision: view.head,
        local: authMember(local),
        peer: authMember(peer)
      };
    },
    signal
  );
}

export function createPeerOnlineAuthMembershipLookup(
  pool: pg.Pool,
  options: CreatePeerOnlineAuthMembershipLookupOptions
): PeerOnlineAuthMembershipLookup {
  assertLookupConfiguration(pool, options);
  const { anchor, expectedOwnerUserId } = options;
  return async (groupId, localDeviceId, peerDeviceId, signal) => {
    throwIfPeerOnlineAborted(signal);
    if (
      groupId !== anchor.groupId ||
      !localDeviceId ||
      !peerDeviceId ||
      localDeviceId === peerDeviceId
    )
      return null;
    try {
      return await readSnapshot(
        pool,
        anchor,
        expectedOwnerUserId,
        localDeviceId,
        peerDeviceId,
        signal
      );
    } catch (error) {
      throwIfPeerOnlineAborted(signal);
      if (isUnavailableStateError(error)) return null;
      throw error;
    }
  };
}
