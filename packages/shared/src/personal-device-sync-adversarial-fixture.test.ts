import { createHash, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PDS_PROTOCOL,
  canonicalizePdsJson,
  certificateIsPdsValid,
  createPdsSessionManifest,
  createPdsSessionPackage,
  createPdsSessionPackageRuntimeContext,
  pdsEd25519PrivateKey,
  pdsFinalizedStatementHash,
  pdsPublicKeyCommitment,
  pdsSha256,
  pdsSessionPackageDigest,
  signPdsGroupDraft,
  signPdsGroupFinal,
  signPdsRecord,
  signPdsTwoStageDraft,
  signPdsTwoStageFinal,
  validatePdsConflictResolution,
  validatePdsGroupStatement,
  validatePdsKeyBundle,
  validatePdsPackageAck,
  validatePdsRelayTransport,
  validatePdsSessionPackageChunk,
  verifyAndDecryptPdsSessionPackage,
  type PdsSessionManifest,
  type PdsSessionPackage
} from "./index.js";
import {
  classifyPdsSessionPackageReplay,
  retainPdsSessionPackage
} from "./personal-device-session-package.js";

type FixtureKey = { publicKey: string; privateSeed: string };
type Device = {
  id: string;
  signingKeyId: string;
  kemKeyId: string;
  signing: FixtureKey;
  kem: FixtureKey;
};
type StoredPackage = {
  manifest: PdsSessionManifest;
  package: PdsSessionPackage;
};
type KeyBundleRecipient = Pick<Device, "id" | "kemKeyId" | "kem">;
type MutableVersionPackage = Omit<PdsSessionPackage, "header"> & {
  header: Omit<PdsSessionPackage["header"], "version"> & { version: string };
};

const NOW = new Date("2026-07-15T00:00:00.000Z");
const EXPIRES = "2026-07-20T00:00:00.000Z";
const issuedAt = "2026-07-14T00:00:00.000Z";
const opaqueId = (value: string): string =>
  createHash("sha256")
    .update(value)
    .digest()
    .subarray(0, 16)
    .toString("base64url");
const hash = (value: string): string =>
  createHash("sha256").update(value).digest("base64url");
const bytes = (value: number): string =>
  Buffer.alloc(32, value).toString("base64url");

// Published non-production fixture material. Never accepted by deployment config.
const keys = {
  authority: {
    publicKey: "OYxsvNdshY9FXWXeuccL7VKae17-sIUD0YEHV21mHE0",
    privateSeed: "SrOLMXs6afGTmZuj_9Wsc85MzHw7rXNXjtsJRgFMykc"
  },
  recoverySign: {
    publicKey: "VNT_RtBoINWfc0d50xWx_hc5H0s1QSAdn-lwUJ-i4h0",
    privateSeed: "9tun_Emu1-cRw1eb-VlqKGWc2iXf2Gh1C7a50eXB9AM"
  },
  recoveryKem: {
    publicKey: "PP2Ll7u-s53x2FM0NJlMK0sAKMxdGywR0VlN7AFhxSw",
    privateSeed: "-GVKdj_7VoXDp2ZfpNQgyzRlKOwQN-86Wdr5Sd1dSVs"
  },
  alphaSign: {
    publicKey: "MrcpefBgGn3FtCPScv8BsFtb23ljzs3RMaTn7oKxf_M",
    privateSeed: "gdAeuPF8lCBXSWDi4-e0ELjgRYaCYPZTFPWQy5pki0o"
  },
  alphaKem: {
    publicKey: "leQiwxQsGl6NtHw8SW929S6ZSktAm1sS-k1ImVLOino",
    privateSeed: "MIpcEw0iLvQqyOIU8W_cUv-XEA-4dX9DKxwC-WgL7V0"
  },
  betaSign: {
    publicKey: "MO6-b71SmsylZux99fr-6YeBik6ujdauQmSYUCRZehA",
    privateSeed: "1giJVvUJDTZSaiuruSlD0Aws_76FDzwMPChr0NWPI9I"
  },
  betaKem: {
    publicKey: "JUfDEJzBt1yovir-owInX79lr-7vr7oQ1Yxp0O0IAAU",
    privateSeed: "sCCk7uv43m56UFQ6oOF9mtkiuyumvMlWqotJZ8FXW2E"
  },
  gammaSign: {
    publicKey: "ePrU2pfL9KxUHAEyQjIQjoUzvDJ4HT96jhyPLfM6Ug4",
    privateSeed: "iMCtTgDODcPpqmu1QM9du7VsNBL2Ps10jk0qpX5xRB0"
  },
  gammaKem: {
    publicKey: "3KM0ZjyX5iWBbe6d5CqUhaig_PDS_8LwSVLszzJuRD4",
    privateSeed: "MCpyocF4VQ3n1YGy5B9znnBnTC5Nq1YVAs6u_qAXyXE"
  },
  replacementSign: {
    publicKey: "DX-5Ni7hhklQF1flzkBgGLJn-v9y0M4Tafpsah7pwgk",
    privateSeed: "C8vvjvh9uVv5CQA6EAG0jslewqF1qiqlCCoOmwQN6po"
  },
  replacementKem: {
    publicKey: "60B4EXBIwT6lpQ4fClJWONWaIVb2gkXBMYHhUl1Ac24",
    privateSeed: "UIOlWRv95Lc1td4PeafcN3Qfxsk0CXeNtz8Qgl6IeFw"
  }
} satisfies Record<string, FixtureKey>;

