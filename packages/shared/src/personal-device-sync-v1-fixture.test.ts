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
import { canonicalJsonStringify } from "./canonical-json.js";

type Fixture = {
  protocol: "koed/pds/v1";
  jcsSigning: {
    domain: string;
    canonicalPayloadUtf8: string;
    packageIdPreimageUtf8: string;
    packageId: string;
    manifestHash: string;
    sourceClosureHash: string;
    ed25519: {
      seedHex: string;
      publicKeyHex: string;
      signatureHex: string;
      rfc8032EmptyMessageSignatureHex: string;
    };
    groupStatement: {
      domain: string;
      canonicalPayloadUtf8: string;
      authorizationPublicKeyHex: string;
      authorityPublicKeyHex: string;
    };
  };
  hkdfRfc5869Case1: {
    ikmHex: string;
    saltHex: string;
    infoHex: string;
    length: number;
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
    recipientEpoch: number;
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
      recipientEpoch: number;
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
    sourceType: string;
    sourceNativeSessionId: string;
    digestBase64url: string;
  };
  membershipCertificate: {
    issuedAt: string;
    expiresAt: string;
    maxLifetimeSeconds: number;
    clockSkewSeconds: number;
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
      floor: { logicalMemoryId: string; sequence: number };
      stalePackage: {
        logicalMemoryId: string;
        sequence: number;
        expected: string;
      };
      newerPackage: {
        logicalMemoryId: string;
        sequence: number;
        expected: string;
      };
    };
  };
};

