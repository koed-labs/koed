import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  verify
} from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonicalizePdsJson,
  parseCanonicalPdsJson,
  parsePdsUint64,
  pdsUint64be
} from "./personal-device-sync-jcs.js";

type SignaturePlan = {
  domain: string;
  wrapper: string;
  removeFields: string[];
  publicKeyHex: string;
};

type SignedRecord = {
  canonicalPayloadUtf8: string;
  recordHash: string;
  plans: SignaturePlan[];
};

type Fixture = {
  protocol: "koed/pds/v1";
  jcsSigning: {
    sourceManifest: {
      domain: string;
      canonicalPayloadUtf8: string;
      packageIdPreimageUtf8: string;
      packageId: string;
      manifestHash: string;
      sourceClosureHash: string;
      ed25519: {
        publicKeyHex: string;
        rfc8032EmptyMessageSignatureHex: string;
      };
    };
  };
  signedRecords: Record<string, SignedRecord>;
  hkdfRfc5869Case1: {
    ikmHex: string;
    saltHex: string;
    infoHex: string;
    length: string;
    okmHex: string;
  };
  aes256GcmNist: {
    keyHex: string;
    nonceHex: string;
    aadHex: string;
    plaintextHex: string;
    ciphertextHex: string;
    tagHex: string;
  };
  x25519: {
    alicePrivateKeyHex: string;
    alicePublicKeyHex: string;
    bobPrivateKeyHex: string;
    bobPublicKeyHex: string;
    sharedSecretHex: string;
    allZeroPublicKeyHex: string;
  };
  compositeRecipientEnvelope: {
    groupId: string;
    recipientEpoch: string;
    packageId: string;
    senderDeviceId: string;
    recipientDeviceId: string;
    saltHex: string;
    infoHex: string;
    wrappingKeyHex: string;
    contentEncryptionKeyHex: string;
    nonceHex: string;
    aadUtf8: string;
    ciphertextHex: string;
    tagHex: string;
    rewrappedRecipientEnvelope: {
      recipientEpoch: string;
      infoHex: string;
      wrappingKeyHex: string;
      nonceHex: string;
      aadUtf8: string;
      ciphertextHex: string;
      tagHex: string;
    };
  };
  sourceFingerprint: {
    keyHex: string;
    tombstoneKeyHex: string;
    projectAliasKeyHex: string;
    sourceType: string;
    sourceNativeSessionId: string;
    digestBase64url: string;
    logicalMemoryId: string;
    deletionFloorToken: string;
  };
  membershipCertificate: {
    issuedAt: string;
    expiresAt: string;
    maxLifetimeSeconds: string;
    clockSkewSeconds: string;
  };
  stateFixtures: {
    replay: {
      first: { packageId: string; manifestHash: string };
      same: { packageId: string; manifestHash: string; expected: string };
      changed: { packageId: string; manifestHash: string; expected: string };
    };
    convergence: {
      sameClosure: {
        fingerprint: string;
        closureHash: string;
        expected: string;
      };
      differentClosure: {
        fingerprint: string;
        closureHash: string;
        existingClosureHash: string;
        expected: string;
      };
    };
    equivocation: {
      trusted: { sequence: string; head: string };
      received: { sequence: string; head: string; expected: string };
    };
    tombstone: {
      floor: { logicalMemoryId: string; deletionFloorToken: string };
      stalePackage: {
        logicalMemoryId: string;
        deletionFloorToken: string;
        expected: string;
      };
      differentPackage: {
        logicalMemoryId: string;
        deletionFloorToken: string;
        expected: string;
      };
    };
    packageAck: {
      intendedRecipientSnapshot: string[];
      acknowledgedRecipient: string;
      revokedAfterUploadRecipient: string;
      expiresAt: string;
      expectedAllAckCleanup: string;
      expectedRevocationWaiver: string;
      expectedExpiry: string;
    };
  };
};

type SourceManifest = {
  packageId: string;
  sourceClosureHash: string;
  sourceFingerprint: string;
  logicalMemoryId: string;
  deletionFloorToken: string;
  sourceNativeSessionId: string;
  sourceType: string;
  terminal: { cursor: string; itemCount: string };
  projectAliasManifest: { version: string; epoch: string; tokens: string[] };
  rawClosure: {
    rawByteCount: string;
    recordCount: string;
    records: Array<{ ordinal: string; payload: string; payloadHash: string }>;
  };
};

