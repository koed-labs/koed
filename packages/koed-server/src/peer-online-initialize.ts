import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  X509Certificate
} from "node:crypto";
import {
  canonicalizePdsJson,
  PEER_MEMBERSHIP_PROTOCOL,
  type PeerMembershipAnchor,
  type PeerMembershipMember
} from "@koed/shared";
import {
  createPeerOnlineIdentity,
  loadPeerOnlineIdentity,
  type PeerOnlineIdentity
} from "./peer-online-identity.js";
import {
  createPeerOnlineCertificate,
  loadPeerOnlineCertificate,
  type PeerOnlineCertificate
} from "./peer-online-certificate.js";
import { createPeerOnlineCertificateStore } from "./peer-online-certificate-store.js";
import { assertPeerOnlineIdentityBinding } from "./peer-online-identity-binding.js";

/** Independently trusted durable custody, not derived from the membership database. */
export interface PeerOnlineAnchorStore {
  read(): Promise<PeerMembershipAnchor | null>;
  create(anchor: PeerMembershipAnchor): Promise<boolean>;
}
type View = {
  conflict: boolean;
  incomplete: boolean;
  head: string | null;
  members: PeerMembershipMember[];
  records: { hash: string; json: string }[];
};
/** Implement with the peer-online membership repository, including authenticated replay. */
export interface PeerOnlineInitializationMembership {
  initialize(
    anchor: PeerMembershipAnchor,
    json: string
  ): Promise<{ status: string }>;
  load(anchor: PeerMembershipAnchor): Promise<View>;
}
export interface PeerOnlineInitializationOptions {
  root: string;
  anchorStore: PeerOnlineAnchorStore;
  membership: PeerOnlineInitializationMembership;
}
type Result = {
  identity: PeerOnlineIdentity;
  certificate: PeerOnlineCertificate;
  anchor: PeerMembershipAnchor;
  membership: View;
};

function memberFor(
  identity: PeerOnlineIdentity,
  certificate: PeerOnlineCertificate
): PeerMembershipMember {
  const publicIdentity = identity.publicIdentity;
  const signing = createPublicKey({
    key: Buffer.from(publicIdentity.signingPublicKey, "base64"),
    format: "der",
    type: "spki"
  });
  const encryptionSpki = Buffer.from(
    publicIdentity.encryptionPublicKey,
    "base64"
  );
  return {
    deviceId: publicIdentity.deviceId,
    signingPublicKey: signing.export({ format: "jwk" }).x!,
    encryptionSpki: encryptionSpki.toString("base64url"),
    encryptionSpkiSha256: createHash("sha256")
      .update(encryptionSpki)
      .digest("base64url"),
    transportSpkiSha256: certificate.spkiPin
  };
}
function genesis(
  identity: PeerOnlineIdentity,
  certificate: PeerOnlineCertificate
) {
  const unsigned = {
    protocol: PEER_MEMBERSHIP_PROTOCOL,
    groupId: randomUUID(),
    parentHash: null,
    authorDeviceId: identity.publicIdentity.deviceId,
    body: { kind: "genesis", initialMember: memberFor(identity, certificate) }
  };
  const canonical = canonicalizePdsJson(unsigned);
  const key = createPrivateKey({
    key: Buffer.from(identity.getRuntimeKeys().signingPrivateKey, "base64"),
    format: "der",
    type: "pkcs8"
  });
  const signature = sign(
    null,
    Buffer.from(`${PEER_MEMBERSHIP_PROTOCOL}/decision\n${canonical}`),
    key
  ).toString("base64url");
  return {
    anchor: {
      groupId: unsigned.groupId,
      genesisHash: createHash("sha256")
        .update(`${PEER_MEMBERSHIP_PROTOCOL}/record\n${canonical}`)
        .digest("base64url")
    },
    json: canonicalizePdsJson({ unsigned, signature })
  };
}

/** No recovery or reset: ambiguous writes require operator investigation. */
export async function initializePeerOnline(
  options: PeerOnlineInitializationOptions & {
    authorizeFreshInstallation: () => Promise<boolean>;
  }
): Promise<Result> {
  if (
    typeof options.authorizeFreshInstallation !== "function" ||
    (await options.authorizeFreshInstallation()) !== true
  )
    throw new Error("Fresh installation authorization required.");
  const store = createPeerOnlineCertificateStore(options.root);
  if (
    (await options.anchorStore.read()) !== null ||
    (await loadPeerOnlineIdentity(options.root)) !== null ||
    (await store.read()) !== null
  )
    throw new Error("Peer online custody already exists or is incomplete.");
  const identity = await createPeerOnlineIdentity(options.root, () =>
    Promise.resolve(true)
  );
  const certificate = await createPeerOnlineCertificate(store, () =>
    Promise.resolve(true)
  );
  const { anchor, json } = genesis(identity, certificate);
  if (!(await options.anchorStore.create(anchor)))
    throw new Error("Peer online anchor already exists.");
  const result = await options.membership.initialize(anchor, json);
  if (result.status !== "accepted")
    throw new Error("Peer online membership initialization failed.");
  return loadPeerOnline(options);
}

/** Caller supplies independent anchor custody and an authenticated replay repository. */
export async function loadPeerOnline(
  options: PeerOnlineInitializationOptions
): Promise<Result> {
  const anchor = await options.anchorStore.read();
  if (!anchor) throw new Error("Peer online anchor is missing.");
  const identity = await loadPeerOnlineIdentity(options.root);
  if (!identity) throw new Error("Peer online identity is missing.");
  const certificate = await loadPeerOnlineCertificate(
    createPeerOnlineCertificateStore(options.root)
  );
  const membership = await options.membership.load(anchor);
  if (membership.conflict || membership.incomplete || !membership.head)
    throw new Error("Peer online membership is unavailable.");
  const member = membership.members.find(
    (item) => item.deviceId === identity.publicIdentity.deviceId
  );
  if (!member) throw new Error("Peer online identity is not an active member.");
  assertPeerOnlineIdentityBinding(
    identity.publicIdentity,
    member,
    new X509Certificate(certificate.certificate).publicKey.export({
      type: "spki",
      format: "der"
    })
  );
  return { identity, certificate, anchor, membership };
}
