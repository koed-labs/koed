import {
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  randomUUID,
  sign
} from "node:crypto";
import type pg from "pg";
import { pdsFinalizedStatementHash } from "@koed/shared";
import {
  validatePeerLifecycleFixture,
  type createPeerLifecycleFixture
} from "./personal-peer-lifecycle.js";
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
export const personalSourceDeviceFixture = (
  lifecycle?: ReturnType<typeof createPeerLifecycleFixture>
) => {
  if (lifecycle) validatePeerLifecycleFixture(lifecycle);
  const fromKeys = (keys: { privateKey: KeyObject; publicKey: KeyObject }) => ({
    privateKey: keys.privateKey,
    publicKey: keys.publicKey.export({ format: "jwk" }).x!,
    privateSeed: keys.privateKey.export({ format: "jwk" }).d!
  });
  const authority = lifecycle
      ? fromKeys(lifecycle.identities.authority)
      : pair("ed25519"),
    recovery = lifecycle
      ? fromKeys(lifecycle.identities.recovery)
      : pair("ed25519"),
    recoveryKem = lifecycle
      ? fromKeys(lifecycle.identities.recoveryKem)
      : pair("x25519");
  const groupId = lifecycle?.expectedGroupId ?? id(),
    authorityKeyId = lifecycle?.expectedAuthorityKeyId ?? id(),
    authorityHead = lifecycle?.expectedHead ?? hash(),
    epoch = lifecycle ? "2" : "1",
    headSequence = lifecycle ? "3" : "1";
  const devices = ["origin", "receiver"].map((label, index) => {
    const signing = lifecycle
      ? fromKeys(
          index === 0
            ? lifecycle.identities.author
            : lifecycle.identities.receiver
        )
      : pair("ed25519");
    const kem = lifecycle
      ? fromKeys(
          index === 0
            ? lifecycle.identities.deviceKem
            : lifecycle.identities.receiverKem
        )
      : pair("x25519");
    return {
      label,
      deviceId: lifecycle
        ? index === 0
          ? lifecycle.genesis.draft.body.initialDeviceId
          : lifecycle.admission.draft.body.deviceId
        : id(),
      deploymentId: id(),
      signingKeyId: lifecycle
        ? index === 0
          ? lifecycle.genesis.draft.body.initialDeviceSigningKeyId
          : lifecycle.admission.draft.body.deviceSigningKeyId
        : id(),
      signing,
      kemKeyId: lifecycle
        ? index === 0
          ? lifecycle.genesis.draft.body.initialDeviceKemKeyId
          : lifecycle.admission.draft.body.deviceKemKeyId
        : id(),
      kem
    };
  });
  const recoverySigningKeyId =
    lifecycle?.genesis.draft.body.recoverySigningKeyId ?? id();
  const recoveryKemKeyId =
    lifecycle?.genesis.draft.body.recoveryKemKeyId ?? id();
  const recoveryKitHash =
    lifecycle?.genesis.draft.body.recoveryKitHash ?? hash();
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
      statementSequence: headSequence,
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
        recoverySigningKeyId,
        recoverySigningPublicKey: recovery.publicKey,
        recoveryKemKeyId,
        recoveryKemPublicKey: recoveryKem.publicKey,
        recoveryKitHash,
        currentEpoch: epoch,
        pendingEpoch: null,
        pendingStatementSequence: null,
        pendingStatementHash: null,
        pendingBundleHash: null,
        headSequence,
        headHash: authorityHead,
        state: "active",
        stateReason: null,
        members: members.map((device, index) => ({
          deviceId: device.deviceId,
          signingKeyId: device.signingKeyId,
          signingPublicKey: device.signing.publicKey,
          kemKeyId: device.kemKeyId,
          kemPublicKey: device.kem.publicKey,
          operationFamilies: ["pds_relay"],
          status: "active",
          admittedSequence: lifecycle && index === 1 ? "2" : "1",
          revokedSequence: null,
          revokedAt: null
        })),
        policy: {
          enabled: true,
          futureClosedSessionsOnly: true,
          historicalBackfillEnabled: false
        }
      },
      statements: lifecycle
        ? [lifecycle.genesis, lifecycle.admission, lifecycle.statement].map(
            (statement) => ({
              sequence: statement.draft.sequence,
              statementHash: pdsFinalizedStatementHash(statement),
              canonicalStatement: canonicalizePdsJson(statement)
            })
          )
        : [],
      certificates: members.map((device) => ({
        deviceId: device.deviceId,
        epoch,
        statementSequence: headSequence,
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
    sourceFingerprintKey: lifecycle?.secrets.sourceFingerprintKey ?? hash(),
    tombstoneFloorKey: lifecycle?.secrets.tombstoneFloorKey ?? hash(),
    projectAliasKey: lifecycle?.secrets.projectAliasKey ?? hash()
  };
};
export type PersonalSourceDeviceFixture = ReturnType<
  typeof personalSourceDeviceFixture
>;
