import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertPeerOnlineIdentityBinding } from "./peer-online-identity-binding.js";

const keys = () => {
  const signing = generateKeyPairSync("ed25519").publicKey;
  const encryption = generateKeyPairSync("x25519").publicKey;
  const transport = generateKeyPairSync("ed25519").publicKey;
  const spki = (key: typeof signing) =>
    key.export({ format: "der", type: "spki" });
  const digest = (key: typeof signing) =>
    createHash("sha256").update(spki(key)).digest("base64url");
  return {
    identity: {
      deviceId: "device-a",
      signingPublicKey: spki(signing).toString("base64"),
      encryptionPublicKey: spki(encryption).toString("base64")
    },
    member: {
      deviceId: "device-a",
      signingPublicKey: signing.export({ format: "jwk" }).x!,
      encryptionSpkiSha256: digest(encryption),
      transportSpkiSha256: digest(transport)
    },
    transportSpki: spki(transport)
  };
};

describe("peer-online identity binding", () => {
  it("accepts the enrolled signing, encryption and transport keys", () => {
    const value = keys();
    expect(() =>
      assertPeerOnlineIdentityBinding(
        value.identity,
        value.member,
        value.transportSpki
      )
    ).not.toThrow();
  });
  it("accepts a bound RSA-2048 TLS credential", () => {
    const value = keys();
    const transportSpki = generateKeyPairSync("rsa", {
      modulusLength: 2048
    }).publicKey.export({ format: "der", type: "spki" });
    const member = {
      ...value.member,
      transportSpkiSha256: createHash("sha256")
        .update(transportSpki)
        .digest("base64url")
    };
    expect(() =>
      assertPeerOnlineIdentityBinding(value.identity, member, transportSpki)
    ).not.toThrow();
  });
  it("rejects substituted identity, encryption and transport keys", () => {
    const value = keys();
    const other = keys();
    expect(() =>
      assertPeerOnlineIdentityBinding(
        { ...value.identity, deviceId: "other" },
        value.member,
        value.transportSpki
      )
    ).toThrow();
    expect(() =>
      assertPeerOnlineIdentityBinding(
        {
          ...value.identity,
          signingPublicKey: other.identity.signingPublicKey
        },
        value.member,
        value.transportSpki
      )
    ).toThrow();
    expect(() =>
      assertPeerOnlineIdentityBinding(
        {
          ...value.identity,
          encryptionPublicKey: other.identity.encryptionPublicKey
        },
        value.member,
        value.transportSpki
      )
    ).toThrow();
    expect(() =>
      assertPeerOnlineIdentityBinding(
        value.identity,
        value.member,
        other.transportSpki
      )
    ).toThrow();
  });
  it("rejects low-order encryption keys and unsuitable transport keys", () => {
    const value = keys();
    const lowOrder = createPublicKey({
      key: {
        kty: "OKP",
        crv: "X25519",
        x: Buffer.alloc(32).toString("base64url")
      },
      format: "jwk"
    }).export({ format: "der", type: "spki" });
    const weakMember = {
      ...value.member,
      encryptionSpkiSha256: createHash("sha256")
        .update(lowOrder)
        .digest("base64url")
    };
    expect(() =>
      assertPeerOnlineIdentityBinding(
        { ...value.identity, encryptionPublicKey: lowOrder.toString("base64") },
        weakMember,
        value.transportSpki
      )
    ).toThrow();
    const wrongTransport = generateKeyPairSync("x25519").publicKey.export({
      format: "der",
      type: "spki"
    });
    expect(() =>
      assertPeerOnlineIdentityBinding(
        value.identity,
        {
          ...value.member,
          transportSpkiSha256: createHash("sha256")
            .update(wrongTransport)
            .digest("base64url")
        },
        wrongTransport
      )
    ).toThrow();
  });
  it("rejects noncanonical and wrong-algorithm key encodings", () => {
    const value = keys();
    expect(() =>
      assertPeerOnlineIdentityBinding(
        {
          ...value.identity,
          signingPublicKey: `${value.identity.signingPublicKey}\n`
        },
        value.member,
        value.transportSpki
      )
    ).toThrow();
    expect(() =>
      assertPeerOnlineIdentityBinding(
        {
          ...value.identity,
          encryptionPublicKey: value.identity.signingPublicKey
        },
        value.member,
        value.transportSpki
      )
    ).toThrow();
    expect(() =>
      assertPeerOnlineIdentityBinding(
        value.identity,
        value.member,
        Buffer.from("invalid")
      )
    ).toThrow();
    expect(() =>
      assertPeerOnlineIdentityBinding(
        { ...value.identity, signingPublicKey: "A".repeat(100_000) },
        value.member,
        value.transportSpki
      )
    ).toThrow();
    expect(() =>
      assertPeerOnlineIdentityBinding(
        value.identity,
        value.member,
        Buffer.alloc(100_000)
      )
    ).toThrow();
  });
});