const fixture = JSON.parse(
  readFileSync(
    new URL("../test-fixtures/personal-device-sync-v1.json", import.meta.url),
    "utf8"
  )
) as Fixture;

const hex = (value: string): Buffer => Buffer.from(value, "hex");
const base64url = (value: Buffer): string => value.toString("base64url");
const sha256 = (value: string | Buffer): Buffer =>
  createHash("sha256").update(value).digest();

const okpJwk = (
  crv: "Ed25519" | "X25519",
  publicKeyHex: string,
  privateKeyHex?: string
): JsonWebKey => ({
  kty: "OKP",
  crv,
  x: base64url(hex(publicKeyHex)),
  ...(privateKeyHex ? { d: base64url(hex(privateKeyHex)) } : {})
});

const parseSourceManifest = (): SourceManifest =>
  parseCanonicalPdsJson(
    fixture.jcsSigning.sourceManifest.canonicalPayloadUtf8
  ) as SourceManifest;

const withoutFields = (
  value: Record<string, unknown>,
  fields: readonly string[]
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(value).filter(([field]) => !fields.includes(field))
  );

const signatureFor = (
  record: Record<string, unknown>,
  wrapper: string
): Buffer => {
  const value = record[wrapper] as { signature?: unknown };
  if (typeof value?.signature !== "string") {
    throw new TypeError(`Fixture wrapper ${wrapper} lacks signature`);
  }
  return Buffer.from(value.signature, "base64url");
};

const recipientEnvelopeInfo = (
  envelope: Fixture["compositeRecipientEnvelope"]
): Buffer =>
  Buffer.concat([
    Buffer.from("koed/pds/v1/envelope/key\0", "utf8"),
    pdsUint64be(envelope.recipientEpoch),
    Buffer.from(
      `${envelope.packageId}\0${envelope.recipientDeviceId}\0${envelope.senderDeviceId}`,
      "utf8"
    )
  ]);

const recipientEnvelopeAad = (
  envelope: Fixture["compositeRecipientEnvelope"]
): string =>
  canonicalizePdsJson({
    packageId: envelope.packageId,
    recipientDeviceId: envelope.recipientDeviceId,
    recipientEpoch: envelope.recipientEpoch,
    senderDeviceId: envelope.senderDeviceId
  });

const certificateIsAccepted = (
  now: Date,
  issuedAt: Date,
  expiresAt: Date,
  clockSkewSeconds: string,
  maxLifetimeSeconds: string
): boolean => {
  const skew = Number(parsePdsUint64(clockSkewSeconds));
  const maximumLifetime = Number(parsePdsUint64(maxLifetimeSeconds));
  return (
    issuedAt.getTime() <= now.getTime() + skew * 1_000 &&
    now.getTime() < expiresAt.getTime() &&
    expiresAt.getTime() - issuedAt.getTime() <= maximumLifetime * 1_000
  );
};

const classifyReplay = (
  known: { packageId: string; manifestHash: string },
  received: { packageId: string; manifestHash: string }
): "idempotent" | "quarantine" | "new" => {
  if (known.packageId !== received.packageId) return "new";
  return known.manifestHash === received.manifestHash
    ? "idempotent"
    : "quarantine";
};

const classifyClosure = (
  existing: { fingerprint: string; closureHash: string },
  received: { fingerprint: string; closureHash: string }
): "converge" | "quarantine" | "distinct" => {
  if (existing.fingerprint !== received.fingerprint) return "distinct";
  return existing.closureHash === received.closureHash
    ? "converge"
    : "quarantine";
};

const classifyLogHead = (
  trusted: { sequence: string; head: string },
  received: { sequence: string; head: string }
): "continue" | "freeze" =>
  trusted.sequence === received.sequence && trusted.head !== received.head
    ? "freeze"
    : "continue";

const applyDeletionFloor = (
  floor: { logicalMemoryId: string; deletionFloorToken: string },
  received: { logicalMemoryId: string; deletionFloorToken: string }
): "allow" | "reject" =>
  floor.logicalMemoryId === received.logicalMemoryId &&
  floor.deletionFloorToken === received.deletionFloorToken
    ? "reject"
    : "allow";

