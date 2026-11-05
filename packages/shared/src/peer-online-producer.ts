import { createHash, sign, type KeyObject } from "node:crypto";
import {
  signPeerOnlineCheckpoint,
  type PeerOnlineCheckpointInput
} from "./peer-online-checkpoint.js";
import {
  derivePeerSessionKey,
  type PeerSessionIdentity
} from "./peer-online-deletion.js";
import {
  encryptPeerOnlinePayload,
  type PeerOnlinePayloadAuthority,
  type PeerOnlinePayloadRecipient
} from "./peer-online-payload.js";
import {
  encodePeerOnlineSessionSnapshot,
  type PeerOnlineSessionSnapshot
} from "./peer-online-session-snapshot.js";
import { canonicalizePdsJson } from "./personal-device-sync-jcs.js";

const BINDING = "koed/peer-online-session-binding/v1";
const SOURCE_IDENTITY = "koed/peer-online-source-identity/v1";
const CHECKPOINT_RECORD = "koed/peer-online-checkpoint/v1/record\n";

/** Commits a binding to one source Session identity so a receiver can detect a
 * snapshot whose source identity does not belong to the signed binding. */
export function derivePeerOnlineSourceIdentityCommitment(
  source: PeerOnlineSessionSnapshot["sourceSession"]
): string {
  return createHash("sha256")
    .update(
      `${SOURCE_IDENTITY}\n${canonicalizePdsJson({
        sourceKind: source.sourceKind,
        sourceAdapterVersion: source.sourceAdapterVersion,
        externalSessionId: source.externalSessionId
      })}`
    )
    .digest("base64url");
}

/** Signs the immutable origin binding for one origin Session. */
export function signPeerOnlineBinding(
  identity: PeerSessionIdentity,
  source: PeerOnlineSessionSnapshot["sourceSession"],
  signingKey: KeyObject
): { json: string; sessionKey: string; bindingHash: string } {
  const sessionKey = derivePeerSessionKey(identity);
  const unsigned = {
    protocol: BINDING,
    groupId: identity.groupId,
    originDeviceId: identity.originDeviceId,
    originSessionId: identity.originSessionId,
    sessionKey,
    sourceIdentityCommitment: derivePeerOnlineSourceIdentityCommitment(source)
  };
  const json = canonicalizePdsJson({
    unsigned,
    signature: sign(
      null,
      Buffer.from(`${BINDING}\n${canonicalizePdsJson(unsigned)}`),
      signingKey
    ).toString("base64url")
  });
  return {
    json,
    sessionKey,
    bindingHash: createHash("sha256")
      .update(`${BINDING}/record\n${json}`)
      .digest("base64url")
  };
}

/** Hash a later checkpoint names as its predecessor. */
export function hashPeerOnlineCheckpointEnvelope(envelope: string): string {
  return createHash("sha256")
    .update(CHECKPOINT_RECORD)
    .update(envelope)
    .digest("base64url");
}

/**
 * Encrypts a full Session snapshot to every active member and signs the
 * checkpoint as its origin. Authority and recipients must come from current,
 * conflict-free local membership.
 */
export function sealPeerOnlineCheckpoint(input: {
  context: PeerOnlineCheckpointInput;
  snapshot: Omit<PeerOnlineSessionSnapshot, "protocol">;
  authority: PeerOnlinePayloadAuthority;
  recipients: PeerOnlinePayloadRecipient[];
  signingKey: KeyObject;
}): { envelope: string; payload: Buffer; hash: string } {
  const plaintext = encodePeerOnlineSessionSnapshot(input.snapshot);
  try {
    const encrypted = encryptPeerOnlinePayload(
      input.context,
      plaintext,
      input.authority,
      input.recipients
    );
    const signed = signPeerOnlineCheckpoint(
      input.context,
      encrypted,
      input.signingKey
    );
    return {
      ...signed,
      hash: hashPeerOnlineCheckpointEnvelope(signed.envelope)
    };
  } finally {
    plaintext.fill(0);
  }
}
