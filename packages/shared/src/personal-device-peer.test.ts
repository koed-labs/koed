import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { describe, expect, it } from "vitest";

import { canonicalizePdsJson } from "./personal-device-sync-jcs.js";
import {
  PDS_PROTOCOL,
  pdsEd25519PrivateKey,
  signPdsRecord
} from "./personal-device-sync.js";
import {
  pdsRelayBodyDigest,
  pdsRelayRequestSigningBytes
} from "./personal-device-sync-relay.js";
import {
  PDS_PEER_PROTOCOL,
  createPdsPeerRouteAdvertisement,
  selectCompletePdsPeerRouteSet,
  verifyPdsPeerReceipt
} from "./personal-device-peer.js";

const rawKeyPair = () => {
  const pair = generateKeyPairSync("ed25519");
  return {
    publicKey: pair.publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("base64url"),
    privateSeed: pair.privateKey
      .export({ format: "der", type: "pkcs8" })
      .subarray(-32)
      .toString("base64url")
  };
};

const fixture = () => {
  const key = rawKeyPair();
  const authority = rawKeyPair();
  const deviceId = randomBytes(16).toString("base64url");
  const signingKeyId = randomBytes(16).toString("base64url");
  const groupId = randomBytes(16).toString("base64url");
  const head = randomBytes(32).toString("base64url");
  const authorityKeyId = randomBytes(16).toString("base64url");
  const unsignedCertificate = {
    protocol: PDS_PROTOCOL,
    groupId,
    deviceId,
    deviceSigningKeyId: signingKeyId,
    deviceSigningPublicKey: key.publicKey,
    deviceKemKeyId: randomBytes(16).toString("base64url"),
    deviceKemPublicKey: randomBytes(32).toString("base64url"),
    epoch: "1",
    statementSequence: "1",
    statementHash: head,
    operationFamilies: ["pds_relay"],
    issuedAt: "2026-08-19T00:00:00.000Z",
    expiresAt: "2026-08-26T00:00:00.000Z"
  };
  const certificate = canonicalizePdsJson({
    ...unsignedCertificate,
    authoritySignature: {
      keyId: authorityKeyId,
      signature: signPdsRecord(
        "membership-certificate",
        unsignedCertificate,
        pdsEd25519PrivateKey(authority.privateSeed, authority.publicKey)
      )
    }
  });
  return {
    key,
    authority,
    authorityKeyId,
    deviceId,
    signingKeyId,
    groupId,
    head,
    certificate
  };
};

