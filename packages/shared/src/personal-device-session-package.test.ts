import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { signPdsRecord } from "./personal-device-sync.js";
import { canonicalizePdsJson } from "./personal-device-sync-jcs.js";
import {
  createPdsEncryptedPayloadPackage,
  PDS_SESSION_PACKAGE_MAX_CHUNK_BYTES,
  classifyPdsSessionPackageReplay,
  createPdsSessionPackageRuntimeContext,
  createPdsSessionManifest,
  createPdsSessionPackage,
  decryptPdsEncryptedPayloadPackage,
  pdsDeletionFloorToken,
  pdsLogicalMemoryId,
  pdsProjectAliasToken,
  pdsSessionPackageDigest,
  pdsSessionPackageReplayEntry,
  pdsSourceFingerprint,
  retainPdsSessionPackage,
  retryPdsSessionPackage,
  rewrapPdsSessionPackage,
  parsePdsSessionManifestJson,
  parsePdsSessionPackageJson,
  validatePdsSessionManifest,
  validatePdsSessionPackage,
  verifyAndDecryptPdsSessionPackage,
  verifyPdsSessionManifest,
  type PdsSessionPackage,
  type PdsSessionPackageRuntimeContext
} from "./personal-device-session-package.js";

const sessionPackageVector = (
  JSON.parse(
    readFileSync(
      new URL("../test-fixtures/personal-device-sync-v1.json", import.meta.url),
      "utf8"
    )
  ) as {
    sessionPackageV1: {
      canonicalItemUtf8: string;
      payload: string;
      payloadHash: string;
      sourceClosureHash: string;
    };
  }
).sessionPackageV1;

const productionFixture = JSON.parse(
  readFileSync(
    new URL(
      "../test-fixtures/personal-device-session-package-v1.json",
      import.meta.url
    ),
    "utf8"
  )
) as {
  runtime: Parameters<typeof createPdsSessionPackageRuntimeContext>[0] & {
    now: string;
  };
  recipientKemPrivateKey: string;
  originManifest: string;
  package: string;
  expected: {
    packageId: string;
    sourceManifestHash: string;
    packageDigest: string;
    sourceClosureHash: string;
    payloadCiphertextHash: string;
  };
};

type RawKeyPair = {
  privateKey: KeyObject;
  publicKey: string;
  privateSeed: string;
};

const rawPair = (type: "ed25519" | "x25519"): RawKeyPair => {
  const pair =
    type === "ed25519"
      ? generateKeyPairSync("ed25519")
      : generateKeyPairSync("x25519");
  const publicJwk = pair.publicKey.export({ format: "jwk" }) as unknown as {
    x?: unknown;
  };
  const privateJwk = pair.privateKey.export({ format: "jwk" }) as unknown as {
    d?: unknown;
  };
  if (typeof publicJwk.x !== "string" || typeof privateJwk.d !== "string") {
    throw new Error("test key export failed");
  }
  return {
    privateKey: pair.privateKey,
    publicKey: publicJwk.x,
    privateSeed: privateJwk.d
  };
};

const relayId = (label: string): string =>
  createHash("sha256")
    .update(label)
    .digest()
    .subarray(0, 16)
    .toString("base64url");