const kemOrder: Record<string, number> = {
  alpha: 2,
  beta: 1,
  gamma: 4,
  replacement: 3
};

const device = (
  name: string,
  signing: FixtureKey,
  kem: FixtureKey
): Device => ({
  id: opaqueId(`device:${name}`),
  signingKeyId: opaqueId(`signing:${name}`),
  kemKeyId: Buffer.alloc(16, kemOrder[name]).toString("base64url"),
  signing,
  kem
});

const alpha = device("alpha", keys.alphaSign, keys.alphaKem);
const beta = device("beta", keys.betaSign, keys.betaKem);
const gamma = device("gamma", keys.gammaSign, keys.gammaKem);
const replacement = device(
  "replacement",
  keys.replacementSign,
  keys.replacementKem
);
const signingKey = (key: FixtureKey): KeyObject =>
  pdsEd25519PrivateKey(key.privateSeed, key.publicKey);

class Authority {
  groupId = opaqueId("adversarial-group");
  readonly authorityKeyId = opaqueId("adversarial-authority");
  readonly recoveryId = opaqueId("adversarial-recovery");
  readonly authority = keys.authority;
  readonly members = new Map<string, Device>();
  readonly bundles = new Map<string, unknown>();
  available = true;
  controlLost = false;
  epoch = "1";
  sequence = "1";
  head = bytes(7);

  constructor(devices: Device[] = [alpha, beta]) {
    devices.forEach((member) => this.members.set(member.id, member));
  }

  active(): Device[] {
    return [...this.members.values()].sort((left, right) =>
      left.id.localeCompare(right.id)
    );
  }

  certificate(member: Device, expiresAt = EXPIRES): string {
    const unsigned = {
      protocol: PDS_PROTOCOL,
      groupId: this.groupId,
      deviceId: member.id,
      deviceSigningKeyId: member.signingKeyId,
      deviceSigningPublicKey: member.signing.publicKey,
      deviceKemKeyId: member.kemKeyId,
      deviceKemPublicKey: member.kem.publicKey,
      epoch: this.epoch,
      operationFamilies: ["pds_relay"],
      statementSequence: this.sequence,
      statementHash: this.head,
      issuedAt,
      expiresAt
    };
    return canonicalizePdsJson({
      ...unsigned,
      authoritySignature: {
        keyId: this.authorityKeyId,
        signature: signPdsRecord(
          "membership-certificate",
          unsigned,
          signingKey(this.authority)
        )
      }
    });
  }

  runtime(serving: Device, recipient: Device, historical: string[] = []) {
    const recipients = this.active().map((member) => this.certificate(member));
    return createPdsSessionPackageRuntimeContext({
      authorityPublicKey: this.authority.publicKey,
      groupId: this.groupId,
      authorityHead: this.head,
      currentEpoch: this.epoch,
      servingCertificate: this.certificate(serving),
      recipientCertificate: this.certificate(recipient),
      recipientCertificates: recipients,
      historicalOriginCertificates: historical,
      now: NOW
    });
  }

