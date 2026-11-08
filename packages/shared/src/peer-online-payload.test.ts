import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign
} from "node:crypto";
import {
  initializePeerMembership,
  applyPeerMembership,
  PEER_MEMBERSHIP_PROTOCOL
} from "./peer-online-membership.js";
import { derivePeerSessionKey } from "./peer-online-deletion.js";
import { signPeerOnlineCheckpoint } from "./peer-online-checkpoint.js";
import { describe, expect, it } from "vitest";
import {
  encryptPeerOnlinePayload,
  decryptPeerOnlinePayload
} from "./peer-online-payload.js";
import { canonicalizePdsJson } from "./personal-device-sync-jcs.js";

const signer = generateKeyPairSync("ed25519");
const attacker = generateKeyPairSync("ed25519");
const a = generateKeyPairSync("x25519");
const b = generateKeyPairSync("x25519");
const hash = Buffer.alloc(32, 4).toString("base64url");
const fingerprint = (key: typeof a.publicKey) =>
  createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("base64url");
const members = [
  { deviceId: "a", encryptionSpkiSha256: fingerprint(a.publicKey) },
  { deviceId: "b", encryptionSpkiSha256: fingerprint(b.publicKey) }
];
const recipients = [
  { deviceId: "a", publicKey: a.publicKey },
  { deviceId: "b", publicKey: b.publicKey }
];
const protocol = PEER_MEMBERSHIP_PROTOCOL;
const fullMember = (
  deviceId: string,
  key: typeof signer.publicKey,
  encryptionKey: typeof a.publicKey
) => ({
  deviceId,
  signingPublicKey: key.export({ format: "jwk" }).x!,
  encryptionSpki: encryptionKey
    .export({ type: "spki", format: "der" })
    .toString("base64url"),
  encryptionSpkiSha256: fingerprint(encryptionKey),
  transportSpkiSha256: fingerprint(generateKeyPairSync("ed25519").publicKey)
});
const decision = (parentHash: string | null, body: object) => {
  const unsigned = {
    protocol,
    groupId: "group",
    parentHash,
    authorDeviceId: "a",
    body
  };
  const json = canonicalizePdsJson(unsigned);
  return {
    hash: createHash("sha256")
      .update(`${protocol}/record\n${json}`)
      .digest("base64url"),
    json: canonicalizePdsJson({
      unsigned,
      signature: sign(
        null,
        Buffer.from(`${protocol}/decision\n${json}`),
        signer.privateKey
      ).toString("base64url")
    })
  };
};
const genesis = decision(null, {
  kind: "genesis",
  initialMember: fullMember("a", signer.publicKey, a.publicKey)
});
const initial = initializePeerMembership(
  { groupId: "group", genesisHash: genesis.hash },
  genesis.json
);
if (initial.status !== "accepted") throw new Error("invalid fixture genesis");
const addition = decision(genesis.hash, {
  kind: "add",
  target: fullMember("b", attacker.publicKey, b.publicKey)
});
const added = applyPeerMembership(initial.state, addition.json);
if (added.status !== "accepted") throw new Error("invalid fixture addition");
const membership = added.state;
const authority = { groupId: "group", head: addition.hash, members };
const identity = {
  groupId: "group",
  originDeviceId: "a",
  originSessionId: hash
};
const bindingUnsigned = {
  protocol: "koed/peer-online-session-binding/v1",
  ...identity,
  sessionKey: derivePeerSessionKey(identity),
  sourceIdentityCommitment: hash
};
const bindingJson = canonicalizePdsJson({
  unsigned: bindingUnsigned,
  signature: sign(
    null,
    Buffer.from(
      `koed/peer-online-session-binding/v1\n${canonicalizePdsJson(bindingUnsigned)}`
    ),
    signer.privateKey
  ).toString("base64url")
});
const bindingHash = createHash("sha256")
  .update(`koed/peer-online-session-binding/v1/record\n${bindingJson}`)
  .digest("base64url");
