import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  encodePairingTranscript,
  verifyPairingProof,
  type PairingTranscript
} from "./peer-online-pairing.js";

const b64 = (value: Buffer) => value.toString("base64url");
const publicKey = (key: KeyObject) =>
  key.export({ format: "der", type: "spki" }).toString("base64");

function fixture() {
  const signing = generateKeyPairSync("ed25519");
  const encryption = generateKeyPairSync("x25519");
  const challenge = generateKeyPairSync("x25519");
  const random = () => b64(randomBytes(32));
  const transcript: PairingTranscript = {
    groupId: "group",
    genesisHash: random(),
    expectedHead: random(),
    attemptId: random(),
    expiresAt: 2000000000000,
    inviteHash: random(),
    connectionBinding: random(),
    approver: {
      deviceId: "approver",
      signingPublicKey: publicKey(generateKeyPairSync("ed25519").publicKey),
      encryptionPublicKey: publicKey(generateKeyPairSync("x25519").publicKey),
      transportPin: random()
    },
    joiner: {
      deviceId: "joiner",
      signingPublicKey: publicKey(signing.publicKey),
      encryptionPublicKey: publicKey(encryption.publicKey),
      transportPin: random()
    },
    challengePublicKey: publicKey(challenge.publicKey)
  };
  const bytes = encodePairingTranscript(transcript);
  const shared = diffieHellman({
    privateKey: encryption.privateKey,
    publicKey: challenge.publicKey
  });
  const mac = createHmac("sha256", shared)
    .update("koed/peer-online-pairing/v1/x25519\n")
    .update(bytes)
    .digest();
  const signature = sign(
    null,
    Buffer.concat([
      Buffer.from("koed/peer-online-pairing/v1/signature\n"),
      bytes,
      mac
    ]),
    signing.privateKey
  );
  const privateKey = challenge.privateKey
    .export({ format: "der", type: "pkcs8" })
    .toString("base64");
  return {
    transcript,
    proof: { mac: b64(mac), signature: b64(signature) },
    privateKey
  };
}

