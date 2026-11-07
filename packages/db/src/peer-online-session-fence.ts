import { inspectPeerMembership, type PeerMembershipState } from "@koed/shared";

/** Trusted transport-session identity; never decoded from peer wire payloads. */
export type PeerOnlineSessionContext = {
  peerDeviceId: string;
  membershipRevision: string;
};

export function isPeerOnlineSessionCurrent(
  state: PeerMembershipState,
  localDeviceId: string,
  sessionContext: PeerOnlineSessionContext | undefined
): boolean {
  if (
    typeof localDeviceId !== "string" ||
    localDeviceId.length === 0 ||
    !sessionContext ||
    typeof sessionContext.peerDeviceId !== "string" ||
    sessionContext.peerDeviceId.length === 0 ||
    typeof sessionContext.membershipRevision !== "string" ||
    sessionContext.membershipRevision.length === 0
  )
    return false;

  const view = inspectPeerMembership(state);
  if (
    view.conflict ||
    view.incomplete ||
    !view.head ||
    view.head !== sessionContext.membershipRevision
  )
    return false;

  return (
    view.members.some((member) => member.deviceId === localDeviceId) &&
    view.members.some(
      (member) => member.deviceId === sessionContext.peerDeviceId
    )
  );
}