  keyBundle(
    author: Device,
    nextMembers: Device[],
    kind: "add-device" | "revoke-device" | "recover",
    epoch: string
  ): string {
    const recipients: KeyBundleRecipient[] = [
      ...nextMembers,
      { id: this.recoveryId, kemKeyId: this.recoveryId, kem: keys.recoveryKem }
    ].sort((left, right) => left.id.localeCompare(right.id));
    const snapshot = recipients.map((recipient) => recipient.id);
    const draft = {
      protocol: PDS_PROTOCOL,
      version: "1",
      groupId: this.groupId,
      epoch,
      transitionKind: kind,
      recipientSnapshot: snapshot,
      recipientSnapshotHash: pdsSha256(canonicalizePdsJson(snapshot)),
      keyType: "group-secret-set",
      epochKeyCommitment: bytes(21),
      sourceFingerprintKeyCommitment: bytes(22),
      tombstoneFloorKeyCommitment: bytes(23),
      projectAliasKeyCommitment: bytes(24),
      envelopes: recipients.map((recipient, index) => ({
        recipientId: recipient.id,
        recipientKind: recipient.id === this.recoveryId ? "recovery" : "device",
        recipientKemKeyId: recipient.kemKeyId,
        recipientKemPublicKeyCommitment: pdsPublicKeyCommitment(
          recipient.kem.publicKey
        ),
        ephemeralPublicKey: bytes(30 + index),
        nonce: Buffer.alloc(12, 40 + index).toString("base64url"),
        ciphertext: bytes(50 + index),
        tag: Buffer.alloc(16, 60 + index).toString("base64url"),
        envelopeContext: "koed/pds/v1/key-bundle-envelope"
      }))
    };
    const authorization = {
      signerKeyId: author.signingKeyId,
      signature: signPdsTwoStageDraft(
        "key-bundle",
        draft,
        signingKey(author.signing)
      )
    };
    const bundle = {
      draft,
      authorization,
      authority: {
        keyId: this.authorityKeyId,
        signature: signPdsTwoStageFinal(
          "key-bundle",
          { draft, authorization },
          signingKey(this.authority)
        )
      }
    };
    const validated = validatePdsKeyBundle(bundle, {
      authorizationPublicKey: author.signing.publicKey,
      authorityPublicKey: this.authority.publicKey,
      expectedAuthorizationKeyId: author.signingKeyId,
      expectedAuthorityKeyId: this.authorityKeyId
    });
    this.bundles.set(validated.hash, bundle);
    return validated.hash;
  }

  transition(
    author: Device,
    kind: "add-device" | "revoke-device" | "recover",
    target: Device,
    expectedHead = this.head
  ): string {
    if (!this.available || this.controlLost)
      throw new Error("authority-unavailable");
    if (expectedHead !== this.head) throw new Error("authority-cas-conflict");
    const nextMembers = this.active().filter(
      (member) => member.id !== target.id
    );
    if (kind !== "revoke-device") nextMembers.push(target);
    const nextEpoch = (BigInt(this.epoch) + 1n).toString();
    const keyBundleHash = this.keyBundle(author, nextMembers, kind, nextEpoch);
    const body =
      kind === "revoke-device"
        ? {
            deviceId: target.id,
            reasonCode: "fixture-revoke",
            revokedAt: NOW.toISOString(),
            previousEpoch: this.epoch,
            nextEpoch,
            keyBundleHash
          }
        : kind === "add-device"
          ? {
              deviceId: target.id,
              deviceSigningKeyId: target.signingKeyId,
              deviceSigningPublicKey: target.signing.publicKey,
              deviceKemKeyId: target.kemKeyId,
              deviceKemPublicKey: target.kem.publicKey,
              operationFamilies: ["pds_relay"],
              previousEpoch: this.epoch,
              nextEpoch,
              keyBundleHash
            }
          : {
              deviceId: target.id,
              revokedDeviceIds: this.active()
                .map((member) => member.id)
                .sort(),
              deviceSigningKeyId: target.signingKeyId,
              deviceSigningPublicKey: target.signing.publicKey,
              deviceKemKeyId: target.kemKeyId,
              deviceKemPublicKey: target.kem.publicKey,
              recoveryKitHash: bytes(70),
              previousEpoch: this.epoch,
              nextEpoch,
              keyBundleHash
            };
    const draft = {
      protocol: PDS_PROTOCOL,
      kind,
      groupId: this.groupId,
      sequence: (BigInt(this.sequence) + 1n).toString(),
      previousHash: this.head,
      body
    };
    const authorization = {
      signerKeyId: author.signingKeyId,
      signature: signPdsGroupDraft(draft, signingKey(author.signing))
    };
    const statement = {
      draft,
      authorization,
      authority: {
        keyId: this.authorityKeyId,
        signature: signPdsGroupFinal(
          { draft, authorization },
          signingKey(this.authority)
        )
      }
    };
    validatePdsGroupStatement(statement, {
      authorizationPublicKey: author.signing.publicKey,
      authorityPublicKey: this.authority.publicKey,
      expectedGroupId: this.groupId,
      expectedPreviousHash: this.head,
      expectedSequence: draft.sequence
    });
    this.members.clear();
    nextMembers.forEach((member) => this.members.set(member.id, member));
    this.epoch = nextEpoch;
    this.sequence = draft.sequence;
    this.head = pdsFinalizedStatementHash(statement);
    return this.head;
  }
}

class Relay {
  readonly transports = new Map<
    string,
    {
      package: PdsSessionPackage;
      chunks: Map<string, PdsSessionPackage["chunks"][number]>;
      acks: Set<string>;
    }
  >();
  readonly records: Array<Record<string, unknown>> = [];
  available = true;

