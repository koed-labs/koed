import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalizePdsJson } from "./personal-device-sync-jcs.js";
import {
  apply,
  initialize,
  inspect
} from "./peer-membership-history.test-support.js";

const key = generateKeyPairSync("ed25519");
const publicKey = key.publicKey
  .export({ format: "der", type: "spki" })
  .subarray(-32)
  .toString("base64url");
const genesis = {
  protocol: "koed/peer-membership/test-v1",
  groupId: "group",
  parentHash: null,
  authorDeviceId: "alice",
  body: {
    kind: "genesis",
    initialMember: { deviceId: "alice", signingPublicKey: publicKey }
  }
};
const canonical = canonicalizePdsJson(genesis);
const hash = createHash("sha256")
  .update("koed/peer-membership/test-v1/record\n")
  .update(canonical)
  .digest("base64url");
const signature = sign(
  null,
  Buffer.from(`koed/peer-membership/test-v1/decision\n${canonical}`),
  key.privateKey
).toString("base64url");
const record = canonicalizePdsJson({ unsigned: genesis, signature });

describe("test-only peer membership history", () => {
  it("accepts a signed genesis only when it matches the supplied trust anchor", () => {
    expect(
      initialize({ groupId: "group", genesisHash: hash }, record).status
    ).toBe("accepted");
    expect(
      initialize({ groupId: "group", genesisHash: "A".repeat(43) }, record)
        .status
    ).toBe("invalid");
    expect(
      initialize({ groupId: "other", genesisHash: hash }, record).status
    ).toBe("invalid");
    expect(
      initialize({ groupId: "group", genesisHash: hash }, "{}").status
    ).toBe("invalid");
  });

  it("retains valid revocations and rejects revoked or forged authors", () => {
    const initial = initialize({ groupId: "group", genesisHash: hash }, record);
    if (initial.status !== "accepted") throw new Error("genesis failed");
    const bob = generateKeyPairSync("ed25519");
    const bobKey = bob.publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("base64url");
    const signed = (unsigned: object, signer = key.privateKey) => {
      const canonical = canonicalizePdsJson(unsigned);
      const signature = sign(
        null,
        Buffer.from(`koed/peer-membership/test-v1/decision\n${canonical}`),
        signer
      ).toString("base64url");
      const decisionHash = createHash("sha256")
        .update("koed/peer-membership/test-v1/record\n")
        .update(canonical)
        .digest("base64url");
      return {
        json: canonicalizePdsJson({ unsigned, signature }),
        decisionHash
      };
    };
    const add = signed({
      protocol: genesis.protocol,
      groupId: "group",
      parentHash: hash,
      authorDeviceId: "alice",
      body: {
        kind: "add",
        target: { deviceId: "bob", signingPublicKey: bobKey }
      }
    });
    const added = apply(initial.state, add.json);
    if (added.status !== "accepted") throw new Error("add failed");
    const revoke = signed({
      protocol: genesis.protocol,
      groupId: "group",
      parentHash: add.decisionHash,
      authorDeviceId: "alice",
      body: { kind: "revoke", targetDeviceId: "bob" }
    });
    const revoked = apply(added.state, revoke.json);
    if (revoked.status !== "accepted") throw new Error("revoke failed");
    expect(
      inspect(revoked.state).revocations.has(JSON.stringify(["bob", bobKey]))
    ).toBe(true);
    expect(inspect(revoked.state).effectiveMembers.has("bob")).toBe(false);
    const unauthorized = signed(
      {
        protocol: genesis.protocol,
        groupId: "group",
        parentHash: revoke.decisionHash,
        authorDeviceId: "bob",
        body: { kind: "revoke", targetDeviceId: "alice" }
      },
      bob.privateKey
    );
    expect(apply(revoked.state, unauthorized.json).status).toBe("invalid");
    const forged = signed(
      {
        protocol: genesis.protocol,
        groupId: "group",
        parentHash: add.decisionHash,
        authorDeviceId: "alice",
        body: { kind: "revoke", targetDeviceId: "bob" }
      },
      bob.privateKey
    );
    expect(apply(added.state, forged.json).status).toBe("invalid");
    expect(inspect(added.state).conflict).toBe(false);
  });

  it("rejects noncanonical records, invalid scope and tampered proofs", () => {
    const initial = initialize({ groupId: "group", genesisHash: hash }, record);
    if (initial.status !== "accepted") throw new Error("genesis failed");
    expect(
      initialize({ groupId: "group", genesisHash: hash }, record + " ").status
    ).toBe("invalid");
    expect(
      initialize(
        { groupId: "group", genesisHash: hash },
        '{"signature":"x","signature":"y"}'
      ).status
    ).toBe("invalid");
    const target = { deviceId: "bob", signingPublicKey: publicKey };
    const unsigned = {
      protocol: genesis.protocol,
      groupId: "other",
      parentHash: "A".repeat(43),
      authorDeviceId: "alice",
      body: { kind: "add", target }
    };
    const input = canonicalizePdsJson({ unsigned, signature });
    expect(apply(initial.state, input).status).toBe("invalid");
    const badProfile = {
      ...unsigned,
      protocol: "koed/pds/v1",
      groupId: "group"
    };
    expect(
      apply(
        initial.state,
        canonicalizePdsJson({ unsigned: badProfile, signature })
      ).status
    ).toBe("invalid");
    const forged = { ...unsigned, groupId: "group", parentHash: hash };
    expect(
      apply(initial.state, canonicalizePdsJson({ unsigned: forged, signature }))
        .status
    ).toBe("invalid");
    expect(inspect(initial.state).recordCount).toBe(1);
  });

  it("returns defensive inspection copies and preserves a latched conflict", () => {
    const initial = initialize({ groupId: "group", genesisHash: hash }, record);
    if (initial.status !== "accepted") throw new Error("genesis failed");
    const observed = inspect(initial.state);
    observed.effectiveMembers.get("alice")!.signingPublicKey = "tampered";
    observed.effectiveMembers.clear();
    expect(
      inspect(initial.state).effectiveMembers.get("alice")?.signingPublicKey
    ).toBe(publicKey);
    expect(Object.isFrozen(initial.state)).toBe(true);
    expect(() => inspect({} as typeof initial.state)).toThrow("invalid state");
  });

  it("latches incomplete only for a valid decision beyond the record bound", () => {
    const initial = initialize({ groupId: "group", genesisHash: hash }, record);
    if (initial.status !== "accepted") throw new Error("genesis failed");
    let state = initial.state;
    let parentHash = hash;
    const make = (index: number, kind: "add" | "revoke") => {
      const body =
        kind === "add"
          ? {
              kind,
              target: {
                deviceId: `device-${index}`,
                signingPublicKey: createHash("sha256")
                  .update(`key-${index}`)
                  .digest("base64url")
              }
            }
          : { kind, targetDeviceId: "alice" };
      const unsigned = {
        protocol: genesis.protocol,
        groupId: "group",
        parentHash,
        authorDeviceId: "alice",
        body
      };
      const canonical = canonicalizePdsJson(unsigned);
      return {
        json: canonicalizePdsJson({
          unsigned,
          signature: sign(
            null,
            Buffer.from(`koed/peer-membership/test-v1/decision\n${canonical}`),
            key.privateKey
          ).toString("base64url")
        }),
        hash: createHash("sha256")
          .update("koed/peer-membership/test-v1/record\n")
          .update(canonical)
          .digest("base64url")
      };
    };
    for (let index = 0; index < 1023; index += 1) {
      const entry = make(index, "add");
      const result = apply(state, entry.json);
      if (result.status !== "accepted")
        throw new Error(`unexpected ${result.status} at ${index}`);
      state = result.state;
      parentHash = entry.hash;
    }
    expect(inspect(state).recordCount).toBe(1024);
    expect(apply(state, make(1023, "revoke").json).status).toBe("invalid");
    const limited = apply(state, make(1023, "add").json);
    expect(limited.status).toBe("limit");
    expect(inspect(limited.state).incomplete).toBe(true);
    expect(inspect(limited.state).effectiveMembers.size).toBe(0);
    expect(apply(limited.state, make(1024, "add").json).status).toBe("limit");
  }, 30000);

  it("latches validated forks and reports cross-branch identity collisions", () => {
    const initial = initialize({ groupId: "group", genesisHash: hash }, record);
    if (initial.status !== "accepted") throw new Error("genesis failed");
    const makeAdd = () => {
      const next = generateKeyPairSync("ed25519");
      const target = {
        deviceId: "bob",
        signingPublicKey: next.publicKey
          .export({ format: "der", type: "spki" })
          .subarray(-32)
          .toString("base64url")
      };
      const unsigned = {
        protocol: genesis.protocol,
        groupId: "group",
        parentHash: hash,
        authorDeviceId: "alice",
        body: { kind: "add", target }
      };
      const bytes = canonicalizePdsJson(unsigned);
      return canonicalizePdsJson({
        unsigned,
        signature: sign(
          null,
          Buffer.from(`koed/peer-membership/test-v1/decision\n${bytes}`),
          key.privateKey
        ).toString("base64url")
      });
    };
    const first = apply(initial.state, makeAdd());
    if (first.status !== "accepted") throw new Error("first failed");
    const second = apply(first.state, makeAdd());
    if (second.status !== "accepted") throw new Error("second failed");
    expect(inspect(second.state).conflict).toBe(true);
    expect(inspect(second.state).collision).toBe(true);
    expect(inspect(second.state).effectiveMembers.size).toBe(0);
    const limited = apply(second.state, "x".repeat(16385));
    expect(limited.status).toBe("limit");
    expect(inspect(limited.state).incomplete).toBe(true);
  });

  it("keeps conflict latched while accepting branch-local revocation evidence", () => {
    const initial = initialize({ groupId: "group", genesisHash: hash }, record);
    if (initial.status !== "accepted") throw new Error("genesis failed");
    const bobKey = generateKeyPairSync("ed25519")
      .publicKey.export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("base64url");
    const entry = (parentHash: string, body: object) => {
      const unsigned = {
        protocol: genesis.protocol,
        groupId: "group",
        parentHash,
        authorDeviceId: "alice",
        body
      };
      const canonical = canonicalizePdsJson(unsigned);
      return {
        json: canonicalizePdsJson({
          unsigned,
          signature: sign(
            null,
            Buffer.from(`koed/peer-membership/test-v1/decision\n${canonical}`),
            key.privateKey
          ).toString("base64url")
        }),
        hash: createHash("sha256")
          .update("koed/peer-membership/test-v1/record\n")
          .update(canonical)
          .digest("base64url")
      };
    };
    const left = entry(hash, {
      kind: "add",
      target: { deviceId: "bob", signingPublicKey: bobKey }
    });
    const right = entry(hash, {
      kind: "add",
      target: {
        deviceId: "carol",
        signingPublicKey: generateKeyPairSync("ed25519")
          .publicKey.export({ format: "der", type: "spki" })
          .subarray(-32)
          .toString("base64url")
      }
    });
    for (const [first, second] of [
      [left, right],
      [right, left]
    ] as const) {
      const a = apply(initial.state, first.json);
      if (a.status !== "accepted") throw new Error("first failed");
      const b = apply(a.state, second.json);
      if (b.status !== "accepted") throw new Error("second failed");
      const revocation = entry(left.hash, {
        kind: "revoke",
        targetDeviceId: "bob"
      });
      const c = apply(b.state, revocation.json);
      if (c.status !== "accepted") throw new Error("revoke failed");
      const observed = inspect(c.state);
      expect(observed.conflict).toBe(true);
      expect(observed.effectiveMembers.size).toBe(0);
      expect(observed.revocations.has(JSON.stringify(["bob", bobKey]))).toBe(
        true
      );
      expect(observed.records.map((item) => item.hash)).toContain(left.hash);
    }
  });

  it("validates extensions against their parent and treats a stale parent as pending", () => {
    const initial = initialize({ groupId: "group", genesisHash: hash }, record);
    if (initial.status !== "accepted") throw new Error("genesis failed");
    const bob = generateKeyPairSync("ed25519");
    const bobKey = bob.publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("base64url");
    const add = {
      protocol: genesis.protocol,
      groupId: "group",
      parentHash: hash,
      authorDeviceId: "alice",
      body: {
        kind: "add",
        target: { deviceId: "bob", signingPublicKey: bobKey }
      }
    };
    const encode = (value: typeof add) => {
      const data = canonicalizePdsJson(value);
      const proof = sign(
        null,
        Buffer.from(`koed/peer-membership/test-v1/decision\n${data}`),
        key.privateKey
      ).toString("base64url");
      return canonicalizePdsJson({ unsigned: value, signature: proof });
    };
    const accepted = apply(initial.state, encode(add));
    expect(accepted.status).toBe("accepted");
    if (accepted.status !== "accepted") throw new Error("add failed");
    expect(apply(accepted.state, encode(add)).status).toBe("duplicate");
    const alternateInvalid = canonicalizePdsJson({
      unsigned: add,
      signature: sign(
        null,
        Buffer.from(
          `koed/peer-membership/test-v1/decision\n${canonicalizePdsJson(add)}`
        ),
        bob.privateKey
      ).toString("base64url")
    });
    expect(apply(accepted.state, alternateInvalid).status).toBe("invalid");
    expect(inspect(accepted.state).recordCount).toBe(2);
    expect(
      apply(initial.state, encode({ ...add, parentHash: "A".repeat(43) }))
        .status
    ).toBe("pending");
    expect(
      apply(
        initial.state,
        encode({ ...add, groupId: "other", parentHash: "A".repeat(43) })
      ).status
    ).toBe("invalid");
    expect(inspect(initial.state).recordCount).toBe(1);
  });
});