const context = {
  ...identity,
  membershipHeadHash: addition.hash,
  bindingHash,
  sequence: "1",
  predecessorHash: hash
};
const encrypt = () =>
  encryptPeerOnlinePayload(
    context,
    Buffer.from("secret checkpoint"),
    authority,
    recipients
  );
const decrypt = (
  payload: Uint8Array,
  expected = context,
  deviceId = "a",
  privateKey = a.privateKey
) =>
  decryptPeerOnlinePayload(
    signPeerOnlineCheckpoint(
      expected,
      payload.byteLength > 8 * 1024 * 1024 ? Buffer.alloc(0) : payload,
      signer.privateKey
    ).envelope,
    payload,
    expected,
    authority,
    deviceId,
    privateKey,
    bindingJson,
    membership
  );

describe("peer-online payload encryption", () => {
  it("rejects checkpoints signed by a revoked origin at the current membership head", () => {
    const unsigned = {
      protocol,
      groupId: "group",
      parentHash: addition.hash,
      authorDeviceId: "b",
      body: { kind: "revoke", targetDeviceId: "a" }
    };
    const canonical = canonicalizePdsJson(unsigned);
    const revocationHash = createHash("sha256")
      .update(`${protocol}/record\n${canonical}`)
      .digest("base64url");
    const revocation = canonicalizePdsJson({
      unsigned,
      signature: sign(
        null,
        Buffer.from(`${protocol}/decision\n${canonical}`),
        attacker.privateKey
      ).toString("base64url")
    });
    const updated = applyPeerMembership(membership, revocation);
    expect(updated.status).toBe("accepted");
    if (updated.status !== "accepted") throw new Error("invalid revocation");
    const current = { ...context, membershipHeadHash: revocationHash };
    const currentAuthority = {
      groupId: "group",
      head: revocationHash,
      members: [members[1]!]
    };
    const payload = encryptPeerOnlinePayload(
      current,
      Buffer.from("revoked author"),
      currentAuthority,
      [recipients[1]!]
    );
    const envelope = signPeerOnlineCheckpoint(
      current,
      payload,
      signer.privateKey
    ).envelope;
    expect(
      decryptPeerOnlinePayload(
        envelope,
        payload,
        current,
        currentAuthority,
        "b",
        b.privateKey,
        bindingJson,
        updated.state
      )
    ).toBeUndefined();
  });
  it("encrypts for every active recipient and does not reveal plaintext", () => {
    const payload = encrypt();
    expect(payload.includes(Buffer.from("secret checkpoint"))).toBe(false);
    expect(decrypt(payload)).toEqual(Buffer.from("secret checkpoint"));
    expect(decrypt(payload, context, "b", b.privateKey)).toEqual(
      Buffer.from("secret checkpoint")
    );
    expect(encrypt()).not.toEqual(payload);
  });
  it("rejects wrong keys, identities and substituted checkpoint contexts", () => {
    const payload = encrypt();
    expect(decrypt(payload, context, "a", b.privateKey)).toBeUndefined();
    expect(decrypt(payload, context, "missing")).toBeUndefined();
    for (const expected of [
      { ...context, groupId: "other" },
      { ...context, bindingHash: Buffer.alloc(32, 5).toString("base64url") },
      {
        ...context,
        membershipHeadHash: Buffer.alloc(32, 5).toString("base64url")
      },
      { ...context, sequence: "2" },
      { ...context, originSessionId: Buffer.alloc(32, 5).toString("base64url") }
    ])
      expect(decrypt(payload, expected)).toBeUndefined();
  });
  it("rejects tampering, malformed and noncanonical payloads", () => {
    const payload = encrypt();
    const object = parsePayload(payload.toString());
    for (const field of ["ciphertext", "tag", "nonce"]) {
      const copy = structuredClone(object);
      const bytes = Buffer.from(String(copy[field]), "base64url");
      expect(bytes.length).toBeGreaterThan(0);
      bytes[0] = bytes[0]! ^ 1;
      copy[field] = bytes.toString("base64url");
      expect(decrypt(Buffer.from(canonicalizePdsJson(copy)))).toBeUndefined();
    }
    const wrapped = structuredClone(object);
    const wrapBytes = Buffer.from(
      wrapped.recipients[1]!.ciphertext,
      "base64url"
    );
    expect(wrapBytes.length).toBeGreaterThan(0);
    wrapBytes[0] = wrapBytes[0]! ^ 1;
    wrapped.recipients[1]!.ciphertext = wrapBytes.toString("base64url");
    expect(decrypt(Buffer.from(canonicalizePdsJson(wrapped)))).toBeUndefined();
    object.recipients[0]!.deviceId = "other";
    expect(decrypt(Buffer.from(canonicalizePdsJson(object)))).toBeUndefined();
    expect(decrypt(Buffer.from("{}"))).toBeUndefined();
    expect(
      decrypt(
        Buffer.from(JSON.stringify(JSON.parse(payload.toString()), null, 2))
      )
    ).toBeUndefined();
    expect(decrypt(Buffer.alloc(8 * 1024 * 1024 + 1))).toBeUndefined();
  });
  it("rejects a checkpoint and binding signed by another member for a swapped origin", () => {
    const unsigned = {
      ...bindingUnsigned,
      originDeviceId: "b",
      sessionKey: derivePeerSessionKey({ ...identity, originDeviceId: "b" })
    };
    const forgedBinding = canonicalizePdsJson({
      unsigned,
      signature: sign(
        null,
        Buffer.from(
          `koed/peer-online-session-binding/v1\n${canonicalizePdsJson(unsigned)}`
        ),
        signer.privateKey
      ).toString("base64url")
    });
    const forgedContext = {
      ...context,
      originDeviceId: "b",
      bindingHash: createHash("sha256")
        .update(`koed/peer-online-session-binding/v1/record\n${forgedBinding}`)
        .digest("base64url")
    };
    const payload = encryptPeerOnlinePayload(
      forgedContext,
      Buffer.from("forged"),
      authority,
      recipients
    );
    const envelope = signPeerOnlineCheckpoint(
      forgedContext,
      payload,
      signer.privateKey
    ).envelope;
    expect(
      decryptPeerOnlinePayload(
        envelope,
        payload,
        forgedContext,
        authority,
        "a",
        a.privateKey,
        forgedBinding,
        membership
      )
    ).toBeUndefined();
  });
  it("rejects forged identity-point origin membership and fake state", () => {
    const weak = Buffer.alloc(32);
    weak[0] = 1;
    const sig = Buffer.alloc(64);
    sig[0] = 1;
    const unsigned = {
      protocol,
      groupId: "group",
      parentHash: null,
      authorDeviceId: "a",
      body: {
        kind: "genesis",
        initialMember: {
          ...fullMember("a", signer.publicKey, a.publicKey),
          signingPublicKey: weak.toString("base64url")
        }
      }
    };
    const json = canonicalizePdsJson(unsigned);
    const genesisHash = createHash("sha256")
      .update(`${protocol}/record\n${json}`)
      .digest("base64url");
    expect(
      initializePeerMembership(
        { groupId: "group", genesisHash },
        canonicalizePdsJson({ unsigned, signature: sig.toString("base64url") })
      ).status
    ).toBe("invalid");
    const payload = encrypt();
    const envelope = signPeerOnlineCheckpoint(
      context,
      payload,
      signer.privateKey
    ).envelope;
    expect(
      decryptPeerOnlinePayload(
        envelope,
        payload,
        context,
        authority,
        "a",
        a.privateKey,
        bindingJson,
        {} as typeof membership
      )
    ).toBeUndefined();
  });
  it("requires an authentic checkpoint signature and exact signed payload", () => {
    const payload = encrypt();
    const envelope = signPeerOnlineCheckpoint(
      context,
      payload,
      signer.privateKey
    ).envelope;
    const forged = encrypt();
    expect(
      decryptPeerOnlinePayload(
        envelope,
        forged,
        context,
        authority,
        "a",
        a.privateKey,
        bindingJson,
        membership
      )
    ).toBeUndefined();
    const fakeEnvelope = signPeerOnlineCheckpoint(
      context,
      forged,
      attacker.privateKey
    ).envelope;
    expect(
      decryptPeerOnlinePayload(
        fakeEnvelope,
        forged,
        context,
        authority,
        "a",
        a.privateKey,
        bindingJson,
        membership
      )
    ).toBeUndefined();
    const stale = { ...context, sequence: "2" };
    expect(
      decryptPeerOnlinePayload(
        envelope,
        payload,
        stale,
        authority,
        "a",
        a.privateKey,
        bindingJson,
        membership
      )
    ).toBeUndefined();
  });
  it("rejects shared memory, weak X25519 keys and signed deeply nested JSON", () => {
    expect(() =>
      encryptPeerOnlinePayload(
        context,
        new Uint8Array(new SharedArrayBuffer(10)),
        authority,
        recipients
      )
    ).toThrow();
    const payload = encrypt();
    const shared = new Uint8Array(new SharedArrayBuffer(payload.length));
    shared.set(payload);
    const envelope = signPeerOnlineCheckpoint(
      context,
      payload,
      signer.privateKey
    ).envelope;
    expect(
      decryptPeerOnlinePayload(
        envelope,
        shared,
        context,
        authority,
        "a",
        a.privateKey,
        bindingJson,
        membership
      )
    ).toBeUndefined();
    const weak = createPublicKey({
      key: {
        kty: "OKP",
        crv: "X25519",
        x: Buffer.alloc(32).toString("base64url")
      },
      format: "jwk"
    });
    expect(() =>
      encryptPeerOnlinePayload(
        context,
        Buffer.alloc(0),
        {
          ...authority,
          members: [{ deviceId: "a", encryptionSpkiSha256: fingerprint(weak) }]
        },
        [{ deviceId: "a", publicKey: weak }]
      )
    ).toThrow();
    const value = parsePayload(payload.toString());
    value.ephemeralKey = Buffer.alloc(32).toString("base64url");
    expect(decrypt(Buffer.from(canonicalizePdsJson(value)))).toBeUndefined();
    expect(
      decrypt(Buffer.from("[".repeat(10000) + "0" + "]".repeat(10000)))
    ).toBeUndefined();
    expect(
      decrypt(Buffer.from("[" + "0,".repeat(20000) + "0]"))
    ).toBeUndefined();
  });
  it("fails closed on missing, revoked, duplicate or mismatched recipient keys", () => {
    expect(() =>
      encryptPeerOnlinePayload(
        context,
        Buffer.alloc(0),
        authority,
        recipients.slice(0, 1)
      )
    ).toThrow();
    expect(() =>
      encryptPeerOnlinePayload(context, Buffer.alloc(0), authority, [
        recipients[0]!,
        recipients[0]!
      ])
    ).toThrow();
    expect(() =>
      encryptPeerOnlinePayload(context, Buffer.alloc(0), authority, [
        { deviceId: "a", publicKey: b.publicKey },
        recipients[1]!
      ])
    ).toThrow();
    const payload = encrypt();
    expect(
      decryptPeerOnlinePayload(
        signPeerOnlineCheckpoint(context, payload, signer.privateKey).envelope,
        payload,
        context,
        { ...authority, members: [members[1]!] },
        "a",
        a.privateKey,
        bindingJson,
        membership
      )
    ).toBeUndefined();
    expect(() =>
      encryptPeerOnlinePayload(
        context,
        Buffer.alloc(8 * 1024 * 1024),
        authority,
        recipients
      )
    ).toThrow();
    expect(() =>
      encryptPeerOnlinePayload(
        { ...context, sequence: "01" },
        Buffer.alloc(0),
        authority,
        recipients
      )
    ).toThrow();
  });
});

type MutablePayload = {
  [field: string]: unknown;
  ephemeralKey: string;
  recipients: { deviceId: string; ciphertext: string }[];
};

function parsePayload(json: string): MutablePayload {
  return JSON.parse(json) as MutablePayload;
}