  acceptHeader(
    authority: Authority,
    pkg: PdsSessionPackage
  ): "accepted" | "replay-rejected" {
    if (!this.available || !authority.available)
      throw new Error("relay-unavailable");
    const known = this.transports.get(pkg.header.packageId);
    if (
      known &&
      known.package.header.sourceManifestHash !== pkg.header.sourceManifestHash
    )
      return "replay-rejected";
    const sender = authority.members.get(pkg.header.servingDeviceId);
    if (!sender) throw new Error("sender-revoked");
    validatePdsRelayTransport(
      { header: pkg.header, envelopes: pkg.envelopes },
      {
        groupId: authority.groupId,
        authorityHead: authority.head,
        epoch: authority.epoch,
        senderDeviceId: sender.id,
        senderSigningKeyId: sender.signingKeyId,
        senderSigningPublicKey: sender.signing.publicKey,
        recipientDeviceIds: authority.active().map((member) => member.id),
        now: NOW
      }
    );
    this.transports.set(pkg.header.packageId, {
      package: pkg,
      chunks: new Map(),
      acks: new Set()
    });
    this.records.push({
      event: "accepted",
      groupId: pkg.header.groupId,
      packageId: pkg.header.packageId,
      chunks: pkg.header.chunkCount
    });
    return "accepted";
  }

  uploadChunk(
    packageId: string,
    chunk: PdsSessionPackage["chunks"][number]
  ): "stored" | "idempotent" | "replay-rejected" {
    const transport = this.transports.get(packageId);
    if (!transport) throw new Error("transport-missing");
    validatePdsSessionPackageChunk(chunk, transport.package.header);
    const existing = transport.chunks.get(chunk.chunkIndex);
    if (existing && existing.ciphertext !== chunk.ciphertext)
      return "replay-rejected";
    if (existing) return "idempotent";
    transport.chunks.set(chunk.chunkIndex, chunk);
    this.records.push({
      event: "chunk",
      packageId,
      chunkIndex: chunk.chunkIndex,
      chunkHash: chunk.chunkHash
    });
    return "stored";
  }

  ready(packageId: string): PdsSessionPackage {
    const transport = this.transports.get(packageId);
    if (!transport || transport.chunks.size !== transport.package.chunks.length)
      throw new Error("relay-incomplete");
    const chunks = [...transport.chunks.values()].sort(
      (left, right) => Number(left.chunkIndex) - Number(right.chunkIndex)
    );
    const pkg = {
      header: transport.package.header,
      envelopes: transport.package.envelopes,
      chunks
    };
    return { ...pkg, packageDigest: pdsSessionPackageDigest(pkg) };
  }

  ack(authority: Authority, pkg: PdsSessionPackage, device: Device): void {
    const unsigned = {
      protocol: PDS_PROTOCOL,
      groupId: authority.groupId,
      transportId: pkg.header.transportId,
      packageId: pkg.header.packageId,
      sourceManifestHash: pkg.header.sourceManifestHash,
      recipientDeviceId: device.id,
      intendedRecipientSnapshotHash: pkg.header.intendedRecipientSnapshotHash,
      relayAcceptedAt: NOW.toISOString(),
      ackedAt: "2026-07-15T00:00:01.000Z",
      result: "materialized"
    };
    const acknowledgement = {
      ...unsigned,
      signature: {
        signerKeyId: device.signingKeyId,
        signature: signPdsRecord(
          "package-ack",
          unsigned,
          signingKey(device.signing)
        )
      }
    };
    validatePdsPackageAck(acknowledgement, {
      signingPublicKey: device.signing.publicKey,
      expectedSignerKeyId: device.signingKeyId,
      expectedGroupId: authority.groupId,
      expectedDeviceId: device.id
    });
    this.transports.get(pkg.header.packageId)?.acks.add(device.id);
    this.records.push({
      event: "ack",
      packageId: pkg.header.packageId,
      deviceId: device.id
    });
  }
}

class DeviceStore {
  readonly packages = new Map<string, StoredPackage>();
  readonly cursors = new Map<string, string>();
  readonly floors = new Map<string, string>();
  readonly conflicts = new Map<string, Set<string>>();
  readonly logs: Array<Record<string, unknown>> = [];
  state: "ready" | "quarantined" = "ready";