describe("PDS peer transport", () => {
  it("accepts only a complete, current, uniquely bound peer route set", () => {
    const item = fixture();
    const now = new Date("2026-08-19T00:00:00.000Z");
    const advertisement = createPdsPeerRouteAdvertisement({
      endpointUrl: "http://192.168.1.20:3310/pds",
      now
    });
    const canonicalAdvertisement = canonicalizePdsJson(advertisement);
    const unsigned = {
      deviceId: item.deviceId,
      deviceSigningKeyId: item.signingKeyId,
      timestamp: now.toISOString(),
      nonce: randomBytes(32).toString("base64url"),
      bodyDigest: pdsRelayBodyDigest(Buffer.from(canonicalAdvertisement))
    };
    const proof = canonicalizePdsJson({
      protocol: PDS_PROTOCOL,
      ...unsigned,
      signature: sign(
        null,
        pdsRelayRequestSigningBytes({
          ...unsigned,
          method: "POST",
          target: "/v1/personal-device-sync/relay/peer-routes"
        }),
        pdsEd25519PrivateKey(item.key.privateSeed, item.key.publicKey)
      ).toString("base64url")
    });
    const record = {
      deviceId: item.deviceId,
      canonicalAdvertisement,
      canonicalRequestProof: proof
    };
    expect(
      selectCompletePdsPeerRouteSet({
        records: [record],
        intendedRecipientDeviceIds: [item.deviceId],
        groupId: item.groupId,
        authorityHead: item.head,
        currentEpoch: "1",
        authorityPublicKey: item.authority.publicKey,
        authorityKeyId: item.authorityKeyId,
        activeCertificates: [item.certificate],
        now
      })?.get(item.deviceId)
    ).toBe("http://192.168.1.20:3310/pds");
    expect(
      selectCompletePdsPeerRouteSet({
        records: [record],
        intendedRecipientDeviceIds: [randomBytes(16).toString("base64url")],
        groupId: item.groupId,
        authorityHead: item.head,
        currentEpoch: "1",
        authorityPublicKey: item.authority.publicKey,
        authorityKeyId: item.authorityKeyId,
        activeCertificates: [item.certificate],
        now
      })
    ).toBeNull();
    expect(() =>
      selectCompletePdsPeerRouteSet({
        records: [record, record],
        intendedRecipientDeviceIds: [item.deviceId],
        groupId: item.groupId,
        authorityHead: item.head,
        currentEpoch: "1",
        authorityPublicKey: item.authority.publicKey,
        authorityKeyId: item.authorityKeyId,
        activeCertificates: [item.certificate],
        now
      })
    ).toThrow("ambiguous");
    expect(() =>
      selectCompletePdsPeerRouteSet({
        records: [record],
        intendedRecipientDeviceIds: [item.deviceId],
        groupId: item.groupId,
        authorityHead: item.head,
        currentEpoch: "1",
        authorityPublicKey: item.authority.publicKey,
        authorityKeyId: item.authorityKeyId,
        activeCertificates: [item.certificate],
        now: new Date(now.getTime() + 181_000)
      })
    ).toThrow();
    expect(() =>
      selectCompletePdsPeerRouteSet({
        records: [record],
        intendedRecipientDeviceIds: [item.deviceId],
        groupId: randomBytes(16).toString("base64url"),
        authorityHead: item.head,
        currentEpoch: "1",
        authorityPublicKey: item.authority.publicKey,
        authorityKeyId: item.authorityKeyId,
        activeCertificates: [item.certificate],
        now
      })
    ).toThrow();
    expect(() =>
      selectCompletePdsPeerRouteSet({
        records: [record],
        intendedRecipientDeviceIds: [item.deviceId],
        groupId: item.groupId,
        authorityHead: item.head,
        currentEpoch: "1",
        authorityPublicKey: item.authority.publicKey,
        authorityKeyId: item.authorityKeyId,
        activeCertificates: [],
        now
      })
    ).toThrow();
    expect(() =>
      selectCompletePdsPeerRouteSet({
        records: [
          {
            ...record,
            canonicalAdvertisement: canonicalizePdsJson({
              ...advertisement,
              endpointUrl: "http://192.168.1.21:3310/pds"
            })
          }
        ],
        intendedRecipientDeviceIds: [item.deviceId],
        groupId: item.groupId,
        authorityHead: item.head,
        currentEpoch: "1",
        authorityPublicKey: item.authority.publicKey,
        authorityKeyId: item.authorityKeyId,
        activeCertificates: [item.certificate],
        now
      })
    ).toThrow();
  });

  it("requires a recipient-signed receipt bound to the exact package", () => {
    const item = fixture();
    const unsigned = {
      protocol: PDS_PROTOCOL,
      groupId: item.groupId,
      transportId: randomBytes(32).toString("base64url"),
      packageId: randomBytes(32).toString("base64url"),
      sourceManifestHash: randomBytes(32).toString("base64url"),
      recipientDeviceId: item.deviceId,
      intendedRecipientSnapshotHash: randomBytes(32).toString("base64url"),
      relayAcceptedAt: "2026-08-19T00:00:00.000Z",
      ackedAt: "2026-08-19T00:00:01.000Z",
      result: "materialized" as const
    };
    const ack = canonicalizePdsJson({
      ...unsigned,
      signature: {
        signerKeyId: item.signingKeyId,
        signature: signPdsRecord(
          "package-ack",
          unsigned,
          pdsEd25519PrivateKey(item.key.privateSeed, item.key.publicKey)
        )
      }
    });
    expect(() =>
      verifyPdsPeerReceipt({
        canonicalAck: ack,
        certificate: item.certificate,
        authorityPublicKey: item.authority.publicKey,
        authorityKeyId: item.authorityKeyId,
        authorityHead: item.head,
        currentEpoch: "1",
        groupId: item.groupId,
        transportId: unsigned.transportId,
        packageId: unsigned.packageId,
        sourceManifestHash: unsigned.sourceManifestHash,
        intendedRecipientSnapshotHash: unsigned.intendedRecipientSnapshotHash,
        recipientDeviceId: item.deviceId,
        now: new Date("2026-08-19T00:00:02.000Z")
      })
    ).not.toThrow();
    expect(() =>
      verifyPdsPeerReceipt({
        canonicalAck: ack,
        certificate: item.certificate,
        authorityPublicKey: item.authority.publicKey,
        authorityKeyId: item.authorityKeyId,
        authorityHead: item.head,
        currentEpoch: "1",
        groupId: item.groupId,
        transportId: randomBytes(32).toString("base64url"),
        packageId: unsigned.packageId,
        sourceManifestHash: unsigned.sourceManifestHash,
        intendedRecipientSnapshotHash: unsigned.intendedRecipientSnapshotHash,
        recipientDeviceId: item.deviceId,
        now: new Date("2026-08-19T00:00:02.000Z")
      })
    ).toThrow("identity");
  });

  it("rejects public HTTP peer endpoints", () => {
    expect(() =>
      createPdsPeerRouteAdvertisement({
        endpointUrl: "http://example.com/pds"
      })
    ).toThrow();
    expect(PDS_PEER_PROTOCOL).toBe("koed/pds-peer/v1");
  });
});