const fixture = (
  forkedFromExternalThreadId?: string,
  includeSecondRecipient = false
) => {
  const authority = rawPair("ed25519");
  const origin = rawPair("ed25519");
  const serving = origin;
  const recipient = rawPair("x25519");
  const sourceKey = Buffer.from(
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    "hex"
  );
  const tombstoneKey = Buffer.from(
    "f0e0d0c0b0a090807060504030201000112233445566778899aabbccddeeff00",
    "hex"
  );
  const projectKey = Buffer.alloc(32, 3);
  const epoch = "3";
  const groupId = relayId("group-alpha");
  const authorityHead = Buffer.alloc(32, 7).toString("base64url");
  const authorityKeyId = relayId("authority-key");
  const certificate = (
    deviceId: string,
    signingKeyId: string,
    signingPublicKey: string,
    kemKeyId: string,
    kemPublicKey: string
  ): string => {
    const unsigned = {
      protocol: "koed/pds/v1",
      groupId,
      deviceId,
      deviceSigningKeyId: signingKeyId,
      deviceSigningPublicKey: signingPublicKey,
      deviceKemKeyId: kemKeyId,
      deviceKemPublicKey: kemPublicKey,
      epoch,
      operationFamilies: ["pds_relay"],
      statementSequence: "1",
      statementHash: authorityHead,
      issuedAt: "2026-07-14T00:00:00.000Z",
      expiresAt: "2026-07-20T00:00:00.000Z"
    };
    return canonicalizePdsJson({
      ...unsigned,
      authoritySignature: {
        keyId: authorityKeyId,
        signature: signPdsRecord(
          "membership-certificate",
          unsigned,
          authority.privateKey
        )
      }
    });
  };
  const servingCertificate = certificate(
    relayId("device-origin"),
    relayId("origin-signing-key"),
    origin.publicKey,
    relayId("origin-kem-key"),
    rawPair("x25519").publicKey
  );
  const recipientCertificate = certificate(
    relayId("device-recipient"),
    relayId("recipient-signing-key"),
    rawPair("ed25519").publicKey,
    relayId("recipient-kem-key"),
    recipient.publicKey
  );
  const secondRecipient = rawPair("x25519");
  const secondRecipientCertificate = certificate(
    relayId("device-recipient-two"),
    relayId("recipient-two-signing-key"),
    rawPair("ed25519").publicKey,
    relayId("recipient-two-kem-key"),
    secondRecipient.publicKey
  );
  const recipientCertificates = [
    {
      deviceId: relayId("device-recipient"),
      certificate: recipientCertificate
    },
    ...(includeSecondRecipient
      ? [
          {
            deviceId: relayId("device-recipient-two"),
            certificate: secondRecipientCertificate
          }
        ]
      : [])
  ]
    .sort((left, right) =>
      left.deviceId < right.deviceId
        ? -1
        : left.deviceId > right.deviceId
          ? 1
          : 0
    )
    .map(({ certificate: value }) => value);
  const runtime = createPdsSessionPackageRuntimeContext({
    authorityPublicKey: authority.publicKey,
    authorityKeyId,
    groupId,
    authorityHead,
    currentEpoch: epoch,
    servingCertificate,
    recipientCertificate,
    recipientCertificates,
    now: new Date("2026-07-15T00:00:00.000Z")
  });
  const manifest = createPdsSessionManifest({
    runtime,
    originDeploymentId: relayId("deployment-origin"),
    sourceSequence: "7",
    sourceNativeSessionId: "codex-thread-42",
    contentEpoch: epoch,
    closedSession: {
      closed: true,
      logicalSessionId: "logical-session-codex-thread-42",
      externalSessionId: "codex-thread-42",
      ...(forkedFromExternalThreadId ? { forkedFromExternalThreadId } : {}),
      sourceAdapter: "codex",
      sourceAdapterVersion: "1",
      captureMethod: "transcript",
      sourceCreatedAt: "2026-07-15T00:00:00.000Z",
      sourceClosedAt: "2026-07-15T00:00:01.000Z",
      observedClosedAt: "2026-07-15T00:00:02.000Z"
    },
    terminalCursor: "2",
    items: [
      {
        sourceNativeItemId: "item-0",
        sequence: "0",
        sourceTimestamp: "2026-07-15T00:00:00.000Z",
        observedAt: "2026-07-15T00:00:00.000Z",
        actor: "user",
        type: "message",
        content: "h".repeat(300_000),
        metadata: { contentType: "text/plain", sourceRole: "user" }
      },
      {
        sourceNativeItemId: "item-1",
        sequence: "1",
        sourceTimestamp: "2026-07-15T00:00:01.000Z",
        observedAt: "2026-07-15T00:00:01.000Z",
        actor: "assistant",
        type: "message",
        content: "w".repeat(300_000),
        metadata: { contentType: "text/plain", sourceRole: "assistant" }
      }
    ],
    sourceFingerprintKey: sourceKey,
    tombstoneFloorKey: tombstoneKey,
    originSigningPrivateKey: origin.privateKey,
    projectAliasManifest: {
      version: "1",
      epoch,
      tokens: [pdsProjectAliasToken(projectKey, "github.com/example/koed")]
    }
  });
  const input = {
    runtime,
    expiresAt: "2030-07-15T00:00:00.000Z",
    servingSigningPrivateKey: serving.privateKey,
    manifest
  };
  const verify = {
    runtime,
    recipientKemPrivateKey: recipient.privateSeed,
    now: new Date("2026-07-15T00:00:00.000Z")
  };
  return {
    input,
    verify,
    manifest,
    origin,
    serving,
    recipient,
    sourceKey,
    tombstoneKey,
    projectKey
  };
};