  receive(
    authority: Authority,
    recipient: Device,
    serving: Device,
    pkg: PdsSessionPackage,
    historical: string[] = []
  ): "ready" | "idempotent" | "quarantined" {
    const manifest = verifyAndDecryptPdsSessionPackage(
      canonicalizePdsJson(pkg),
      {
        runtime: authority.runtime(serving, recipient, historical),
        recipientKemPrivateKey: recipient.kem.privateSeed,
        deletionFloors: [...this.floors].map(
          ([logicalMemoryId, deletionFloorToken]) => ({
            logicalMemoryId,
            deletionFloorToken
          })
        ),
        now: NOW
      }
    );
    const known = this.packages.get(manifest.packageId);
    const replay = classifyPdsSessionPackageReplay(
      known
        ? {
            packageId: known.manifest.packageId,
            sourceManifestHash: known.package.header.sourceManifestHash
          }
        : undefined,
      {
        packageId: manifest.packageId,
        sourceManifestHash: pkg.header.sourceManifestHash
      }
    );
    if (replay === "idempotent") return "idempotent";
    if (replay === "quarantine")
      return this.quarantine(
        manifest.sourceFingerprint,
        manifest.sourceClosureHash
      );
    const closure =
      this.conflicts.get(manifest.sourceFingerprint) ?? new Set<string>();
    const existing = [...this.packages.values()].find(
      (item) => item.manifest.sourceFingerprint === manifest.sourceFingerprint
    );
    if (
      existing &&
      existing.manifest.sourceClosureHash !== manifest.sourceClosureHash
    ) {
      closure.add(existing.manifest.sourceClosureHash);
      closure.add(manifest.sourceClosureHash);
      this.conflicts.set(manifest.sourceFingerprint, closure);
      return this.quarantine(
        manifest.sourceFingerprint,
        manifest.sourceClosureHash
      );
    }
    this.packages.set(manifest.packageId, { manifest, package: pkg });
    this.cursors.set(manifest.originDeviceId, manifest.sourceSequence);
    this.logs.push({
      event: "materialized",
      packageId: manifest.packageId,
      manifestHash: pkg.header.sourceManifestHash
    });
    return "ready";
  }

  quarantine(fingerprint: string, closureHash: string): "quarantined" {
    this.state = "quarantined";
    this.logs.push({
      event: "quarantined",
      fingerprint: hash(fingerprint),
      closureHash
    });
    return "quarantined";
  }

  applyFloor(manifest: PdsSessionManifest): void {
    this.floors.set(manifest.logicalMemoryId, manifest.deletionFloorToken);
    for (const [packageId, stored] of this.packages) {
      if (stored.manifest.logicalMemoryId === manifest.logicalMemoryId)
        this.packages.delete(packageId);
    }
    this.logs.push({
      event: "floor",
      logicalMemoryId: manifest.logicalMemoryId
    });
  }

  resolve(
    authority: Authority,
    author: Device,
    fingerprint: string,
    selected: string
  ): void {
    const candidates = [...(this.conflicts.get(fingerprint) ?? [])].sort();
    const draft = {
      protocol: PDS_PROTOCOL,
      groupId: authority.groupId,
      sourceFingerprint: fingerprint,
      candidateClosureHashes: candidates,
      selectedClosureHash: selected,
      resolution: "select",
      statementHash: authority.head,
      issuedAt: NOW.toISOString()
    };
    const authorization = {
      signerKeyId: author.signingKeyId,
      signature: signPdsTwoStageDraft(
        "conflict-resolution",
        draft,
        signingKey(author.signing)
      )
    };
    const record = {
      draft,
      authorization,
      authority: {
        keyId: authority.authorityKeyId,
        signature: signPdsTwoStageFinal(
          "conflict-resolution",
          { draft, authorization },
          signingKey(authority.authority)
        )
      }
    };
    validatePdsConflictResolution(record, {
      authorizationPublicKey: author.signing.publicKey,
      authorityPublicKey: authority.authority.publicKey,
      expectedGroupId: authority.groupId
    });
    this.conflicts.delete(fingerprint);
    this.state = "ready";
    this.logs.push({
      event: "resolved",
      resolutionHash: pdsSha256(canonicalizePdsJson(record))
    });
  }
}

const fixture = (devices: Device[] = [alpha, beta]) => ({
  authority: new Authority(devices),
  relay: new Relay(),
  stores: new Map(devices.map((member) => [member.id, new DeviceStore()]))
});
const store = (
  world: ReturnType<typeof fixture>,
  member: Device
): DeviceStore => world.stores.get(member.id)!;

