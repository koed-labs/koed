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

type Fixture = {
  protocol: "koed/pds/v1";
  jcsSigning: {
    domain: string;
    canonicalPayloadUtf8: string;
    packageIdPreimageUtf8: string;
    packageId: string;
    manifestHash: string;
    ed25519: {
      seedHex: string;
      publicKeyHex: string;
      signatureHex: string;
      rfc8032EmptyMessageSignatureHex: string;
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
    allZeroSharedSecretHex: string;
    allZeroRejected: boolean;
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
  sourceFingerprint: { keyHex: string; messageUtf8: string; digestHex: string };
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

const fixture = JSON.parse(
  readFileSync(
    new URL("../test-fixtures/personal-device-sync-v1.json", import.meta.url),
    "utf8"
  )
) as Fixture;

const hex = (value: string): Buffer => Buffer.from(value, "hex");

const rawPrivateKey = (algorithmOid: string, raw: string) =>
  createPrivateKey({
    key: Buffer.concat([
      Buffer.from(`302e02010030050603${algorithmOid}04220420`, "hex"),
      hex(raw)
    ]),
    format: "der",
    type: "pkcs8"
  });

const rawPublicKey = (algorithmOid: string, raw: string) =>
  createPublicKey({
    key: Buffer.concat([
      Buffer.from(`302a30050603${algorithmOid}032100`, "hex"),
      hex(raw)
    ]),
    format: "der",
    type: "spki"
  });

const requireNonZeroX25519SharedSecret = (value: Buffer): Buffer => {
  if (value.byteLength !== 32 || value.every((byte) => byte === 0)) {
    throw new Error("X25519 shared secret must be 32 non-zero bytes");
  }
  return value;
};

const certificateIsCurrent = (now: Date, expiresAt: Date): boolean =>
  now.getTime() < expiresAt.getTime();

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
  it("verifies fixed RFC 8785 UTF-8 domain bytes and Ed25519 signature", () => {
    const signing = fixture.jcsSigning;
    const publicKey = rawPublicKey("2b6570", signing.ed25519.publicKeyHex);
    const input = Buffer.from(
      `${signing.domain}${signing.canonicalPayloadUtf8}`,
      "utf8"
    );

    expect(fixture.protocol).toBe("koed/pds/v1");
    expect(
      verify(
        null,
        Buffer.alloc(0),
        publicKey,
        hex(signing.ed25519.rfc8032EmptyMessageSignatureHex)
      )
    ).toBe(true);
    expect(
      verify(null, input, publicKey, hex(signing.ed25519.signatureHex))
    ).toBe(true);
    expect(
      createHash("sha256")
        .update("koed/pds/v1/package-id\n", "utf8")
        .update(signing.packageIdPreimageUtf8, "utf8")
        .digest("base64url")
    ).toBe(signing.packageId);
    expect(
      createHash("sha256")
        .update(signing.canonicalPayloadUtf8, "utf8")
        .digest("base64url")
    ).toBe(signing.manifestHash);
    expect(
      verify(
        null,
        Buffer.from(`koed/pds/v1/tombstone\n${signing.canonicalPayloadUtf8}`),
        publicKey,
        hex(signing.ed25519.signatureHex)
      )
    ).toBe(false);
  });

  it("uses committed RFC 5869 HKDF-SHA-256 output", () => {
    const vector = fixture.hkdfRfc5869Case1;
    const output = Buffer.from(
      hkdfSync(
        "sha256",
        hex(vector.ikmHex),
        hex(vector.saltHex),
        hex(vector.infoHex),
        vector.length
      )
    );

    expect(output.toString("hex")).toBe(vector.okmHex);
  });

  it("uses committed NIST AES-256-GCM output", () => {
    const vector = fixture.aes256GcmNist;
    const cipher = createCipheriv(
      "aes-256-gcm",
      hex(vector.keyHex),
      hex(vector.nonceHex)
    );
    cipher.setAAD(hex(vector.aadHex));
    const ciphertext = Buffer.concat([
      cipher.update(hex(vector.plaintextHex)),
      cipher.final()
    ]);

    expect(ciphertext.toString("hex")).toBe(vector.ciphertextHex);
    expect(cipher.getAuthTag().toString("hex")).toBe(vector.tagHex);
  });

  it("uses committed X25519, HKDF-SHA-256, and AES-256-GCM outputs", () => {
    const x25519 = fixture.x25519;
    const envelope = fixture.compositeRecipientEnvelope;
    const alice = rawPrivateKey("2b656e", x25519.alicePrivateKeyHex);
    const bob = rawPublicKey("2b656e", x25519.bobPublicKeyHex);
    const sharedSecret = requireNonZeroX25519SharedSecret(
      diffieHellman({ privateKey: alice, publicKey: bob })
    );
    const wrappingKey = Buffer.from(
      hkdfSync(
        "sha256",
        sharedSecret,
        hex(envelope.saltHex),
        hex(envelope.infoHex),
        32
      )
    );
    const cipher = createCipheriv(
      "aes-256-gcm",
      wrappingKey,
      hex(envelope.nonceHex)
    );
    cipher.setAAD(Buffer.from(envelope.aadUtf8, "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(hex(envelope.contentEncryptionKeyHex)),
      cipher.final()
    ]);

    expect(sharedSecret.toString("hex")).toBe(x25519.sharedSecretHex);
    expect(wrappingKey.toString("hex")).toBe(envelope.wrappingKeyHex);
    expect(ciphertext.toString("hex")).toBe(envelope.ciphertextHex);
    expect(cipher.getAuthTag().toString("hex")).toBe(envelope.tagHex);
  });

  it("re-wraps fixed CEK for a new recipient epoch without changing CEK", () => {
    const x25519 = fixture.x25519;
    const envelope = fixture.compositeRecipientEnvelope;
    const rewrapped = envelope.rewrappedRecipientEnvelope;
    const alice = rawPrivateKey("2b656e", x25519.alicePrivateKeyHex);
    const bob = rawPublicKey("2b656e", x25519.bobPublicKeyHex);
    const shared = diffieHellman({ privateKey: alice, publicKey: bob });
    const key = Buffer.from(
      hkdfSync(
        "sha256",
        shared,
        hex(envelope.saltHex),
        hex(rewrapped.infoHex),
        32
      )
    );
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      hex(rewrapped.nonceHex)
    );
    decipher.setAAD(Buffer.from(rewrapped.aadUtf8, "utf8"));
    decipher.setAuthTag(hex(rewrapped.tagHex));

    expect(key.toString("hex")).toBe(rewrapped.wrappingKeyHex);
    expect(
      Buffer.concat([
        decipher.update(hex(rewrapped.ciphertextHex)),
        decipher.final()
      ]).toString("hex")
    ).toBe(envelope.contentEncryptionKeyHex);
  });

  it("rejects all-zero X25519 output and altered AES-GCM AAD", () => {
    const x25519 = fixture.x25519;
    const envelope = fixture.compositeRecipientEnvelope;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      hex(envelope.wrappingKeyHex),
      hex(envelope.nonceHex)
    );
    decipher.setAAD(Buffer.from(`${envelope.aadUtf8}!`, "utf8"));
    decipher.setAuthTag(hex(envelope.tagHex));

    expect(() =>
      requireNonZeroX25519SharedSecret(hex(x25519.allZeroSharedSecretHex))
    ).toThrow("must be 32 non-zero bytes");
    expect(x25519.allZeroRejected).toBe(true);
    expect(() =>
      Buffer.concat([
        decipher.update(hex(envelope.ciphertextHex)),
        decipher.final()
      ])
    ).toThrow();
  });

  it("uses fixed HMAC source-fingerprint output and strict expiry boundary", () => {
    const fingerprint = fixture.sourceFingerprint;
    const certificate = fixture.membershipCertificate;
    const digest = createHmac("sha256", hex(fingerprint.keyHex))
      .update(fingerprint.messageUtf8, "utf8")
      .digest("hex");
    const issuedAt = new Date(certificate.issuedAt);
    const expiresAt = new Date(certificate.expiresAt);

    expect(digest).toBe(fingerprint.digestHex);
    expect(certificate.maxLifetimeSeconds).toBe(7 * 24 * 60 * 60);
    expect(certificate.clockSkewSeconds).toBe(5 * 60);
    expect(
      certificateIsCurrent(new Date(expiresAt.getTime() - 1), expiresAt)
    ).toBe(true);
    expect(certificateIsCurrent(expiresAt, expiresAt)).toBe(false);
    expect(issuedAt.getTime()).toBeLessThan(expiresAt.getTime());
  });

  it("makes replay, convergence quarantine, and tombstone-floor outcomes fixed", () => {
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
    expect(
      applyDeletionFloor(states.tombstone.floor, states.tombstone.stalePackage)
    ).toBe(states.tombstone.stalePackage.expected);
    expect(
      applyDeletionFloor(states.tombstone.floor, states.tombstone.newerPackage)
    ).toBe(states.tombstone.newerPackage.expected);
  });
});