type SourceManifest = {
  packageId: string;
  sourceClosureHash: string;
  sourceFingerprint: string;
  sourceNativeSessionId: string;
  sourceType: string;
  rawClosure: {
    rawByteCount: string;
    recordCount: string;
    records: Array<{ payload: string; payloadHash: string }>;
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
  JSON.parse(fixture.jcsSigning.canonicalPayloadUtf8) as SourceManifest;

const withoutFields = (
  value: Record<string, unknown>,
  fields: readonly string[]
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(value).filter(([field]) => !fields.includes(field))
  );

const sha256 = (value: string | Buffer): Buffer =>
  createHash("sha256").update(value).digest();

const recipientEnvelopeInfo = (
  envelope: Fixture["compositeRecipientEnvelope"]
): Buffer => {
  const epoch = Buffer.alloc(8);
  epoch.writeBigUInt64BE(BigInt(envelope.recipientEpoch));
  return Buffer.concat([
    Buffer.from("koed/pds/v1/envelope/key\0", "utf8"),
    epoch,
    Buffer.from(
      `${envelope.packageId}\0${envelope.recipientDeviceId}\0${envelope.senderDeviceId}`,
      "utf8"
    )
  ]);
};

const recipientEnvelopeAad = (
  envelope: Fixture["compositeRecipientEnvelope"]
): string =>
  canonicalJsonStringify({
    packageId: envelope.packageId,
    recipientDeviceId: envelope.recipientDeviceId,
    recipientEpoch: envelope.recipientEpoch,
    senderDeviceId: envelope.senderDeviceId
  });

const certificateIsAccepted = (
  now: Date,
  issuedAt: Date,
  expiresAt: Date,
  clockSkewSeconds: number,
  maxLifetimeSeconds: number
): boolean =>
  issuedAt.getTime() <= now.getTime() + clockSkewSeconds * 1_000 &&
  now.getTime() < expiresAt.getTime() &&
  expiresAt.getTime() - issuedAt.getTime() <= maxLifetimeSeconds * 1_000;

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
  floor: { logicalMemoryId: string; sequence: number },
  received: { logicalMemoryId: string; sequence: number }
): "allow" | "reject" =>
  floor.logicalMemoryId === received.logicalMemoryId &&
  received.sequence <= floor.sequence
    ? "reject"
    : "allow";

describe("Personal Device Sync V1 fixed fixture", () => {
  it("recomputes committed JCS bytes, hashes, and source-manifest signature", () => {
    const signing = fixture.jcsSigning;
    const manifest = parseSourceManifest();
    const publicKey = createPublicKey({
      key: okpJwk("Ed25519", signing.ed25519.publicKeyHex),
      format: "jwk"
    });
    const { packageId: omittedPackageId, ...packageIdPreimage } = manifest;
    const rawByteCount = manifest.rawClosure.records.reduce(
      (count, record) =>
        count + Buffer.from(record.payload, "base64url").length,
      0
    );

    expect(fixture.protocol).toBe("koed/pds/v1");
    expect(canonicalJsonStringify(manifest)).toBe(signing.canonicalPayloadUtf8);
    expect(canonicalJsonStringify(packageIdPreimage)).toBe(
      signing.packageIdPreimageUtf8
    );
    expect(omittedPackageId).toBe(signing.packageId);
    expect(rawByteCount).toBe(Number(manifest.rawClosure.rawByteCount));
    expect(manifest.rawClosure.records).toHaveLength(
      Number(manifest.rawClosure.recordCount)
    );
    expect(
      manifest.rawClosure.records.map((record) =>
        base64url(sha256(Buffer.from(record.payload, "base64url")))
      )
    ).toEqual(manifest.rawClosure.records.map((record) => record.payloadHash));
    expect(
      base64url(sha256(canonicalJsonStringify(manifest.rawClosure.records)))
    ).toBe(signing.sourceClosureHash);
    expect(manifest.sourceClosureHash).toBe(signing.sourceClosureHash);
    expect(
      base64url(
        sha256(`koed/pds/v1/package-id\n${signing.packageIdPreimageUtf8}`)
      )
    ).toBe(signing.packageId);
    expect(base64url(sha256(signing.canonicalPayloadUtf8))).toBe(
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
        Buffer.from(`${signing.domain}${signing.canonicalPayloadUtf8}`, "utf8"),
        publicKey,
        hex(signing.ed25519.signatureHex)
      )
    ).toBe(true);
    expect(
      verify(
        null,
        Buffer.from(
          `koed/pds/v1/tombstone\n${signing.canonicalPayloadUtf8}`,
          "utf8"
        ),
        publicKey,
        hex(signing.ed25519.signatureHex)
      )
    ).toBe(false);
  });

  it("verifies committed group-statement authorization and countersignature", () => {
    const statement = fixture.jcsSigning.groupStatement;
    const parsed = JSON.parse(statement.canonicalPayloadUtf8) as {
      authorization: { signature: string };
      authority: { signature: string };
      [key: string]: unknown;
    };
    const authorization = parsed.authorization;
    const authority = parsed.authority;
    const authorizationInput = withoutFields(parsed, [
      "authorization",
      "authority"
    ]);
    const authorityInput = withoutFields(parsed, ["authority"]);
    const authorizationPublicKey = createPublicKey({
      key: okpJwk("Ed25519", statement.authorizationPublicKeyHex),
      format: "jwk"
    });
    const authorityPublicKey = createPublicKey({
      key: okpJwk("Ed25519", statement.authorityPublicKeyHex),
      format: "jwk"
    });

    expect(canonicalJsonStringify(parsed)).toBe(statement.canonicalPayloadUtf8);
    expect(
      verify(
        null,
        Buffer.from(
          `${statement.domain}${canonicalJsonStringify(authorizationInput)}`,
          "utf8"
        ),
        authorizationPublicKey,
        Buffer.from(authorization.signature, "base64url")
      )
    ).toBe(true);
    expect(
      verify(
        null,
        Buffer.from(
          `${statement.domain}${canonicalJsonStringify(authorityInput)}`,
          "utf8"
        ),
        authorityPublicKey,
        Buffer.from(authority.signature, "base64url")
      )
    ).toBe(true);
    expect(
      verify(
        null,
        Buffer.from(
          `koed/pds/v1/tombstone\n${canonicalJsonStringify(authorityInput)}`,
          "utf8"
        ),
        authorityPublicKey,
        Buffer.from(authority.signature, "base64url")
      )
    ).toBe(false);
  });

  it("verifies committed HKDF and AES-256-GCM reference outputs", () => {
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
          hkdf.length
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
    const sharedSecret = diffieHellman({
      privateKey: alice,
      publicKey: createPublicKey(bob)
    });
    const reciprocalSharedSecret = diffieHellman({
      privateKey: bob,
      publicKey: createPublicKey(alice)
    });
    const salt = sha256(
      Buffer.concat([
        Buffer.from("koed/pds/v1/envelope/salt\0", "utf8"),
        Buffer.from(envelope.groupId, "utf8")
      ])
    );
    const info = recipientEnvelopeInfo(envelope);
    const wrappingKey = Buffer.from(
      hkdfSync("sha256", sharedSecret, salt, info, 32)
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

    expect(base64url(hex(x25519.alicePublicKeyHex))).toBe(
      createPublicKey(alice).export({ format: "jwk" }).x
    );
    expect(base64url(hex(x25519.bobPublicKeyHex))).toBe(
      createPublicKey(bob).export({ format: "jwk" }).x
    );
    expect(reciprocalSharedSecret).toEqual(sharedSecret);
    expect(sharedSecret.equals(Buffer.alloc(32))).toBe(false);
    expect(sharedSecret.toString("hex")).toBe(x25519.sharedSecretHex);
    expect(salt.toString("hex")).toBe(envelope.saltHex);
    expect(info.toString("hex")).toBe(envelope.infoHex);
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

  it("rejects all-zero X25519 output and altered recipient-envelope AAD", () => {
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

  it("rejects altered HMAC and envelope domain labels", () => {
    const fingerprint = fixture.sourceFingerprint;
    const manifest = parseSourceManifest();
    const envelope = fixture.compositeRecipientEnvelope;
    const sourceFingerprintInput = `koed/pds/v1/source-fingerprint\0${fingerprint.sourceType}\0${fingerprint.sourceNativeSessionId}`;
    const digest = createHmac("sha256", hex(fingerprint.keyHex))
      .update(sourceFingerprintInput, "utf8")
      .digest("base64url");
    const alteredDomainDigest = createHmac("sha256", hex(fingerprint.keyHex))
      .update(
        `koed/pds/v1/source-fingerprint/v2\0${fingerprint.sourceType}\0${fingerprint.sourceNativeSessionId}`,
        "utf8"
      )
      .digest("base64url");
    const alteredSalt = sha256(
      `koed/pds/v1/envelope/salt/v2\0${envelope.groupId}`
    );
    const alteredWrappingKey = Buffer.from(
      hkdfSync(
        "sha256",
        hex(fixture.x25519.sharedSecretHex),
        alteredSalt,
        recipientEnvelopeInfo(envelope),
        32
      )
    ).toString("hex");

    expect(digest).toBe(fingerprint.digestBase64url);
    expect(manifest.sourceType).toBe(fingerprint.sourceType);
    expect(manifest.sourceNativeSessionId).toBe(
      fingerprint.sourceNativeSessionId
    );
    expect(manifest.sourceFingerprint).toBe(fingerprint.digestBase64url);
    expect(alteredDomainDigest).not.toBe(fingerprint.digestBase64url);
    expect(alteredSalt.toString("hex")).not.toBe(envelope.saltHex);
    expect(alteredWrappingKey).not.toBe(envelope.wrappingKeyHex);
  });

  it("enforces membership certificate skew, maximum lifetime, and expiry", () => {
    const certificate = fixture.membershipCertificate;
    const issuedAt = new Date(certificate.issuedAt);
    const expiresAt = new Date(certificate.expiresAt);
    const oneMillisecondBeforeIssuedSkew = new Date(
      issuedAt.getTime() - certificate.clockSkewSeconds * 1_000 - 1
    );
    const maximumLifetimeExceeded = new Date(
      issuedAt.getTime() + (certificate.maxLifetimeSeconds + 1) * 1_000
    );

    expect(
      certificateIsAccepted(
        new Date(issuedAt.getTime() - certificate.clockSkewSeconds * 1_000),
        issuedAt,
        expiresAt,
        certificate.clockSkewSeconds,
        certificate.maxLifetimeSeconds
      )
    ).toBe(true);
    expect(
      certificateIsAccepted(
        oneMillisecondBeforeIssuedSkew,
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
        maximumLifetimeExceeded,
        certificate.clockSkewSeconds,
        certificate.maxLifetimeSeconds
      )
    ).toBe(false);
  });

  it("enforces replay, convergence quarantine, equivocation freeze, and tombstone floor", () => {
    const states = fixture.stateFixtures;

    expect(classifyReplay(states.replay.first, states.replay.same)).toBe(
      states.replay.same.expected
    );
    expect(classifyReplay(states.replay.first, states.replay.changed)).toBe(
      states.replay.changed.expected
    );
    expect(
      classifyReplay(states.replay.first, {
        ...states.replay.same,
        packageId: "pkg-other"
      })
    ).toBe("new");
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
      classifyClosure(states.convergence.sameClosure, {
        ...states.convergence.sameClosure,
        fingerprint: "fp-other"
      })
    ).toBe("distinct");
    expect(
      classifyLogHead(states.equivocation.trusted, states.equivocation.received)
    ).toBe(states.equivocation.received.expected);
    expect(
      applyDeletionFloor(states.tombstone.floor, states.tombstone.stalePackage)
    ).toBe(states.tombstone.stalePackage.expected);
    expect(
      applyDeletionFloor(states.tombstone.floor, states.tombstone.newerPackage)
    ).toBe(states.tombstone.newerPackage.expected);
  });
});