const publish = (
  world: ReturnType<typeof fixture>,
  origin: Device,
  recipient: Device,
  sessionId: string,
  content: string,
  sequence = "1"
): PdsSessionPackage => {
  const runtime = world.authority.runtime(origin, recipient);
  const contents = content.match(/.{1,300000}/gs) ?? [];
  const manifest = createPdsSessionManifest({
    runtime,
    originDeploymentId: opaqueId(`deployment:${origin.id}`),
    sourceSequence: sequence,
    sourceNativeSessionId: sessionId,
    contentEpoch: world.authority.epoch,
    closedSession: {
      closed: true,
      logicalSessionId: `logical:${sessionId}`,
      externalSessionId: sessionId,
      sourceAdapter: "fixture",
      sourceAdapterVersion: "1",
      captureMethod: "transcript",
      sourceCreatedAt: "2026-07-15T00:00:00.000Z",
      sourceClosedAt: "2026-07-15T00:00:01.000Z",
      observedClosedAt: "2026-07-15T00:00:02.000Z"
    },
    terminalCursor: String(contents.length),
    items: contents.map((item, index) => ({
      sourceNativeItemId: `item-${sequence}-${index}`,
      sequence: String(index),
      sourceTimestamp: "2026-07-15T00:00:00.000Z",
      observedAt: "2026-07-15T00:00:01.000Z",
      actor: "user",
      type: "message",
      content: item,
      metadata: { contentType: "text/plain" }
    })),
    sourceFingerprintKey: Buffer.alloc(32, 91),
    tombstoneFloorKey: Buffer.alloc(32, 92),
    originSigningPrivateKey: signingKey(origin.signing)
  });
  return createPdsSessionPackage({
    runtime,
    expiresAt: "2026-07-16T00:00:00.000Z",
    servingSigningPrivateKey: signingKey(origin.signing),
    manifest
  });
};

const transmit = (
  world: ReturnType<typeof fixture>,
  pkg: PdsSessionPackage,
  target: Device,
  origin: Device,
  order = pkg.chunks.map((chunk) => chunk.chunkIndex),
  historical: string[] = []
): PdsSessionPackage => {
  expect(world.relay.acceptHeader(world.authority, pkg)).toBe("accepted");
  for (const index of order)
    expect(
      world.relay.uploadChunk(pkg.header.packageId, pkg.chunks[Number(index)]!)
    ).toBe("stored");
  const received = world.relay.ready(pkg.header.packageId);
  world.relay.ack(world.authority, received, target);
  expect(
    store(world, target).receive(
      world.authority,
      target,
      origin,
      received,
      historical
    )
  ).toBe("ready");
  return received;
};

const allStrings = (value: unknown): string[] => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(allStrings);
  if (value && typeof value === "object")
    return Object.values(value).flatMap(allStrings);
  return [];
};

