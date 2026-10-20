import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign
} from "node:crypto";
import type pg from "pg";
import {
  canonicalizePdsJson,
  signPdsRecord,
  createPdsSessionPackageRuntimeContext,
  createPdsConfigurationCapabilityAdvertisement,
  PDS_CONFIGURATION_CAPABILITY_PATH,
  pdsRelayBodyDigest,
  pdsRelayRequestSigningBytes,
  PDS_PROTOCOL,
  type PersonalConfigurationFeature,
  type PdsConfigurationCapabilityRecord
} from "@koed/shared";
import {
  createPersonalDeviceSyncRepository,
  createMemorySourceRepository
} from "../../src/index.js";

const id = () => randomBytes(16).toString("base64url");
const hash = () => randomBytes(32).toString("base64url");
const pair = (type: "ed25519" | "x25519") => {
  const keys =
    type === "ed25519"
      ? generateKeyPairSync("ed25519")
      : generateKeyPairSync("x25519");
  return {
    privateKey: keys.privateKey,
    publicKey: keys.publicKey.export({ format: "jwk" }).x!,
    privateSeed: keys.privateKey.export({ format: "jwk" }).d!
  };
};
export const personalSourceDeviceFixture = () => {
  const authority = pair("ed25519"),
    recovery = pair("ed25519"),
    recoveryKem = pair("x25519");
  const groupId = id(),
    authorityKeyId = id(),
    authorityHead = hash(),
    epoch = "1";
  const devices = ["origin", "receiver"].map((label) => ({
    label,
    deviceId: id(),
    deploymentId: id(),
    signingKeyId: id(),
    signing: pair("ed25519"),
    kemKeyId: id(),
    kem: pair("x25519")
  }));
  const issuedAt = new Date(Date.now() - 60_000),
    expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const members = devices.map((device) => {
    const unsigned = {
      protocol: PDS_PROTOCOL,
      groupId,
      deviceId: device.deviceId,
      deviceSigningKeyId: device.signingKeyId,
      deviceSigningPublicKey: device.signing.publicKey,
      deviceKemKeyId: device.kemKeyId,
      deviceKemPublicKey: device.kem.publicKey,
      epoch,
      operationFamilies: ["pds_relay"],
      statementSequence: "1",
      statementHash: authorityHead,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString()
    };
    return {
      ...device,
      certificate: canonicalizePdsJson({
        ...unsigned,
        authoritySignature: {
          keyId: authorityKeyId,
          signature: signPdsRecord(
            "membership-certificate",
            unsigned,
            authority.privateKey
          )
        }
      })
    };
  });
  const certificates = [...members]
    .sort((a, b) => (a.deviceId < b.deviceId ? -1 : 1))
    .map((member) => member.certificate);
  const runtime = (
    serving: (typeof members)[number],
    recipient: (typeof members)[number] = serving
  ) =>
    createPdsSessionPackageRuntimeContext({
      authorityPublicKey: authority.publicKey,
      authorityKeyId,
      groupId,
      authorityHead,
      currentEpoch: epoch,
      servingCertificate: serving.certificate,
      recipientCertificate: recipient.certificate,
      recipientCertificates: certificates
    });
  const capability = (
    member: (typeof members)[number],
    features: PersonalConfigurationFeature[] = ["source_context_v1"]
  ): PdsConfigurationCapabilityRecord => {
    const advertisement =
        createPdsConfigurationCapabilityAdvertisement(features),
      canonicalAdvertisement = canonicalizePdsJson(advertisement);
    const unsigned = {
      protocol: PDS_PROTOCOL,
      deviceId: member.deviceId,
      deviceSigningKeyId: member.signingKeyId,
      timestamp: advertisement.advertisedAt,
      nonce: hash(),
      bodyDigest: pdsRelayBodyDigest(Buffer.from(canonicalAdvertisement))
    };
    const canonicalRequestProof = canonicalizePdsJson({
      ...unsigned,
      signature: sign(
        null,
        pdsRelayRequestSigningBytes({
          ...unsigned,
          method: "POST",
          target: PDS_CONFIGURATION_CAPABILITY_PATH
        }),
        member.signing.privateKey
      ).toString("base64url")
    });
    return {
      deviceId: member.deviceId,
      canonicalAdvertisement,
      canonicalRequestProof
    };
  };
  const initialize = async (
    pool: pg.Pool,
    member: (typeof members)[number],
    existingOwnerUserId?: string
  ) => {
    const user = existingOwnerUserId
      ? { id: existingOwnerUserId }
      : await createMemorySourceRepository(pool).createUser({
          email: `${member.label}-${randomUUID()}@example.test`
        });
    await createPersonalDeviceSyncRepository(
      pool
    ).reconcilePersonalDeviceGroupReplica({
      userId: user.id,
      localDeploymentId: member.deploymentId,
      group: {
        groupId,
        authorityKeyId,
        authorityPublicKey: authority.publicKey,
        recoverySigningKeyId: id(),
        recoverySigningPublicKey: recovery.publicKey,
        recoveryKemKeyId: id(),
        recoveryKemPublicKey: recoveryKem.publicKey,
        recoveryKitHash: hash(),
        currentEpoch: epoch,
        pendingEpoch: null,
        pendingStatementSequence: null,
        pendingStatementHash: null,
        pendingBundleHash: null,
        headSequence: "1",
        headHash: authorityHead,
        state: "active",
        stateReason: null,
        members: members.map((device) => ({
          deviceId: device.deviceId,
          signingKeyId: device.signingKeyId,
          signingPublicKey: device.signing.publicKey,
          kemKeyId: device.kemKeyId,
          kemPublicKey: device.kem.publicKey,
          operationFamilies: ["pds_relay"],
          status: "active",
          admittedSequence: "1",
          revokedSequence: null,
          revokedAt: null
        })),
        policy: {
          enabled: true,
          futureClosedSessionsOnly: true,
          historicalBackfillEnabled: false
        }
      },
      statements: [],
      certificates: members.map((device) => ({
        deviceId: device.deviceId,
        epoch,
        statementSequence: "1",
        statementHash: authorityHead,
        authorityKeyId,
        canonicalCertificate: device.certificate,
        issuedAt,
        expiresAt
      }))
    });
    return { userId: user.id };
  };
  return {
    groupId,
    authorityKeyId,
    authorityPublicKey: authority.publicKey,
    authorityHead,
    epoch,
    origin: members[0]!,
    receiver: members[1]!,
    certificates,
    runtime,
    capability,
    initialize,
    sourceFingerprintKey: hash(),
    tombstoneFloorKey: hash(),
    projectAliasKey: hash()
  };
};
export type PersonalSourceDeviceFixture = ReturnType<
  typeof personalSourceDeviceFixture
>;
