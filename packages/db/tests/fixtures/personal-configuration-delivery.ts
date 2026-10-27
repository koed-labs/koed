import type pg from "pg";
import { expect, vi } from "vitest";
import {
  canonicalizePdsJson,
  decryptPdsEncryptedPayloadPackage,
  parseCanonicalPdsJson,
  verifyPersonalConfigurationRecord,
  personalConfigurationRecordHash,
  personalConfigurationPackageId,
  PdsRelayClient,
  type EnvelopeEncryptionProvider,
  type PersonalConfigurationFeature,
  type PdsSessionPackage
} from "@koed/shared";
import type { MemorySourceRepository } from "../../src/index.js";
import { personalSourceSelectionSql } from "../../src/personal-selection-sql.js";
import { createPdsConfigurationRuntime } from "../../../../apps/worker/src/personal-device-sync-configuration.js";
import type { PersonalSourceDeviceFixture } from "./personal-source-device.js";

type Member = PersonalSourceDeviceFixture["origin"];
type Actor = { userId: string };

/** Verify real encrypted delivery; no decoded record bypasses signatures or package identity. */
export const decodePersonalConfigurationPacket = (
  fixture: PersonalSourceDeviceFixture,
  pkg: PdsSessionPackage,
  author = [fixture.origin, fixture.receiver].find(
    (member) => member.deviceId === pkg.header.servingDeviceId
  ),
  recipient = author === fixture.origin ? fixture.receiver : fixture.origin
) => {
  if (!author) throw new Error("Unknown configuration packet author");
  const decrypted = decryptPdsEncryptedPayloadPackage(
    canonicalizePdsJson(pkg),
    {
      runtime: fixture.runtime(author, recipient),
      recipientKemPrivateKey: recipient.kem.privateSeed
    }
  );
  const record = verifyPersonalConfigurationRecord(
    parseCanonicalPdsJson(Buffer.from(decrypted.plaintext).toString("utf8")),
    {
      groupId: fixture.groupId,
      deviceId: author.deviceId,
      signingKeyId: author.signingKeyId,
      publicKey: author.signing.publicKey
    }
  );
  expect(
    personalConfigurationPackageId(
      personalConfigurationRecordHash(record),
      pkg.header.transportId
    )
  ).toBe(pkg.header.packageId);
  return { record, recipient };
};

export const createPersonalConfigurationDeliveryFixture = (
  fixture: PersonalSourceDeviceFixture,
  encryption: EnvelopeEncryptionProvider,
  features: () => PersonalConfigurationFeature[]
) => {
  const packets: PdsSessionPackage[] = [],
    allPackets: PdsSessionPackage[] = [];
  const relay = new PdsRelayClient({
    baseUrl: "http://127.0.0.1:59998",
    identity: {
      certificate: fixture.origin.certificate,
      deviceId: fixture.origin.deviceId,
      signingKeyId: fixture.origin.signingKeyId,
      signingPublicKey: fixture.origin.signing.publicKey,
      signingPrivateSeed: fixture.origin.signing.privateSeed
    }
  });
  const advertise = vi
    .spyOn(relay, "advertiseConfigurationCapabilities")
    .mockResolvedValue(undefined);
  vi.spyOn(relay, "configurationCapabilities").mockImplementation(async () =>
    [fixture.origin, fixture.receiver].map((member) =>
      fixture.capability(member, features())
    )
  );
  vi.spyOn(relay, "upload").mockImplementation(async (pkg) => {
    packets.push(pkg);
    allPackets.push(pkg);
    return { transportId: pkg.header.transportId, deliveryState: "acked" };
  });
  const runtimes = new Map<
    string,
    ReturnType<typeof createPdsConfigurationRuntime>
  >();
  const config = (
    actor: Actor,
    member: Member,
    repo: MemorySourceRepository
  ) => {
    const runtime = createPdsConfigurationRuntime({
      ...actor,
      groupId: fixture.groupId,
      originDeploymentId: member.deploymentId,
      activeCertificates: fixture.certificates,
      repository: repo.personalConfiguration!,
      runtime: fixture.runtime(member),
      signingKey: member.signing.privateKey,
      encryption,
      relay: () => relay
    });
    runtimes.set(member.deviceId, runtime);
    return runtime;
  };
  const decode = (pkg: PdsSessionPackage) =>
    decodePersonalConfigurationPacket(fixture, pkg);
  const deliver = async (pkg: PdsSessionPackage) => {
    const { record, recipient } = decode(pkg);
    const runtime = runtimes.get(recipient.deviceId);
    if (!runtime)
      throw new Error("Configuration recipient runtime is not initialized");
    return runtime.retainVerified(record);
  };
  return {
    packets,
    allPackets,
    advertise,
    config,
    decode,
    deliver,
    scope: (actor: Actor, member: Member) => ({
      ...actor,
      groupId: fixture.groupId,
      authorDeviceId: member.deviceId,
      authorSigningKeyId: member.signingKeyId,
      originatingDeploymentId: member.deploymentId,
      expectedEpoch: fixture.epoch,
      expectedAuthorityHead: fixture.authorityHead
    }),
    flush: async (runtime: ReturnType<typeof config>) => {
      await runtime.reconcile();
      while (packets.length) await deliver(packets.shift()!);
    },
    selected: (pool: pg.Pool, actor: Actor, projectId: string) =>
      pool.query<{ id: string }>(
        `select s.id from sessions s where ${personalSourceSelectionSql("s", "$1", { inspection: true })}`,
        [
          {
            ownerUserId: actor.userId,
            searchDomain: "project",
            namedProjectId: projectId
          }
        ]
      )
  };
};