describe("PDS adversarial deterministic in-memory fixture", () => {
  it("keeps offline captures local, then materializes both directions", () => {
    const world = fixture();
    const alphaPackage = publish(
      world,
      alpha,
      beta,
      "offline-alpha",
      "alpha local capture"
    );
    const betaPackage = publish(
      world,
      beta,
      alpha,
      "offline-beta",
      "beta local capture"
    );
    store(world, alpha).packages.set(alphaPackage.header.packageId, {
      manifest: verifyAndDecryptPdsSessionPackage(
        canonicalizePdsJson(alphaPackage),
        {
          runtime: world.authority.runtime(alpha, alpha),
          recipientKemPrivateKey: alpha.kem.privateSeed,
          now: NOW
        }
      ),
      package: alphaPackage
    });
    store(world, beta).packages.set(betaPackage.header.packageId, {
      manifest: verifyAndDecryptPdsSessionPackage(
        canonicalizePdsJson(betaPackage),
        {
          runtime: world.authority.runtime(beta, beta),
          recipientKemPrivateKey: beta.kem.privateSeed,
          now: NOW
        }
      ),
      package: betaPackage
    });
    transmit(world, alphaPackage, beta, alpha);
    transmit(world, betaPackage, alpha, beta);
    expect(store(world, alpha).packages.size).toBe(2);
    expect(store(world, beta).packages.size).toBe(2);
  });

  it("converges equal fingerprint and closure in both delivery orders", () => {
    const run = (first: Device, second: Device) => {
      const world = fixture([alpha, beta, gamma]);
      const firstPackage = publish(
        world,
        first,
        gamma,
        "same-native-session",
        "same immutable closure"
      );
      const secondPackage = publish(
        world,
        second,
        gamma,
        "same-native-session",
        "same immutable closure"
      );
      transmit(world, firstPackage, gamma, first);
      transmit(world, secondPackage, gamma, second);
      return [...store(world, gamma).packages.values()].map(
        (item) => item.manifest.sourceClosureHash
      );
    };
    expect(run(alpha, beta)).toHaveLength(2);
    expect(new Set(run(beta, alpha))).toHaveLength(1);
  });

  it("quarantines conflicting closure until exact signed resolution", () => {
    const world = fixture([alpha, beta, gamma]);
    const left = publish(
      world,
      alpha,
      gamma,
      "conflict-session",
      "left closure"
    );
    const right = publish(
      world,
      beta,
      gamma,
      "conflict-session",
      "right closure"
    );
    transmit(world, left, gamma, alpha);
    expect(world.relay.acceptHeader(world.authority, right)).toBe("accepted");
    right.chunks.forEach((chunk) =>
      world.relay.uploadChunk(right.header.packageId, chunk)
    );
    expect(
      store(world, gamma).receive(
        world.authority,
        gamma,
        beta,
        world.relay.ready(right.header.packageId)
      )
    ).toBe("quarantined");
    const conflict = [...store(world, gamma).conflicts.entries()][0]!;
    store(world, gamma).resolve(
      world.authority,
      alpha,
      conflict[0],
      left.header.sourceManifestHash === right.header.sourceManifestHash
        ? ""
        : [...conflict[1]][0]!
    );
    expect(store(world, gamma).state).toBe("ready");
    expect(store(world, gamma).conflicts.size).toBe(0);
  });

  it("resumes reordered chunks, accepts exact duplicate, rejects changed replay", () => {
    const world = fixture();
    const pkg = publish(
      world,
      alpha,
      beta,
      "chunk-session",
      "x".repeat(600_000)
    );
    expect(pkg.chunks.length).toBeGreaterThan(1);
    expect(world.relay.acceptHeader(world.authority, pkg)).toBe("accepted");
    expect(world.relay.uploadChunk(pkg.header.packageId, pkg.chunks[1]!)).toBe(
      "stored"
    );
    expect(world.relay.uploadChunk(pkg.header.packageId, pkg.chunks[1]!)).toBe(
      "idempotent"
    );
    expect(() => world.relay.ready(pkg.header.packageId)).toThrow(
      "relay-incomplete"
    );
    expect(world.relay.uploadChunk(pkg.header.packageId, pkg.chunks[0]!)).toBe(
      "stored"
    );
    const received = world.relay.ready(pkg.header.packageId);
    expect(
      store(world, beta).receive(world.authority, beta, alpha, received)
    ).toBe("ready");
    expect(() =>
      verifyAndDecryptPdsSessionPackage(canonicalizePdsJson(received), {
        runtime: world.authority.runtime(alpha, beta),
        recipientKemPrivateKey: beta.kem.privateSeed,
        now: new Date("2026-07-16T00:00:00.000Z")
      })
    ).toThrow("expired");
    expect(
      classifyPdsSessionPackageReplay(
        {
          packageId: pkg.header.packageId,
          sourceManifestHash: pkg.header.sourceManifestHash
        },
        { packageId: pkg.header.packageId, sourceManifestHash: bytes(99) }
      )
    ).toBe("quarantine");
  });

  it("keeps ready recall state through relay and Authority outage", () => {
    const world = fixture();
    const pkg = publish(world, alpha, beta, "outage-session", "already ready");
    transmit(world, pkg, beta, alpha);
    world.relay.available = false;
    world.authority.available = false;
    expect(() => world.relay.acceptHeader(world.authority, pkg)).toThrow(
      "relay-unavailable"
    );
    expect(() =>
      world.authority.transition(alpha, "add-device", gamma)
    ).toThrow("authority-unavailable");
    expect(store(world, beta).state).toBe("ready");
    expect(store(world, beta).packages.size).toBe(1);
  });

  it("denies expired certificates, old epoch, and revoked member exchange", () => {
    const world = fixture();
    expect(
      certificateIsPdsValid(
        JSON.parse(
          world.authority.certificate(alpha, "2026-07-15T00:00:00.000Z")
        ),
        world.authority.authority.publicKey,
        NOW
      )
    ).toBe(false);
    const oldCertificate = world.authority.certificate(beta);
    const oldHead = world.authority.head;
    world.authority.transition(alpha, "revoke-device", beta);
    expect(world.authority.epoch).toBe("2");
    expect(world.authority.members.has(beta.id)).toBe(false);
    expect(() =>
      createPdsSessionPackageRuntimeContext({
        authorityPublicKey: world.authority.authority.publicKey,
        groupId: world.authority.groupId,
        authorityHead: world.authority.head,
        currentEpoch: world.authority.epoch,
        servingCertificate: oldCertificate,
        recipientCertificate: oldCertificate,
        recipientCertificates: [oldCertificate],
        now: NOW
      })
    ).toThrow("does not bind authority state");
    expect(oldHead).not.toBe(world.authority.head);
    expect(
      [...world.authority.bundles.values()].every(
        (bundle) =>
          canonicalizePdsJson(bundle).includes(beta.id) === false ||
          canonicalizePdsJson(bundle).includes(
            '"transitionKind":"revoke-device"'
          ) === false
      )
    ).toBe(true);
  });

  it("re-serves retained package after delayed join and origin loss", () => {
    const world = fixture();
    const pkg = publish(
      world,
      alpha,
      beta,
      "retained-session",
      "retained source"
    );
    const received = transmit(world, pkg, beta, alpha);
    const retained = retainPdsSessionPackage({
      originManifest: store(world, beta).packages.get(
        received.header.packageId
      )!.manifest,
      package: received
    });
    const originCertificate = world.authority.certificate(alpha);
    world.authority.transition(alpha, "add-device", gamma);
    world.stores.set(gamma.id, new DeviceStore());
    const rewrapped = createPdsSessionPackage({
      runtime: world.authority.runtime(beta, gamma, [originCertificate]),
      expiresAt: "2026-07-16T00:00:00.000Z",
      servingSigningPrivateKey: signingKey(beta.signing),
      manifest: retained.originManifest
    });
    transmit(world, rewrapped, gamma, beta, undefined, [originCertificate]);
    expect(store(world, gamma).packages.size).toBe(1);
    world.authority.controlLost = true;
    expect(() =>
      world.authority.transition(beta, "recover", replacement)
    ).toThrow("authority-unavailable");
  });

  it("applies deletion floor before or after package and rejects old backup", () => {
    const world = fixture([alpha, beta, gamma]);
    const pkg = publish(world, alpha, beta, "deleted-session", "delete me");
    const manifest = verifyAndDecryptPdsSessionPackage(
      canonicalizePdsJson(pkg),
      {
        runtime: world.authority.runtime(alpha, beta),
        recipientKemPrivateKey: beta.kem.privateSeed,
        now: NOW
      }
    );
    store(world, beta).applyFloor(manifest);
    expect(() =>
      store(world, beta).receive(world.authority, beta, alpha, pkg)
    ).toThrow("deletion floor rejects source package");
    const other = new DeviceStore();
    world.stores.set(gamma.id, other);
    expect(other.receive(world.authority, gamma, alpha, pkg)).toBe("ready");
    other.applyFloor(manifest);
    expect(other.packages.size).toBe(0);
    expect(() => other.receive(world.authority, gamma, alpha, pkg)).toThrow(
      "deletion floor rejects source package"
    );
  });

  it("records clone suspicion and rejects version, tamper, and cross-group input", () => {
    const world = fixture();
    const pkg = publish(world, alpha, beta, "clone-session", "clone content");
    const clone = new DeviceStore();
    clone.quarantine("same-origin-sequence", "other-closure");
    expect(clone.state).toBe("quarantined");
    const downgraded = structuredClone(pkg) as MutableVersionPackage;
    downgraded.header.version = "0";
    expect(() =>
      verifyAndDecryptPdsSessionPackage(canonicalizePdsJson(downgraded), {
        runtime: world.authority.runtime(alpha, beta),
        recipientKemPrivateKey: beta.kem.privateSeed,
        now: NOW
      })
    ).toThrow("version");
    const unknown = structuredClone(pkg) as MutableVersionPackage;
    unknown.header.version = "2";
    expect(() =>
      verifyAndDecryptPdsSessionPackage(canonicalizePdsJson(unknown), {
        runtime: world.authority.runtime(alpha, beta),
        recipientKemPrivateKey: beta.kem.privateSeed,
        now: NOW
      })
    ).toThrow("version");
    const tampered = structuredClone(pkg);
    tampered.chunks[0]!.ciphertext = `${tampered.chunks[0]!.ciphertext[0] === "A" ? "B" : "A"}${tampered.chunks[0]!.ciphertext.slice(1)}`;
    expect(() =>
      verifyAndDecryptPdsSessionPackage(canonicalizePdsJson(tampered), {
        runtime: world.authority.runtime(alpha, beta),
        recipientKemPrivateKey: beta.kem.privateSeed,
        now: NOW
      })
    ).toThrow();
    const otherAuthority = new Authority([alpha, beta]);
    otherAuthority.groupId = opaqueId("other-group");
    expect(() =>
      verifyAndDecryptPdsSessionPackage(canonicalizePdsJson(pkg), {
        runtime: otherAuthority.runtime(alpha, beta),
        recipientKemPrivateKey: beta.kem.privateSeed,
        now: NOW
      })
    ).toThrow("authority binding");
  });

  it("keeps relay, device, and logs free of Team, API Token, paths, vectors, and plaintext", () => {
    const world = fixture();
    const plaintext = "fixture plaintext must remain encrypted";
    const pkg = publish(world, alpha, beta, "leak-session", plaintext);
    transmit(world, pkg, beta, alpha);
    const inspected = [
      world.relay.records,
      ...[...world.stores.values()].map((item) => ({
        cursors: item.cursors,
        floors: item.floors,
        conflicts: item.conflicts,
        logs: item.logs
      }))
    ];
    const joined = allStrings(inspected).join("\n");
    for (const forbidden of [
      "Team",
      "API Token",
      "/private/path",
      "[0.1,0.2]",
      plaintext
    ])
      expect(joined).not.toContain(forbidden);
    expect(
      store(world, beta).logs.some((entry) => entry.event === "materialized")
    ).toBe(true);
  });
});
