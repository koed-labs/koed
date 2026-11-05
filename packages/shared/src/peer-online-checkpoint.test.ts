import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalizePdsJson } from "./personal-device-sync-jcs.js";
import { derivePeerSessionKey } from "./peer-online-deletion.js";
import {
  signPeerOnlineCheckpoint,
  verifyPeerOnlineCheckpoint
} from "./peer-online-checkpoint.js";

const producer = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
const payload = Buffer.from("encrypted bytes");
const hash = Buffer.alloc(32, 7).toString("base64url");
const input = {
  groupId: "group-1",
  originDeviceId: "device-1",
  originSessionId: hash,
  membershipHeadHash: hash,
  sequence: "1",
  predecessorHash: hash,
  bindingHash: hash
};
const expected = {
  groupId: input.groupId,
  originDeviceId: input.originDeviceId,
  originSessionId: input.originSessionId,
  bindingHash: input.bindingHash
};
const check = (
  json: string,
  bytes: Uint8Array,
  groupId: string,
  key: typeof producer.publicKey
) => verifyPeerOnlineCheckpoint(json, bytes, { ...expected, groupId }, key);

function signed() {
  return signPeerOnlineCheckpoint(input, payload, producer.privateKey).envelope;
}

describe("peer-online checkpoint envelope", () => {
  it("verifies producer signature and encrypted payload", () => {
    expect(
      check(signed(), payload, "group-1", producer.publicKey)
    ).toMatchObject({ status: "accepted" });
    expect(
      check(
        signed(),
        Buffer.from("Encrypted bytes"),
        "group-1",
        producer.publicKey
      )
    ).toBeUndefined();
    expect(
      check(signed(), payload, "wrong", producer.publicKey)
    ).toBeUndefined();
    expect(
      check(signed(), payload, "group-1", other.publicKey)
    ).toBeUndefined();
  });

  it("returns the exact signed payload snapshot independent of the input", () => {
    const bytes = Buffer.from(payload);
    const result = signPeerOnlineCheckpoint(input, bytes, producer.privateKey);
    bytes.fill(0);
    expect(result.payload).toEqual(payload);
    expect(
      verifyPeerOnlineCheckpoint(
        result.envelope,
        result.payload,
        expected,
        producer.publicKey
      )?.payload
    ).toEqual(payload);
    expect(
      verifyPeerOnlineCheckpoint(
        result.envelope,
        bytes,
        expected,
        producer.publicKey
      )
    ).toBeUndefined();
  });

  it("returns verified independent payload and signed identity", () => {
    const bytes = Buffer.from(payload);
    const result = verifyPeerOnlineCheckpoint(
      signed(),
      bytes,
      expected,
      producer.publicKey
    );
    expect(result?.status).toBe("accepted");
    expect(result?.unsigned.sessionKey).toBe(
      derivePeerSessionKey({
        groupId: input.groupId,
        originDeviceId: input.originDeviceId,
        originSessionId: input.originSessionId
      })
    );
    expect(result?.unsigned.bindingHash).toBe(hash);
    bytes.fill(0);
    expect(result?.payload).toEqual(payload);
  });

  it("rejects validly signed substituted identities and binding", () => {
    for (const change of [
      { originDeviceId: "other" },
      { originSessionId: Buffer.alloc(32, 9).toString("base64url") },
      { bindingHash: Buffer.alloc(32, 9).toString("base64url") }
    ]) {
      const { envelope: json } = signPeerOnlineCheckpoint(
        { ...input, ...change },
        payload,
        producer.privateKey
      );
      expect(
        verifyPeerOnlineCheckpoint(json, payload, expected, producer.publicKey)
      ).toBeUndefined();
    }
  });

  it("binds the same record hash used by deletion and checks the derived session key", () => {
    const sessionKey = derivePeerSessionKey({
      groupId: input.groupId,
      originDeviceId: input.originDeviceId,
      originSessionId: input.originSessionId
    });
    const unsigned = {
      protocol: "koed/peer-online-session-binding/v1",
      groupId: input.groupId,
      originDeviceId: input.originDeviceId,
      originSessionId: input.originSessionId,
      sessionKey,
      sourceIdentityCommitment: hash
    };
    const signature = sign(
      null,
      Buffer.from(
        `koed/peer-online-session-binding/v1\n${canonicalizePdsJson(unsigned)}`
      ),
      producer.privateKey
    ).toString("base64url");
    const bindingJson = canonicalizePdsJson({ unsigned, signature });
    const bindingHash = createHash("sha256")
      .update(`koed/peer-online-session-binding/v1/record\n${bindingJson}`)
      .digest("base64url");
    const { envelope: json } = signPeerOnlineCheckpoint(
      { ...input, bindingHash },
      payload,
      producer.privateKey
    );
    expect(
      verifyPeerOnlineCheckpoint(
        json,
        payload,
        { ...expected, bindingHash },
        producer.publicKey
      )?.unsigned.sessionKey
    ).toBe(sessionKey);
    const record = parseRecord(json);
    record.unsigned.sessionKey = hash;
    record.signature = sign(
      null,
      Buffer.from(
        `koed/peer-online-checkpoint/v1\n${canonicalizePdsJson(record.unsigned)}`
      ),
      producer.privateKey
    ).toString("base64url");
    expect(
      verifyPeerOnlineCheckpoint(
        canonicalizePdsJson(record),
        payload,
        { ...expected, bindingHash },
        producer.publicKey
      )
    ).toBeUndefined();
  });

  it("enforces payload limit and key types on both boundaries", () => {
    const large = Buffer.alloc(8 * 1024 * 1024);
    const { envelope: json } = signPeerOnlineCheckpoint(
      input,
      large,
      producer.privateKey
    );
    expect(
      verifyPeerOnlineCheckpoint(json, large, expected, producer.publicKey)
        ?.payload.length
    ).toBe(large.length);
    expect(
      verifyPeerOnlineCheckpoint(
        json,
        Buffer.alloc(large.length + 1),
        expected,
        producer.publicKey
      )
    ).toBeUndefined();
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(
      verifyPeerOnlineCheckpoint(signed(), payload, expected, rsa.publicKey)
    ).toBeUndefined();
    expect(() =>
      signPeerOnlineCheckpoint(input, payload, rsa.privateKey)
    ).toThrow();
  });

  it("signs the documented domain and canonical unsigned bytes", () => {
    const record = parseRecord(signed());
    const bytes = Buffer.from(
      `koed/peer-online-checkpoint/v1\n${canonicalizePdsJson(record.unsigned)}`
    );
    expect(
      verify(
        null,
        bytes,
        producer.publicKey,
        Buffer.from(record.signature, "base64url")
      )
    ).toBe(true);
    expect(
      verify(
        null,
        Buffer.from(canonicalizePdsJson(record.unsigned)),
        producer.publicKey,
        Buffer.from(record.signature, "base64url")
      )
    ).toBe(false);
  });

  it("rejects tampering with every signed field and original signature", () => {
    const original = parseRecord(signed());
    for (const [field, value] of Object.entries({
      protocol: "other",
      groupId: "other",
      originDeviceId: "other",
      originSessionId: Buffer.alloc(32, 8).toString("base64url"),
      membershipHeadHash: Buffer.alloc(32, 8).toString("base64url"),
      bindingHash: Buffer.alloc(32, 8).toString("base64url"),
      sessionKey: Buffer.alloc(32, 8).toString("base64url"),
      sequence: "2",
      predecessorHash: null,
      payloadHash: Buffer.alloc(32, 8).toString("base64url"),
      payloadBytes: "1"
    })) {
      const changed = structuredClone(original);
      changed.unsigned[field] = value;
      expect(
        check(
          canonicalizePdsJson(changed),
          payload,
          "group-1",
          producer.publicKey
        ),
        field
      ).toBeUndefined();
    }
    original.signature = Buffer.alloc(64).toString("base64url");
    expect(
      check(
        canonicalizePdsJson(original),
        payload,
        "group-1",
        producer.publicKey
      )
    ).toBeUndefined();
  });

  it("rejects noncanonical and malformed records", () => {
    const json = signed();
    const record = parseRecord(json);
    for (const bad of [
      ` ${json}`,
      json.replace("{", '{"signature":"x",'),
      canonicalizePdsJson({ ...record, extra: true }),
      canonicalizePdsJson({ ...record, signature: record.signature + "=" }),
      "{}",
      "x".repeat(20000)
    ]) {
      expect(
        check(bad, payload, "group-1", producer.publicKey)
      ).toBeUndefined();
    }
  });

  it("rejects malformed metadata and oversized payloads when signing", () => {
    for (const changed of [
      { sequence: "01" },
      { sequence: "18446744073709551616" },
      { groupId: "" },
      { originSessionId: "bad" },
      { predecessorHash: "bad" }
    ]) {
      expect(() =>
        signPeerOnlineCheckpoint(
          { ...input, ...changed },
          payload,
          producer.privateKey
        )
      ).toThrow();
    }
    expect(() =>
      signPeerOnlineCheckpoint(
        input,
        Buffer.alloc(8 * 1024 * 1024 + 1),
        producer.privateKey
      )
    ).toThrow();
  });
});

type MutableRecord = { unsigned: Record<string, unknown>; signature: string };

function parseRecord(json: string): MutableRecord {
  return JSON.parse(json) as MutableRecord;
}