const requireNonZeroSharedSecret = (sharedSecret: Buffer): Buffer => {
  if (sharedSecret.length !== 32 || sharedSecret.equals(Buffer.alloc(32))) {
    throw new Error("PDS X25519 shared secret must be 32 non-zero bytes");
  }
  return sharedSecret;
};

const cleanupDisposition = (
  recipients: string[],
  acknowledged: Set<string>,
  waived: Set<string>,
  now: Date,
  expiresAt: Date
):
  | "delete-after-7-days"
  | "retain"
  | "delete-and-reupload-for-current-snapshot" => {
  if (now >= expiresAt) return "delete-and-reupload-for-current-snapshot";
  return recipients.every(
    (recipient) => acknowledged.has(recipient) || waived.has(recipient)
  )
    ? "delete-after-7-days"
    : "retain";
};

describe("Personal Device Sync V1 fixed fixture", () => {
  it("recomputes committed source-manifest bytes, hashes, signature, and terminal attestation", () => {
    const signing = fixture.jcsSigning.sourceManifest;
    const manifest = parseSourceManifest();
    const publicKey = createPublicKey({
      key: okpJwk("Ed25519", signing.ed25519.publicKeyHex),
      format: "jwk"
    });
    const omittedPackageId = manifest.packageId;
    const preimage = withoutFields(manifest as Record<string, unknown>, [
      "packageId",
      "originSignature"
    ]);
    const { originSignature, ...unsigned } = manifest as SourceManifest & {
      originSignature: unknown;
    };
    const rawByteCount = manifest.rawClosure.records.reduce(
      (count, record) =>
        count + Buffer.from(record.payload, "base64url").length,
      0
    );

    expect(fixture.protocol).toBe("koed/pds/v1");
    expect(canonicalizePdsJson(manifest)).toBe(signing.canonicalPayloadUtf8);
    expect(canonicalizePdsJson(preimage)).toBe(signing.packageIdPreimageUtf8);
    expect(omittedPackageId).toBe(signing.packageId);
    expect(rawByteCount).toBe(Number(manifest.rawClosure.rawByteCount));
    expect(manifest.rawClosure.records).toHaveLength(
      Number(manifest.rawClosure.recordCount)
    );
    expect(manifest.terminal).toEqual({ cursor: "1", itemCount: "1" });
    expect(manifest.projectAliasManifest).toEqual({
      version: "1",
      epoch: "3",
      tokens: [manifest.projectAliasManifest.tokens[0]]
    });
    expect(
      manifest.rawClosure.records.map((record) =>
        base64url(sha256(Buffer.from(record.payload, "base64url")))
      )
    ).toEqual(manifest.rawClosure.records.map((record) => record.payloadHash));
    expect(
      base64url(sha256(canonicalizePdsJson(manifest.rawClosure.records)))
    ).toBe(signing.sourceClosureHash);
    expect(
      base64url(
        sha256(`koed/pds/v1/package-id\n${signing.packageIdPreimageUtf8}`)
      )
    ).toBe(signing.packageId);
    expect(base64url(sha256(canonicalizePdsJson(unsigned)))).toBe(
      signing.manifestHash
    );
    expect(
      verify(
        null,
        Buffer.alloc(0),
        publicKey,
        hex(signing.ed25519.rfc8032EmptyMessageSignatureHex)
      )
    ).toBe(true);
    expect(
      verify(
        null,
        Buffer.from(
          `${signing.domain}${canonicalizePdsJson(unsigned)}`,
          "utf8"
        ),
        publicKey,
        Buffer.from(
          (originSignature as { signature: string }).signature,
          "base64url"
        )
      )
    ).toBe(true);
  });

  it("recomputes every committed signed record, wrapper, domain, and record hash", () => {
    for (const [recordName, fixtureRecord] of Object.entries(
      fixture.signedRecords
    )) {
      const parsed = parseCanonicalPdsJson(
        fixtureRecord.canonicalPayloadUtf8
      ) as Record<string, unknown>;
      expect(canonicalizePdsJson(parsed), recordName).toBe(
        fixtureRecord.canonicalPayloadUtf8
      );
      expect(
        base64url(sha256(fixtureRecord.canonicalPayloadUtf8)),
        recordName
      ).toBe(fixtureRecord.recordHash);

      for (const plan of fixtureRecord.plans) {
        const signedInput =
          plan.wrapper === "authorization"
            ? (parsed.draft as Record<string, unknown>)
            : withoutFields(parsed, plan.removeFields);
        const publicKey = createPublicKey({
          key: okpJwk("Ed25519", plan.publicKeyHex),
          format: "jwk"
        });
        const signature = signatureFor(parsed, plan.wrapper);
        const message = Buffer.from(
          `${plan.domain}${canonicalizePdsJson(signedInput)}`,
          "utf8"
        );

        expect(verify(null, message, publicKey, signature), recordName).toBe(
          true
        );
        expect(
          verify(
            null,
            Buffer.from(
              `koed/pds/v1/not-${recordName}\n${canonicalizePdsJson(signedInput)}`,
              "utf8"
            ),
            publicKey,
            signature
          ),
          `${recordName} domain`
        ).toBe(false);
        expect(
          verify(
            null,
            Buffer.from(
              `${plan.domain}${canonicalizePdsJson({ ...signedInput, altered: true })}`,
              "utf8"
            ),
            publicKey,
            signature
          ),
          `${recordName} wrapper`
        ).toBe(false);
      }
    }
  });

  it("binds versioned Key Bundle recipients, commitments, and envelope context", () => {
    const bundle = parseCanonicalPdsJson(
      fixture.signedRecords.keyBundle.canonicalPayloadUtf8
    ) as {
      draft: {
        epoch: string;
        keyType: string;
        recipientSnapshot: string[];
        recipientSnapshotHash: string;
        epochKeyCommitment: string;
        sourceFingerprintKeyCommitment: string;
        tombstoneFloorKeyCommitment: string;
        projectAliasKeyCommitment: string;
        envelopes: Array<{
          recipientId: string;
          recipientKind: string;
          recipientKemKeyId: string;
          ephemeralPublicKey: string;
          envelopeContext: string;
        }>;
      };
    };
    const draft = bundle.draft;

    expect(draft.epoch).toBe("2");
    expect(draft.keyType).toBe("group-secret-set");
    expect(draft.recipientSnapshot).toEqual(
      [...draft.recipientSnapshot].sort()
    );
    expect(
      base64url(sha256(canonicalizePdsJson(draft.recipientSnapshot)))
    ).toBe(draft.recipientSnapshotHash);
    for (const commitment of [
      draft.epochKeyCommitment,
      draft.sourceFingerprintKeyCommitment,
      draft.tombstoneFloorKeyCommitment,
      draft.projectAliasKeyCommitment
    ]) {
      expect(Buffer.from(commitment, "base64url")).toHaveLength(32);
    }
    expect(draft.envelopes.map((envelope) => envelope.recipientId)).toEqual(
      draft.recipientSnapshot
    );
    for (const envelope of draft.envelopes) {
      expect(["device", "recovery"]).toContain(envelope.recipientKind);
      expect(envelope.recipientKemKeyId).not.toBe("");
      expect(
        Buffer.from(envelope.ephemeralPublicKey, "base64url")
      ).toHaveLength(32);
      expect(envelope.envelopeContext).toBe("koed/pds/v1/key-bundle-envelope");
    }
  });

  it("uses exact two-stage group draft and finalized-statement hash", () => {
    const group = parseCanonicalPdsJson(
      fixture.signedRecords.groupStatement.canonicalPayloadUtf8
    ) as {
      draft: Record<string, unknown>;
      authorization: unknown;
      authority: unknown;
    };

    expect(Object.keys(group.draft).sort()).toEqual([
      "body",
      "groupId",
      "kind",
      "previousHash",
      "protocol",
      "sequence"
    ]);
    expect(group.draft.previousHash).toBeNull();
    expect(
      (group.draft.body as Record<string, unknown>).recoveryKitVerified
    ).toBe(true);
    expect(group.authorization).toBeDefined();
    expect(group.authority).toBeDefined();
    expect(fixture.signedRecords.groupStatement.recordHash).toBe(
      base64url(
        sha256(fixture.signedRecords.groupStatement.canonicalPayloadUtf8)
      )
    );
  });

  it("rejects duplicate members, invalid Unicode, numbers, undefined, and noncanonical raw PDS JSON", () => {
    expect(() => parseCanonicalPdsJson('{"a":"first","a":"second"}')).toThrow(
      "duplicate object member"
    );
    expect(() => parseCanonicalPdsJson('{"a":"\\ud800"}')).toThrow(
      "invalid string"
    );
    expect(() => parseCanonicalPdsJson('{"a":1}')).toThrow("decimal strings");
    expect(() => canonicalizePdsJson({ a: undefined })).toThrow("undefined");
    expect(() => parseCanonicalPdsJson('{ "a":"value"}')).toThrow(
      "not RFC 8785 canonical"
    );
    expect(canonicalizePdsJson({ a: "é" })).toBe('{"a":"é"}');
  });

  it("requires canonical decimal uint64 fields and unsigned uint64be encoding", () => {
    expect(parsePdsUint64("18446744073709551615")).toBe(
      18_446_744_073_709_551_615n
    );
    expect(pdsUint64be("3").toString("hex")).toBe("0000000000000003");
    for (const value of ["03", "-1", "1.0", "18446744073709551616"]) {
      expect(() => parsePdsUint64(value)).toThrow();
    }
    expect(typeof fixture.compositeRecipientEnvelope.recipientEpoch).toBe(
      "string"
    );
    expect(
      typeof fixture.compositeRecipientEnvelope.rewrappedRecipientEnvelope
        .recipientEpoch
    ).toBe("string");
  });

  it("recomputes committed HKDF and AES-256-GCM reference outputs", () => {
    const hkdf = fixture.hkdfRfc5869Case1;
    const aes = fixture.aes256GcmNist;
    const cipher = createCipheriv(
      "aes-256-gcm",
      hex(aes.keyHex),
      hex(aes.nonceHex)
    );
    cipher.setAAD(hex(aes.aadHex));
    const ciphertext = Buffer.concat([
      cipher.update(hex(aes.plaintextHex)),
      cipher.final()
    ]);

    expect(
      Buffer.from(
        hkdfSync(
          "sha256",
          hex(hkdf.ikmHex),
          hex(hkdf.saltHex),
          hex(hkdf.infoHex),
          Number(parsePdsUint64(hkdf.length))
        )
      ).toString("hex")
    ).toBe(hkdf.okmHex);
    expect(ciphertext.toString("hex")).toBe(aes.ciphertextHex);
    expect(cipher.getAuthTag().toString("hex")).toBe(aes.tagHex);
  });

  it("recomputes committed X25519 recipient-envelope bytes and outputs", () => {
    const x25519 = fixture.x25519;
    const envelope = fixture.compositeRecipientEnvelope;
    const alice = createPrivateKey({
      key: okpJwk(
        "X25519",
        x25519.alicePublicKeyHex,
        x25519.alicePrivateKeyHex
      ),
      format: "jwk"
    });
    const bob = createPrivateKey({
      key: okpJwk("X25519", x25519.bobPublicKeyHex, x25519.bobPrivateKeyHex),
      format: "jwk"
    });
    const sharedSecret = requireNonZeroSharedSecret(
      diffieHellman({ privateKey: alice, publicKey: createPublicKey(bob) })
    );
    const reciprocalSharedSecret = requireNonZeroSharedSecret(
      diffieHellman({ privateKey: bob, publicKey: createPublicKey(alice) })
    );
    const salt = sha256(
      Buffer.concat([
        Buffer.from("koed/pds/v1/envelope/salt\0", "utf8"),
        Buffer.from(envelope.groupId, "utf8")
      ])
    );
    const wrappingKey = Buffer.from(
      hkdfSync(
        "sha256",
        sharedSecret,
        salt,
        recipientEnvelopeInfo(envelope),
        32
      )
    );
    const cipher = createCipheriv(
      "aes-256-gcm",
      wrappingKey,
      hex(envelope.nonceHex)
    );
    cipher.setAAD(Buffer.from(recipientEnvelopeAad(envelope), "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(hex(envelope.contentEncryptionKeyHex)),
      cipher.final()
    ]);

    expect(reciprocalSharedSecret).toEqual(sharedSecret);
    expect(sharedSecret.toString("hex")).toBe(x25519.sharedSecretHex);
    expect(salt.toString("hex")).toBe(envelope.saltHex);
    expect(recipientEnvelopeInfo(envelope).toString("hex")).toBe(
      envelope.infoHex
    );
    expect(recipientEnvelopeAad(envelope)).toBe(envelope.aadUtf8);
    expect(wrappingKey.toString("hex")).toBe(envelope.wrappingKeyHex);
    expect(ciphertext.toString("hex")).toBe(envelope.ciphertextHex);
    expect(cipher.getAuthTag().toString("hex")).toBe(envelope.tagHex);

    const rewrapped = { ...envelope, ...envelope.rewrappedRecipientEnvelope };
    const rewrappedKey = Buffer.from(
      hkdfSync(
        "sha256",
        sharedSecret,
        salt,
        recipientEnvelopeInfo(rewrapped),
        32
      )
    );
    const rewrappedCipher = createCipheriv(
      "aes-256-gcm",
      rewrappedKey,
      hex(rewrapped.nonceHex)
    );
    rewrappedCipher.setAAD(
      Buffer.from(recipientEnvelopeAad(rewrapped), "utf8")
    );
    const rewrappedCiphertext = Buffer.concat([
      rewrappedCipher.update(hex(envelope.contentEncryptionKeyHex)),
      rewrappedCipher.final()
    ]);

    expect(recipientEnvelopeInfo(rewrapped).toString("hex")).toBe(
      rewrapped.infoHex
    );
    expect(recipientEnvelopeAad(rewrapped)).toBe(rewrapped.aadUtf8);
    expect(rewrappedKey.toString("hex")).toBe(rewrapped.wrappingKeyHex);
    expect(rewrappedCiphertext.toString("hex")).toBe(rewrapped.ciphertextHex);
    expect(rewrappedCipher.getAuthTag().toString("hex")).toBe(rewrapped.tagHex);
  });

  it("rejects injected all-zero shared secret and altered recipient-envelope AAD", () => {
    const x25519 = fixture.x25519;
    const envelope = fixture.compositeRecipientEnvelope;
    const alice = createPrivateKey({
      key: okpJwk(
        "X25519",
        x25519.alicePublicKeyHex,
        x25519.alicePrivateKeyHex
      ),
      format: "jwk"
    });
    const allZeroPublicKey = createPublicKey({
      key: okpJwk("X25519", x25519.allZeroPublicKeyHex),
      format: "jwk"
    });
    const decipher = createDecipheriv(
      "aes-256-gcm",
      hex(envelope.wrappingKeyHex),
      hex(envelope.nonceHex)
    );
    decipher.setAAD(Buffer.from(`${envelope.aadUtf8}!`, "utf8"));
    decipher.setAuthTag(hex(envelope.tagHex));

    expect(() => requireNonZeroSharedSecret(Buffer.alloc(32))).toThrow(
      "must be 32 non-zero bytes"
    );
    expect(() =>
      diffieHellman({ privateKey: alice, publicKey: allZeroPublicKey })
    ).toThrow();
    expect(() =>
      Buffer.concat([
        decipher.update(hex(envelope.ciphertextHex)),
        decipher.final()
      ])
    ).toThrow();
  });

  it("derives opaque deletion identifiers from source fingerprint and rejects matching floor before materialization", () => {
    const fingerprint = fixture.sourceFingerprint;
    const manifest = parseSourceManifest();
    const sourceDigest = createHmac("sha256", hex(fingerprint.keyHex))
      .update(
        `koed/pds/v1/source-fingerprint\0${fingerprint.sourceType}\0${fingerprint.sourceNativeSessionId}`,
        "utf8"
      )
      .digest("base64url");
    const logicalMemoryId = createHmac(
      "sha256",
      hex(fingerprint.tombstoneKeyHex)
    )
      .update(`koed/pds/v1/logical-memory-id\0${sourceDigest}`, "utf8")
      .digest("base64url");
    const deletionFloorToken = createHmac(
      "sha256",
      hex(fingerprint.tombstoneKeyHex)
    )
      .update(`koed/pds/v1/deletion-floor\0${sourceDigest}`, "utf8")
      .digest("base64url");

    expect(sourceDigest).toBe(fingerprint.digestBase64url);
    expect(logicalMemoryId).toBe(fingerprint.logicalMemoryId);
    expect(deletionFloorToken).toBe(fingerprint.deletionFloorToken);
    expect(manifest.logicalMemoryId).toBe(logicalMemoryId);
    expect(manifest.deletionFloorToken).toBe(deletionFloorToken);
    expect(manifest.projectAliasManifest.tokens).toEqual([
      createHmac("sha256", hex(fingerprint.projectAliasKeyHex))
        .update("koed/pds/v1/project-alias\0github.com/example/koed", "utf8")
        .digest("base64url")
    ]);
    expect(
      fixture.jcsSigning.sourceManifest.canonicalPayloadUtf8
    ).not.toContain("github.com/example/koed");
    expect(
      applyDeletionFloor(
        fixture.stateFixtures.tombstone.floor,
        fixture.stateFixtures.tombstone.stalePackage
      )
    ).toBe(fixture.stateFixtures.tombstone.stalePackage.expected);
    expect(
      applyDeletionFloor(
        fixture.stateFixtures.tombstone.floor,
        fixture.stateFixtures.tombstone.differentPackage
      )
    ).toBe(fixture.stateFixtures.tombstone.differentPackage.expected);
  });

  it("enforces certificate skew, lifetime, and expiry", () => {
    const certificate = fixture.membershipCertificate;
    const issuedAt = new Date(certificate.issuedAt);
    const expiresAt = new Date(certificate.expiresAt);
    const skew = Number(parsePdsUint64(certificate.clockSkewSeconds));
    const maximumLifetime = Number(
      parsePdsUint64(certificate.maxLifetimeSeconds)
    );

    expect(
      certificateIsAccepted(
        new Date(issuedAt.getTime() - skew * 1_000),
        issuedAt,
        expiresAt,
        certificate.clockSkewSeconds,
        certificate.maxLifetimeSeconds
      )
    ).toBe(true);
    expect(
      certificateIsAccepted(
        new Date(issuedAt.getTime() - skew * 1_000 - 1),
        issuedAt,
        expiresAt,
        certificate.clockSkewSeconds,
        certificate.maxLifetimeSeconds
      )
    ).toBe(false);
    expect(
      certificateIsAccepted(
        expiresAt,
        issuedAt,
        expiresAt,
        certificate.clockSkewSeconds,
        certificate.maxLifetimeSeconds
      )
    ).toBe(false);
    expect(
      certificateIsAccepted(
        issuedAt,
        issuedAt,
        new Date(issuedAt.getTime() + (maximumLifetime + 1) * 1_000),
        certificate.clockSkewSeconds,
        certificate.maxLifetimeSeconds
      )
    ).toBe(false);
  });

  it("enforces replay, convergence quarantine, equivocation freeze, and ACK cleanup", () => {
    const states = fixture.stateFixtures;
    expect(classifyReplay(states.replay.first, states.replay.same)).toBe(
      states.replay.same.expected
    );
    expect(classifyReplay(states.replay.first, states.replay.changed)).toBe(
      states.replay.changed.expected
    );
    expect(
      classifyClosure(
        states.convergence.sameClosure,
        states.convergence.sameClosure
      )
    ).toBe(states.convergence.sameClosure.expected);
    expect(
      classifyClosure(
        {
          fingerprint: states.convergence.differentClosure.fingerprint,
          closureHash: states.convergence.differentClosure.existingClosureHash
        },
        states.convergence.differentClosure
      )
    ).toBe(states.convergence.differentClosure.expected);
    expect(
      classifyLogHead(states.equivocation.trusted, states.equivocation.received)
    ).toBe(states.equivocation.received.expected);

    const ack = states.packageAck;
    expect(
      cleanupDisposition(
        ack.intendedRecipientSnapshot,
        new Set([ack.acknowledgedRecipient]),
        new Set([ack.revokedAfterUploadRecipient]),
        new Date("2026-07-15T00:01:00.000Z"),
        new Date(ack.expiresAt)
      )
    ).toBe(ack.expectedAllAckCleanup);
    expect(ack.expectedRevocationWaiver).toBe(
      "waive-after-countersigned-revoke"
    );
    expect(
      cleanupDisposition(
        ack.intendedRecipientSnapshot,
        new Set([ack.acknowledgedRecipient]),
        new Set(),
        new Date("2026-08-15T00:00:04.000Z"),
        new Date(ack.expiresAt)
      )
    ).toBe(ack.expectedExpiry);
  });
});
