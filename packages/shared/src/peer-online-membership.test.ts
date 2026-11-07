import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign
} from "node:crypto";
import type { KeyObject } from "node:crypto";
const requirePublicSpki = (key: KeyObject) =>
  createPublicKey(key).export({ type: "spki", format: "der" });
import { describe, expect, it } from "vitest";
import { canonicalizePdsJson } from "./personal-device-sync-jcs.js";
import {
  initializePeerMembership,
  applyPeerMembership,
  inspectPeerMembership,
  lookupHistoricalPeerMember
} from "./peer-online-membership.js";

const protocol = "koed/peer-online-membership/v2";
function device(deviceId: string) {
  const keys = generateKeyPairSync("ed25519");
  const encryptionKeys = generateKeyPairSync("x25519");
  const publicKey = keys.publicKey.export({ format: "jwk" }).x!;
  const encryptionSpki = encryptionKeys.publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64url");
  const fingerprint = (key: KeyObject) =>
    createHash("sha256")
      .update(key.export({ type: "spki", format: "der" }))
      .digest("base64url");
  return {
    deviceId,
    signingPublicKey: publicKey,
    encryptionSpki,
    encryptionSpkiSha256: fingerprint(encryptionKeys.publicKey),
    transportSpkiSha256: fingerprint(generateKeyPairSync("ed25519").publicKey),
    privateKey: keys.privateKey
  };
}
function record(
  author: ReturnType<typeof device>,
  parentHash: string | null,
  body: object,
  groupId = "group"
) {
  const unsigned = {
    protocol,
    groupId,
    parentHash,
    authorDeviceId: author.deviceId,
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
        author.privateKey
      ).toString("base64url")
    })
  };
}
function member(d: ReturnType<typeof device>) {
  return {
    deviceId: d.deviceId,
    signingPublicKey: d.signingPublicKey,
    encryptionSpki: d.encryptionSpki,
    encryptionSpkiSha256: d.encryptionSpkiSha256,
    transportSpkiSha256: d.transportSpkiSha256
  };
}
function setup() {
  const a = device("a");
  const b = device("b");
  const c = device("c");
  const genesis = record(a, null, {
    kind: "genesis",
    initialMember: member(a)
  });
  const init = initializePeerMembership(
    { groupId: "group", genesisHash: genesis.hash },
    genesis.json
  );
  if (init.status !== "accepted") throw new Error(init.reason);
  return { a, b, c, genesis, state: init.state };
}