const digest = (pkg: PdsSessionPackage): PdsSessionPackage =>
  retryPdsSessionPackage(pkg);

const withDigest = (pkg: PdsSessionPackage): PdsSessionPackage => ({
  ...pkg,
  packageDigest: pdsSessionPackageDigest({
    header: pkg.header,
    envelopes: pkg.envelopes,
    chunks: pkg.chunks
  })
});

describe("PDS origin-signed session package", () => {
  it("uses one authenticated encrypted transport for source and artifact plaintext", () => {
    const { input, verify, manifest } = fixture();
    const plaintext = canonicalizePdsJson({
      artifactClass: "memory_event/v1",
      value: "derived"
    });
    const pkg = createPdsEncryptedPayloadPackage({
      runtime: input.runtime,
      expiresAt: input.expiresAt,
      servingSigningPrivateKey: input.servingSigningPrivateKey,
      packageId: createHash("sha256")
        .update("artifact-package")
        .digest("base64url"),
      manifestHash: createHash("sha256").update(plaintext).digest("base64url"),
      originDeviceId: manifest.originDeviceId,
      contentEpoch: manifest.contentEpoch,
      plaintext
    });

    const decrypted = decryptPdsEncryptedPayloadPackage(
      canonicalizePdsJson(pkg),
      verify
    );
    expect(Buffer.from(decrypted.plaintext).toString("utf8")).toBe(plaintext);
  });

  it("orders recipients by device ID without imposing an unrelated KEM-key order", () => {
    const { input } = fixture(undefined, true);
    const pkg = createPdsSessionPackage(input);

    expect(pkg.header.intendedRecipientSnapshot).toHaveLength(2);
    expect(pkg.envelopes).toHaveLength(2);
  });

  it("binds native fork lineage into the signed source manifest", () => {
    const forkedFromExternalThreadId = "codex-parent-thread-41";
    const { input, verify, manifest, serving } = fixture(
      forkedFromExternalThreadId
    );
    const pkg = createPdsSessionPackage(input);

    expect(
      verifyAndDecryptPdsSessionPackage(canonicalizePdsJson(pkg), verify)
        .closedSession.forkedFromExternalThreadId
    ).toBe(forkedFromExternalThreadId);

    const altered = structuredClone(manifest);
    altered.closedSession.forkedFromExternalThreadId = "attacker-parent-thread";
    expect(() =>
      verifyPdsSessionManifest(
        altered,
        serving.publicKey,
        relayId("origin-signing-key")
      )
    ).toThrow();
  });

  it("recomputes committed cross-language source closure vector", () => {
    const item = JSON.parse(
      Buffer.from(sessionPackageVector.payload, "base64url").toString("utf8")
    ) as unknown;
    const payload = Buffer.from(canonicalizePdsJson(item), "utf8");
    const record = {
      ordinal: "0",
      sourceNativeItemId: "item-0",
      sourceTimestamp: "2026-07-15T00:00:00.000Z",
      observedAt: "2026-07-15T00:00:00.000Z",
      payload: payload.toString("base64url"),
      payloadHash: createHash("sha256").update(payload).digest("base64url")
    };
    expect(payload.toString("utf8")).toBe(
      sessionPackageVector.canonicalItemUtf8
    );
    expect(record.payload).toBe(sessionPackageVector.payload);
    expect(record.payloadHash).toBe(sessionPackageVector.payloadHash);
    expect(
      createHash("sha256")
        .update(canonicalizePdsJson([record]))
        .digest("base64url")
    ).toBe(sessionPackageVector.sourceClosureHash);
  });

  it("verifies committed production wire fixture and rejects cryptographic drift", () => {
    const runtime = createPdsSessionPackageRuntimeContext({
      ...productionFixture.runtime,
      now: new Date(productionFixture.runtime.now)
    });
    const manifest = parsePdsSessionManifestJson(
      productionFixture.originManifest
    );
    const pkg = parsePdsSessionPackageJson(productionFixture.package);
    expect(manifest.packageId).toBe(productionFixture.expected.packageId);
    expect(manifest.sourceClosureHash).toBe(
      productionFixture.expected.sourceClosureHash
    );
    expect(pkg.packageDigest).toBe(productionFixture.expected.packageDigest);
    expect(pkg.header.sourceManifestHash).toBe(
      productionFixture.expected.sourceManifestHash
    );
    expect(pkg.header.payloadCiphertextHash).toBe(
      productionFixture.expected.payloadCiphertextHash
    );
    expect(
      verifyAndDecryptPdsSessionPackage(productionFixture.package, {
        runtime,
        recipientKemPrivateKey: productionFixture.recipientKemPrivateKey,
        now: new Date(productionFixture.runtime.now)
      })
    ).toEqual(manifest);
    const tampered = JSON.parse(productionFixture.package) as PdsSessionPackage;
    tampered.chunks[0]!.chunkHash = Buffer.alloc(32, 9).toString("base64url");
    expect(() =>
      parsePdsSessionPackageJson(canonicalizePdsJson(tampered))
    ).toThrow();
  });

  it("rejects attacker-controlled authority state, IDs, raw bytes, and recipient excess", () => {
    const forged = structuredClone(productionFixture.runtime);
    forged.authorityHead = Buffer.alloc(32, 8).toString("base64url");
    expect(() =>
      createPdsSessionPackageRuntimeContext({
        ...forged,
        now: new Date(forged.now)
      })
    ).toThrow("certificate");
    const attackerKeyId = structuredClone(productionFixture.runtime);
    const attackerCertificate = JSON.parse(
      Buffer.from(attackerKeyId.servingCertificate).toString("utf8")
    ) as {
      authoritySignature: { keyId: string; signature: string };
      [key: string]: unknown;
    };
    attackerKeyId.servingCertificate = canonicalizePdsJson({
      ...attackerCertificate,
      authoritySignature: {
        ...attackerCertificate.authoritySignature,
        keyId: relayId("attacker-authority")
      }
    });
    expect(() =>
      createPdsSessionPackageRuntimeContext({
        ...attackerKeyId,
        now: new Date(attackerKeyId.now)
      })
    ).toThrow("certificate");
    const pathId = structuredClone(productionFixture.runtime);
    pathId.groupId = "../../authority-state";
    expect(() =>
      createPdsSessionPackageRuntimeContext({
        ...pathId,
        now: new Date(pathId.now)
      })
    ).toThrow("opaque 16-byte ID");
    const excessive = structuredClone(productionFixture.runtime);
    excessive.recipientCertificates = Array.from(
      { length: 65 },
      () => excessive.recipientCertificate
    );
    expect(() =>
      createPdsSessionPackageRuntimeContext({
        ...excessive,
        now: new Date(excessive.now)
      })
    ).toThrow("recipient state");
    expect(() => parsePdsSessionPackageJson(Buffer.from([0xc3, 0x28]))).toThrow(
      "UTF-8"
    );
    expect(() =>
      verifyAndDecryptPdsSessionPackage(` ${productionFixture.package}`, {
        runtime: {} as PdsSessionPackageRuntimeContext,
        recipientKemPrivateKey: productionFixture.recipientKemPrivateKey
      })
    ).toThrow("canonical");
  });

  it("recomputes fixed protocol HMAC vectors", () => {
    const { sourceKey, tombstoneKey, projectKey } = fixture();
    const fingerprint = pdsSourceFingerprint(sourceKey, "codex-thread-42");
    expect(fingerprint).toBe("ddDVvDeEXrlPT81rZXeCF_Z3AMTgZyq5_dp0EucIMss");
    expect(pdsLogicalMemoryId(tombstoneKey, fingerprint)).toBe(
      "6A-UBrkDyCYgd7QLVHFg8GKDw1OwvEMw73b5qU7-1BY"
    );
    expect(pdsDeletionFloorToken(tombstoneKey, fingerprint)).toBe(
      "5vaQmlye8E4OsU61njLXRK94sOm_yC26uueiGQHZu2M"
    );
    expect(pdsProjectAliasToken(projectKey, "github.com/example/koed")).toBe(
      "flV7fh_IMZUsqQig6k74gf2omzO5sZUlc67G_hTU7wo"
    );
  });

  it("creates, verifies, decrypts, retries, and rewraps immutable origin content", () => {
    const { input, verify, manifest } = fixture();
    const pkg = createPdsSessionPackage(input);
    expect(
      verifyAndDecryptPdsSessionPackage(canonicalizePdsJson(pkg), verify)
    ).toEqual(manifest);
    expect(retryPdsSessionPackage(pkg)).toEqual(pkg);
    expect(parsePdsSessionManifestJson(canonicalizePdsJson(manifest))).toEqual(
      manifest
    );
    expect(parsePdsSessionPackageJson(canonicalizePdsJson(pkg))).toEqual(pkg);
    expect(() =>
      parsePdsSessionPackageJson(` ${canonicalizePdsJson(pkg)}`)
    ).toThrow("not RFC 8785 canonical");
    expect(
      retainPdsSessionPackage({
        originManifest: manifest,
        package: pkg,
        localEncryption: { provider: "local-kms", reference: "ciphertext-1" }
      }).originManifest
    ).toEqual(manifest);
    const rewrapped = rewrapPdsSessionPackage(input);
    expect(rewrapped.header.transportId).not.toBe(pkg.header.transportId);
    expect(rewrapped.header.payloadNonce).not.toBe(pkg.header.payloadNonce);
    expect(rewrapped.packageDigest).not.toBe(pkg.packageDigest);
    expect(rewrapped.header.sourceManifestHash).toBe(
      pkg.header.sourceManifestHash
    );
    expect(
      verifyAndDecryptPdsSessionPackage(canonicalizePdsJson(rewrapped), verify)
    ).toEqual(manifest);
  });

  it("fails closed before plaintext for altered bindings, signatures, roles, and floors", () => {
    const { input, verify, serving, manifest } = fixture();
    const pkg = createPdsSessionPackage(input);
    const cases: PdsSessionPackage[] = [];
    const header = structuredClone(pkg);
    header.header.groupId = "group-other";
    cases.push(header);
    const content = structuredClone(pkg);
    content.chunks[0]!.ciphertext =
      Buffer.from("changed").toString("base64url");
    cases.push(content);
    const signature = structuredClone(pkg);
    signature.header.servingSignature.signature = Buffer.alloc(64, 9).toString(
      "base64url"
    );
    cases.push(signature);
    for (const value of cases)
      expect(() =>
        verifyAndDecryptPdsSessionPackage(canonicalizePdsJson(value), verify)
      ).toThrow();
    const aad = structuredClone(pkg);
    aad.header.authorityHead = Buffer.alloc(32, 4).toString("base64url");
    const unsignedHeader = { ...aad.header } as Record<string, unknown>;
    delete unsignedHeader.servingSignature;
    aad.header.servingSignature.signature = signPdsRecord(
      "transport-envelope",
      unsignedHeader,
      serving.privateKey
    );
    const validAadMutation = withDigest(aad);
    expect(() =>
      verifyAndDecryptPdsSessionPackage(
        canonicalizePdsJson(validAadMutation),
        verify
      )
    ).toThrow();
    expect(() =>
      verifyAndDecryptPdsSessionPackage(canonicalizePdsJson(pkg), {
        ...verify,
        runtime: {} as typeof verify.runtime
      })
    ).toThrow("runtime context");
    expect(() =>
      verifyAndDecryptPdsSessionPackage(canonicalizePdsJson(pkg), {
        ...verify,
        deletionFloor: {
          logicalMemoryId: manifest.logicalMemoryId,
          deletionFloorToken: manifest.deletionFloorToken
        }
      })
    ).toThrow();
    const zero = structuredClone(pkg);
    zero.envelopes[0]!.ephemeralPublicKey =
      Buffer.alloc(32).toString("base64url");
    const unsigned = { ...zero.envelopes[0]! } as Record<string, unknown>;
    delete unsigned.servingSignature;
    zero.envelopes[0]!.servingSignature.signature = signPdsRecord(
      "transport-envelope",
      unsigned,
      serving.privateKey
    );
    expect(() =>
      verifyAndDecryptPdsSessionPackage(
        canonicalizePdsJson(withDigest(zero)),
        verify
      )
    ).toThrow();
    const alteredManifest = structuredClone(manifest);
    alteredManifest.originSignature.signature = Buffer.alloc(64, 1).toString(
      "base64url"
    );
    expect(() =>
      verifyPdsSessionManifest(
        alteredManifest,
        serving.publicKey,
        relayId("origin-signing-key")
      )
    ).toThrow();
  });

  it("classifies replay by package ID and signed source manifest hash", () => {
    const { input } = fixture();
    const entry = pdsSessionPackageReplayEntry(createPdsSessionPackage(input));
    expect(classifyPdsSessionPackageReplay(undefined, entry)).toBe("new");
    expect(classifyPdsSessionPackageReplay(entry, entry)).toBe("idempotent");
    expect(
      classifyPdsSessionPackageReplay(entry, {
        ...entry,
        sourceManifestHash: Buffer.alloc(32, 4).toString("base64url")
      })
    ).toBe("quarantine");
    expect(
      classifyPdsSessionPackageReplay(entry, {
        ...entry,
        packageId: Buffer.alloc(32, 5).toString("base64url")
      })
    ).toBe("new");
  });

  it("rejects malformed nonce/tag, replay mutation, chunks, controls, and untrusted fields", () => {
    const { input, manifest } = fixture();
    const pkg = createPdsSessionPackage(input);
    const nonce = structuredClone(pkg);
    nonce.header.payloadNonce = "AA";
    expect(() => validatePdsSessionPackage(nonce)).toThrow();
    const tag = structuredClone(pkg);
    tag.envelopes[0]!.tag = "AA";
    expect(() => validatePdsSessionPackage(tag)).toThrow();
    const version = structuredClone(pkg);
    version.chunks[0]!.version = "2" as "1";
    expect(() => validatePdsSessionPackage(version)).toThrow();
    const changedId = structuredClone(pkg);
    changedId.header.transportId = Buffer.alloc(32, 2).toString("base64url");
    expect(() => digest(changedId)).toThrow();
    const reordered = structuredClone(pkg);
    reordered.chunks = [...reordered.chunks].reverse();
    expect(() => validatePdsSessionPackage(reordered)).toThrow();
    const dropped = structuredClone(pkg);
    dropped.chunks = [];
    expect(() => validatePdsSessionPackage(dropped)).toThrow();
    const duplicate = structuredClone(pkg);
    duplicate.chunks.push(structuredClone(duplicate.chunks[0]!));
    expect(() => validatePdsSessionPackage(duplicate)).toThrow();
    const truncated = structuredClone(pkg);
    truncated.chunks[0]!.ciphertext = truncated.chunks[0]!.ciphertext.slice(
      0,
      -2
    );
    expect(() => validatePdsSessionPackage(truncated)).toThrow();
    const oversized = structuredClone(pkg);
    oversized.chunks[0]!.ciphertext = Buffer.alloc(
      PDS_SESSION_PACKAGE_MAX_CHUNK_BYTES + 1
    ).toString("base64url");
    expect(() => validatePdsSessionPackage(oversized)).toThrow();
    expect(() =>
      validatePdsSessionPackage({ ...pkg, path: "/secret" })
    ).toThrow();
    expect(() =>
      validatePdsSessionManifest({ ...manifest, teamId: "team-no" })
    ).toThrow();
    const mutated = structuredClone(manifest);
    mutated.rawClosure.records[0]!.payload = Buffer.from("{}", "utf8").toString(
      "base64url"
    );
    expect(() => validatePdsSessionManifest(mutated)).toThrow();
    const open = structuredClone(manifest);
    open.closedSession.closed = false as true;
    expect(() => validatePdsSessionManifest(open)).toThrow();
  });

  it("rejects Session paths, credentials, vectors, derived state, and unknown source metadata", () => {
    const { manifest } = fixture();
    const source = structuredClone(manifest);
    const payload = JSON.parse(
      Buffer.from(source.rawClosure.records[0]!.payload, "base64url").toString(
        "utf8"
      )
    ) as { metadata: Record<string, unknown> };
    payload.metadata.path = "/Users/leak";
    const alteredPayload = Buffer.from(canonicalizePdsJson(payload), "utf8");
    source.rawClosure.records[0]!.payload =
      alteredPayload.toString("base64url");
    source.rawClosure.records[0]!.payloadHash = createHash("sha256")
      .update(alteredPayload)
      .digest("base64url");
    expect(() => validatePdsSessionManifest(source)).toThrow(
      "source item metadata is invalid"
    );
    for (const field of [
      "credential",
      "vector",
      "memoryEvents",
      "team",
      "databaseId"
    ]) {
      expect(() =>
        validatePdsSessionManifest({ ...manifest, [field]: "injected" })
      ).toThrow();
    }
  });
});