describe("pairing transcript proof", () => {
  it("accepts possession of both joining keys for the exact transcript", () => {
    const { transcript, proof, privateKey } = fixture();
    expect(
      verifyPairingProof(transcript, proof, privateKey, 1999999999999)
    ).toBe(true);
  });

  it("rejects altered context, expiry, proofs, and wrong challenge key", () => {
    const { transcript, proof, privateKey } = fixture();
    for (const altered of [
      { ...transcript, groupId: "other" },
      { ...transcript, genesisHash: b64(randomBytes(32)) },
      { ...transcript, expectedHead: b64(randomBytes(32)) },
      { ...transcript, attemptId: b64(randomBytes(32)) },
      { ...transcript, inviteHash: b64(randomBytes(32)) },
      { ...transcript, connectionBinding: b64(randomBytes(32)) },
      {
        ...transcript,
        approver: { ...transcript.approver, transportPin: b64(randomBytes(32)) }
      },
      { ...transcript, joiner: { ...transcript.joiner, deviceId: "other" } },
      {
        ...transcript,
        joiner: { ...transcript.joiner, transportPin: b64(randomBytes(32)) }
      }
    ])
      expect(
        verifyPairingProof(altered, proof, privateKey, 1999999999999)
      ).toBe(false);
    expect(
      verifyPairingProof(transcript, proof, privateKey, transcript.expiresAt)
    ).toBe(false);
    expect(
      verifyPairingProof(
        transcript,
        { ...proof, mac: b64(randomBytes(32)) },
        privateKey,
        1
      )
    ).toBe(false);
    expect(
      verifyPairingProof(
        transcript,
        { ...proof, signature: b64(randomBytes(64)) },
        privateKey,
        1
      )
    ).toBe(false);
    const wrong = generateKeyPairSync("x25519")
      .privateKey.export({ format: "der", type: "pkcs8" })
      .toString("base64");
    expect(verifyPairingProof(transcript, proof, wrong, 1)).toBe(false);
  });

  it("rejects an identity-point Ed25519 key with a forged signature and valid MAC", () => {
    const { transcript, privateKey } = fixture();
    const weakKey = Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from("01" + "00".repeat(31), "hex")
    ]).toString("base64");
    const forged = {
      ...transcript,
      joiner: { ...transcript.joiner, signingPublicKey: weakKey }
    };
    // Construct the original canonical wire bytes independently: a hardened encoder
    // must reject this key instead of helping construct the attack.
    const bytes = Buffer.from(
      JSON.stringify([
        "koed/peer-online-pairing/v1/transcript",
        forged.groupId,
        forged.genesisHash,
        forged.expectedHead,
        forged.attemptId,
        forged.expiresAt,
        forged.inviteHash,
        forged.connectionBinding,
        [
          forged.approver.deviceId,
          forged.approver.signingPublicKey,
          forged.approver.encryptionPublicKey,
          forged.approver.transportPin
        ],
        [
          forged.joiner.deviceId,
          forged.joiner.signingPublicKey,
          forged.joiner.encryptionPublicKey,
          forged.joiner.transportPin
        ],
        forged.challengePublicKey
      ])
    );
    const shared = diffieHellman({
      privateKey: createPrivateKey({
        key: Buffer.from(privateKey, "base64"),
        format: "der",
        type: "pkcs8"
      }),
      publicKey: createPublicKey({
        key: Buffer.from(forged.joiner.encryptionPublicKey, "base64"),
        format: "der",
        type: "spki"
      })
    });
    const mac = createHmac("sha256", shared)
      .update("koed/peer-online-pairing/v1/x25519\n")
      .update(bytes)
      .digest();
    const signature = Buffer.from("01" + "00".repeat(63), "hex");
    expect(
      verifyPairingProof(
        forged,
        { mac: b64(mac), signature: b64(signature) },
        privateKey,
        1
      )
    ).toBe(false);
    expect(() =>
      encodePairingTranscript({
        ...transcript,
        approver: { ...transcript.approver, signingPublicKey: weakKey }
      })
    ).toThrow();
  });

  it("rejects role reflection, key substitution, and low-order X25519", () => {
    const { transcript, proof, privateKey } = fixture();
    const weakX = Buffer.concat([
      Buffer.from("302a300506032b656e032100", "hex"),
      Buffer.alloc(32)
    ]).toString("base64");
    const signingKey = publicKey(generateKeyPairSync("ed25519").publicKey);
    const encryptionKey = publicKey(generateKeyPairSync("x25519").publicKey);
    for (const altered of [
      {
        ...transcript,
        approver: transcript.joiner,
        joiner: transcript.approver
      },
      {
        ...transcript,
        approver: { ...transcript.approver, signingPublicKey: signingKey }
      },
      {
        ...transcript,
        approver: { ...transcript.approver, encryptionPublicKey: encryptionKey }
      },
      {
        ...transcript,
        joiner: { ...transcript.joiner, signingPublicKey: signingKey }
      },
      {
        ...transcript,
        joiner: { ...transcript.joiner, encryptionPublicKey: encryptionKey }
      },
      {
        ...transcript,
        joiner: { ...transcript.joiner, encryptionPublicKey: weakX }
      },
      { ...transcript, challengePublicKey: encryptionKey }
    ])
      expect(verifyPairingProof(altered, proof, privateKey, 1)).toBe(false);
  });

  it("rejects malformed and noncanonical values without throwing", () => {
    const { transcript, proof, privateKey } = fixture();
    expect(
      verifyPairingProof(
        { ...transcript, inviteHash: "!" },
        proof,
        privateKey,
        1
      )
    ).toBe(false);
    expect(
      verifyPairingProof(
        transcript,
        { ...proof, mac: proof.mac + "=" },
        privateKey,
        1
      )
    ).toBe(false);
    expect(verifyPairingProof(transcript, proof, privateKey, NaN)).toBe(false);
    expect(
      verifyPairingProof(
        {
          ...transcript,
          joiner: {
            ...transcript.joiner,
            encryptionPublicKey: publicKey(
              createPublicKey(
                createPrivateKey({
                  key: Buffer.from(privateKey, "base64"),
                  format: "der",
                  type: "pkcs8"
                })
              )
            )
          }
        },
        proof,
        privateKey,
        1
      )
    ).toBe(false);
  });
});