describe("peer-online membership", () => {
  it("commits full canonical X25519 SPKI in genesis, admissions, and snapshots", () => {
    const { a, b, c, genesis, state } = setup();
    expect(parseRecord(genesis.json).unsigned.protocol).toBe(protocol);
    expect(inspectPeerMembership(state).members).toEqual([member(a)]);
    const add = record(a, genesis.hash, { kind: "add", target: member(b) });
    const result = applyPeerMembership(state, add.json);
    expect(result.status).toBe("accepted");
    expect(inspectPeerMembership(result.state).members).toEqual([
      member(a),
      member(b)
    ]);
    expect(lookupHistoricalPeerMember(result.state, "b")).toEqual({
      status: "found",
      member: member(b)
    });
    expect(
      parseRecord(inspectPeerMembership(result.state).records[1]!.json).unsigned
        .body.target.encryptionSpki
    ).toBe(b.encryptionSpki);
    const replayedGenesis = initializePeerMembership(
      { groupId: "group", genesisHash: genesis.hash },
      genesis.json
    );
    expect(replayedGenesis.status).toBe("accepted");
    if (replayedGenesis.status !== "accepted") return;
    const replayedAdmission = applyPeerMembership(
      replayedGenesis.state,
      inspectPeerMembership(result.state).records[1]!.json
    );
    expect(replayedAdmission.status).toBe("accepted");
    expect(inspectPeerMembership(replayedAdmission.state).members).toEqual([
      member(a),
      member(b)
    ]);
    const substituted = parseRecord(add.json);
    substituted.unsigned.body.target.encryptionSpki = c.encryptionSpki;
    substituted.unsigned.body.target.encryptionSpkiSha256 =
      c.encryptionSpkiSha256;
    expect(
      applyPeerMembership(state, canonicalizePdsJson(substituted)).status
    ).toBe("invalid");
  });
  it("rejects malformed, non-X25519, noncanonical, and mismatched encryption SPKI", () => {
    const { a, b, genesis, state } = setup();
    const der = Buffer.from(b.encryptionSpki, "base64url");
    const otherAlgorithm = generateKeyPairSync("ed25519")
      .publicKey.export({ type: "spki", format: "der" })
      .toString("base64url");
    const noncanonicalDerBytes = Buffer.concat([
      der.subarray(0, 1),
      Buffer.from([0x81, der[1]!]),
      der.subarray(2)
    ]);
    expect(
      createPublicKey({
        key: noncanonicalDerBytes,
        type: "spki",
        format: "der"
      }).export({ type: "spki", format: "der" })
    ).not.toEqual(noncanonicalDerBytes);
    const noncanonicalDer = noncanonicalDerBytes.toString("base64url");
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const lastCharacter = b.encryptionSpki.at(-1)!;
    const lastIndex = alphabet.indexOf(lastCharacter);
    const invalidTrailingBits =
      b.encryptionSpki.slice(0, -1) + alphabet[lastIndex ^ 1];
    const changedDigest = createHash("sha256")
      .update("different key")
      .digest("base64url");
    for (const target of [
      { ...member(b), encryptionSpki: "not base64url!" },
      { ...member(b), encryptionSpki: otherAlgorithm },
      { ...member(b), encryptionSpki: `${b.encryptionSpki}="` },
      { ...member(b), encryptionSpki: invalidTrailingBits },
      {
        ...member(b),
        encryptionSpki: der.subarray(0, -1).toString("base64url")
      },
      { ...member(b), encryptionSpki: noncanonicalDer },
      { ...member(b), encryptionSpkiSha256: changedDigest }
    ]) {
      expect(
        applyPeerMembership(
          state,
          record(a, genesis.hash, { kind: "add", target }).json
        ).status
      ).toBe("invalid");
    }
  });
  it("rejects v1 records and v2 membership without a full encryption key", () => {
    const { a, b, genesis, state } = setup();
    const v1Protocol = "koed/peer-online-membership/v1";
    const legacyMember = {
      deviceId: a.deviceId,
      signingPublicKey: a.signingPublicKey,
      encryptionSpkiSha256: a.encryptionSpkiSha256,
      transportSpkiSha256: a.transportSpkiSha256
    };
    const v1UnsignedRecords = [
      {
        protocol: v1Protocol,
        groupId: "group",
        parentHash: null,
        authorDeviceId: a.deviceId,
        body: { kind: "genesis", initialMember: legacyMember }
      },
      {
        protocol: v1Protocol,
        groupId: "group",
        parentHash: null,
        authorDeviceId: a.deviceId,
        body: { kind: "genesis", initialMember: member(a) }
      }
    ];
    for (const unsigned of v1UnsignedRecords) {
      const v1Json = canonicalizePdsJson({
        unsigned,
        signature: sign(
          null,
          Buffer.from(
            `${v1Protocol}/decision\n${canonicalizePdsJson(unsigned)}`
          ),
          a.privateKey
        ).toString("base64url")
      });
      const v1Hash = createHash("sha256")
        .update(`${v1Protocol}/record\n${canonicalizePdsJson(unsigned)}`)
        .digest("base64url");
      expect(
        initializePeerMembership(
          { groupId: "group", genesisHash: v1Hash },
          v1Json
        ).status
      ).toBe("invalid");
    }

    const v2Unsigned = {
      protocol,
      groupId: "group",
      parentHash: null,
      authorDeviceId: a.deviceId,
      body: { kind: "genesis", initialMember: legacyMember }
    };
    const v2Json = canonicalizePdsJson({
      unsigned: v2Unsigned,
      signature: sign(
        null,
        Buffer.from(`${protocol}/decision\n${canonicalizePdsJson(v2Unsigned)}`),
        a.privateKey
      ).toString("base64url")
    });
    const v2Hash = createHash("sha256")
      .update(`${protocol}/record\n${canonicalizePdsJson(v2Unsigned)}`)
      .digest("base64url");
    expect(
      initializePeerMembership(
        { groupId: "group", genesisHash: v2Hash },
        v2Json
      ).status
    ).toBe("invalid");

    const v1AddUnsigned = {
      protocol: v1Protocol,
      groupId: "group",
      parentHash: genesis.hash,
      authorDeviceId: a.deviceId,
      body: { kind: "add", target: member(b) }
    };
    const v1AddJson = canonicalizePdsJson({
      unsigned: v1AddUnsigned,
      signature: sign(
        null,
        Buffer.from(
          `${v1Protocol}/decision\n${canonicalizePdsJson(v1AddUnsigned)}`
        ),
        a.privateKey
      ).toString("base64url")
    });
    expect(applyPeerMembership(state, v1AddJson).status).toBe("invalid");
  });
  it("anchors genesis and applies signed changes idempotently", () => {
    const { a, b, genesis, state } = setup();
    const add = record(a, genesis.hash, { kind: "add", target: member(b) });
    const result = applyPeerMembership(state, add.json);
    expect(result.status).toBe("accepted");
    expect(
      inspectPeerMembership(result.state).members.map((m) => m.deviceId)
    ).toEqual(["a", "b"]);
    expect(inspectPeerMembership(state).members.map((m) => m.deviceId)).toEqual(
      ["a"]
    );
    expect(applyPeerMembership(result.state, add.json).status).toBe(
      "duplicate"
    );
    expect(
      initializePeerMembership(
        { groupId: "group", genesisHash: add.hash },
        genesis.json
      ).status
    ).toBe("invalid");
  });
  it("rejects forged siblings without pausing and pauses only on valid siblings", () => {
    const { a, b, c, genesis, state } = setup();
    const first = record(a, genesis.hash, { kind: "add", target: member(b) });
    const accepted = applyPeerMembership(state, first.json);
    const forgery = record(c, genesis.hash, { kind: "add", target: member(c) });
    const rejected = applyPeerMembership(accepted.state, forgery.json);
    expect(rejected.status).toBe("invalid");
    expect(inspectPeerMembership(rejected.state).conflict).toBe(false);
    const sibling = record(a, genesis.hash, { kind: "add", target: member(c) });
    const conflict = applyPeerMembership(rejected.state, sibling.json);
    expect(conflict.status).toBe("accepted");
    expect(inspectPeerMembership(conflict.state).conflict).toBe(true);
    expect(inspectPeerMembership(conflict.state).members).toEqual([]);
  });
  it("rejects revoked authors on their later parent, but retains earlier authorization", () => {
    const { a, b, c, genesis, state } = setup();
    const add = record(a, genesis.hash, { kind: "add", target: member(b) });
    const one = applyPeerMembership(state, add.json);
    const revoke = record(a, add.hash, { kind: "revoke", targetDeviceId: "b" });
    const two = applyPeerMembership(one.state, revoke.json);
    const after = record(b, revoke.hash, { kind: "add", target: member(c) });
    expect(applyPeerMembership(two.state, after.json).status).toBe("invalid");
    const before = record(b, add.hash, { kind: "add", target: member(c) });
    expect(
      inspectPeerMembership(applyPeerMembership(two.state, before.json).state)
        .conflict
    ).toBe(true);
  });
  it("bounds untrusted input without changing state and reports missing parent", () => {
    const { a, b, state } = setup();
    const large = applyPeerMembership(state, "x".repeat(20000));
    expect(large.status).toBe("limit");
    expect(large.state).toBe(state);
    expect(inspectPeerMembership(state).conflict).toBe(false);
    const unknown = record(a, Buffer.alloc(32, 9).toString("base64url"), {
      kind: "add",
      target: member(b)
    });
    expect(applyPeerMembership(state, unknown.json).status).toBe("pending");
  });
  it("rejects low-order Ed25519 identities even with a forged valid signature", () => {
    const { a, genesis, state } = setup();
    const identity = Buffer.concat([
      Buffer.from([1]),
      Buffer.alloc(31)
    ]).toString("base64url");
    const malicious = record(a, genesis.hash, {
      kind: "add",
      target: { ...member(device("evil")), signingPublicKey: identity }
    });
    expect(applyPeerMembership(state, malicious.json).status).toBe("invalid");
  });
  it("rejects torsion, mixed-order, noncanonical and off-curve signing points", () => {
    // JAM crypto torsion vectors and ed25519-speccheck mixed-order vector.
    const points = [
      "0100000000000000000000000000000000000000000000000000000000000000",
      "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
      "0000000000000000000000000000000000000000000000000000000000000000",
      "0000000000000000000000000000000000000000000000000000000000000080",
      "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
      "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
      "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
      "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
      "f7badec5b8abeaf699583992219b7b223f1df3fbbea919844e3f7c554a43dd43",
      "0100000000000000000000000000000000000000000000000000000000000080",
      "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
      "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
      "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      "0200000000000000000000000000000000000000000000000000000000000000"
    ];
    const { a, genesis, state } = setup();
    const candidate = member(device("candidate"));
    for (const point of points) {
      const target = {
        ...candidate,
        signingPublicKey: Buffer.from(point, "hex").toString("base64url")
      };
      expect(
        applyPeerMembership(
          state,
          record(a, genesis.hash, { kind: "add", target }).json
        ).status,
        point
      ).toBe("invalid");
    }
  });
  it("rejects a forged genesis signature with the identity public key", () => {
    const evil = device("evil");
    const fake = record(evil, null, {
      kind: "genesis",
      initialMember: {
        ...member(evil),
        signingPublicKey: Buffer.concat([
          Buffer.from([1]),
          Buffer.alloc(31)
        ]).toString("base64url")
      }
    });
    const parsed = parseRecord(fake.json);
    parsed.signature = Buffer.concat([
      Buffer.from([1]),
      Buffer.alloc(63)
    ]).toString("base64url");
    expect(
      initializePeerMembership(
        { groupId: "group", genesisHash: fake.hash },
        canonicalizePdsJson(parsed)
      ).status
    ).toBe("invalid");
  });
  it("binds encryption and transport fingerprints and rejects key reuse", () => {
    const { a, b, genesis, state } = setup();
    const target = member(b);
    const add = record(a, genesis.hash, { kind: "add", target });
    expect(applyPeerMembership(state, add.json).status).toBe("accepted");
    const parsed = parseRecord(add.json);
    parsed.unsigned.body.target.transportSpkiSha256 = a.transportSpkiSha256;
    expect(applyPeerMembership(state, canonicalizePdsJson(parsed)).status).toBe(
      "invalid"
    );
    for (const altered of [
      {
        ...target,
        encryptionSpki: a.encryptionSpki,
        encryptionSpkiSha256: a.encryptionSpkiSha256
      },
      { ...target, transportSpkiSha256: a.transportSpkiSha256 },
      { ...target, transportSpkiSha256: target.encryptionSpkiSha256 },
      {
        ...target,
        encryptionSpkiSha256: createHash("sha256")
          .update(
            a.privateKey.asymmetricKeyType === "ed25519"
              ? requirePublicSpki(a.privateKey)
              : Buffer.alloc(0)
          )
          .digest("base64url")
      },
      { ...target, unexpected: "x" }
    ]) {
      expect(
        applyPeerMembership(
          state,
          record(a, genesis.hash, { kind: "add", target: altered }).json
        ).status
      ).toBe("invalid");
    }
  });
  it("reserves all credential roles across revocation", () => {
    const { a, b, c, genesis, state } = setup();
    const added = record(a, genesis.hash, { kind: "add", target: member(b) });
    const one = applyPeerMembership(state, added.json);
    const revoked = record(a, added.hash, {
      kind: "revoke",
      targetDeviceId: "b"
    });
    const two = applyPeerMembership(one.state, revoked.json);
    const signing = createHash("sha256")
      .update(requirePublicSpki(b.privateKey))
      .digest("base64url");
    const target = member(c);
    for (const key of [
      signing,
      b.encryptionSpkiSha256,
      b.transportSpkiSha256
    ]) {
      expect(
        applyPeerMembership(
          two.state,
          record(a, revoked.hash, {
            kind: "add",
            target: { ...target, transportSpkiSha256: key }
          }).json
        ).status
      ).toBe("invalid");
    }
    expect(
      applyPeerMembership(
        two.state,
        record(a, revoked.hash, {
          kind: "add",
          target: {
            ...target,
            encryptionSpki: b.encryptionSpki,
            encryptionSpkiSha256: b.encryptionSpkiSha256
          }
        }).json
      ).status
    ).toBe("invalid");
    expect(
      applyPeerMembership(
        two.state,
        record(a, revoked.hash, {
          kind: "add",
          target: { ...target, signingPublicKey: b.signingPublicKey }
        }).json
      ).status
    ).toBe("invalid");
    expect(
      applyPeerMembership(
        two.state,
        record(a, revoked.hash, {
          kind: "add",
          target: { ...target, deviceId: b.deviceId }
        }).json
      ).status
    ).toBe("invalid");
  });
  it("rejects noncanonical and malformed records without changing state", () => {
    const { a, b, genesis, state } = setup();
    const add = record(a, genesis.hash, { kind: "add", target: member(b) });
    const parsed = parseRecord(add.json);
    const missing = structuredClone(parsed);
    delete missing.unsigned.body.target.encryptionSpkiSha256;
    const padded = structuredClone(parsed);
    padded.unsigned.body.target.transportSpkiSha256 += "=";
    const unknown = record(a, genesis.hash, {
      kind: "add",
      target: { ...member(b), extra: "x" }
    });
    const missingSigned = record(a, genesis.hash, {
      kind: "add",
      target: {
        deviceId: b.deviceId,
        signingPublicKey: b.signingPublicKey,
        transportSpkiSha256: b.transportSpkiSha256
      }
    });
    const paddedSigned = record(a, genesis.hash, {
      kind: "add",
      target: { ...member(b), transportSpkiSha256: b.transportSpkiSha256 + "=" }
    });
    for (const input of [
      " " + add.json,
      add.json.replace("{", '{"signature":"duplicate",'),
      canonicalizePdsJson(missing),
      canonicalizePdsJson(padded),
      unknown.json,
      missingSigned.json,
      paddedSigned.json
    ]) {
      const result = applyPeerMembership(state, input);
      expect(result.status).toBe("invalid");
      expect(result.state).toBe(state);
    }
  });
  it("preserves distinct identity bindings on conflicting sibling branches", () => {
    const { a, b, c, genesis, state } = setup();
    const first = record(a, genesis.hash, { kind: "add", target: member(b) });
    const second = record(a, genesis.hash, {
      kind: "add",
      target: { ...member(c), deviceId: b.deviceId }
    });
    for (const [left, right] of [
      [first, second],
      [second, first]
    ] as const) {
      const one = applyPeerMembership(state, left.json);
      const two = applyPeerMembership(one.state, right.json);
      const view = inspectPeerMembership(two.state);
      expect(view.conflict).toBe(true);
      expect(view.members).toEqual([]);
      expect(view.records.map((entry) => entry.json)).toEqual([
        genesis.json,
        left.json,
        right.json
      ]);
    }
  });
  it("fails closed when an authenticated admission exceeds member capacity", () => {
    const { a, genesis, state } = setup();
    let current = state;
    let parent = genesis.hash;
    for (let i = 0; i < 127; i++) {
      const added = record(a, parent, {
        kind: "add",
        target: member(device(`m${i}`))
      });
      const result = applyPeerMembership(current, added.json);
      expect(result.status).toBe("accepted");
      current = result.state;
      parent = added.hash;
    }
    const over = record(a, parent, {
      kind: "add",
      target: member(device("overflow"))
    });
    const result = applyPeerMembership(current, over.json);
    expect(result.status).toBe("limit");
    expect(inspectPeerMembership(result.state).members).toEqual([]);
    expect(lookupHistoricalPeerMember(result.state, "a")).toEqual({
      status: "unavailable"
    });
  });
  it("returns a defensive historic identity after revocation without authorizing writes", () => {
    const { a, b, c, genesis, state } = setup();
    expect(lookupHistoricalPeerMember(state, "b")).toEqual({
      status: "not_found"
    });
    const added = record(a, genesis.hash, { kind: "add", target: member(b) });
    const one = applyPeerMembership(state, added.json);
    const revoked = record(a, added.hash, {
      kind: "revoke",
      targetDeviceId: "b"
    });
    const two = applyPeerMembership(one.state, revoked.json);
    const result = lookupHistoricalPeerMember(two.state, "b");
    expect(result).toEqual({ status: "found", member: member(b) });
    if (result.status !== "found") throw new Error("missing historic member");
    expect(Object.isFrozen(result.member)).toBe(true);
    expect(
      inspectPeerMembership(two.state).members.map((m) => m.deviceId)
    ).toEqual(["a"]);
    expect(
      applyPeerMembership(
        two.state,
        record(b, revoked.hash, {
          kind: "add",
          target: member(c)
        }).json
      ).status
    ).toBe("invalid");
    expect(lookupHistoricalPeerMember(two.state, "b")).toEqual(result);
    expect(lookupHistoricalPeerMember(two.state, "missing")).toEqual({
      status: "not_found"
    });
  });
  it("refuses historic lookup on conflicting identity or credential reuse branches", () => {
    const { a, b, c, genesis, state } = setup();
    const first = record(a, genesis.hash, { kind: "add", target: member(b) });
    for (const target of [
      { ...member(c), deviceId: b.deviceId },
      {
        ...member(c),
        encryptionSpki: b.encryptionSpki,
        encryptionSpkiSha256: b.encryptionSpkiSha256
      }
    ]) {
      const sibling = record(a, genesis.hash, { kind: "add", target });
      for (const [left, right] of [
        [first, sibling],
        [sibling, first]
      ] as const) {
        const conflict = applyPeerMembership(
          applyPeerMembership(state, left.json).state,
          right.json
        );
        expect(lookupHistoricalPeerMember(conflict.state, "a")).toEqual({
          status: "unavailable"
        });
        expect(lookupHistoricalPeerMember(conflict.state, b.deviceId)).toEqual({
          status: "unavailable"
        });
      }
    }
  });
  it("does not expose mutable state through inspection", () => {
    const { state } = setup();
    const view = inspectPeerMembership(state);
    view.members[0]!.deviceId = "changed";
    view.members.length = 0;
    view.records[0]!.json = "altered";
    view.records.length = 0;
    expect(inspectPeerMembership(state).members[0]!.deviceId).toBe("a");
    expect(inspectPeerMembership(state).records[0]!.json).not.toBe("altered");
  });
});

type MutableRecord = {
  unsigned: {
    protocol: string;
    body: { target: Record<string, string | undefined> };
  };
  signature: string;
};

function parseRecord(json: string): MutableRecord {
  return JSON.parse(json) as MutableRecord;
}
