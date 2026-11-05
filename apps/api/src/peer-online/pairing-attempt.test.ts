import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  PairingAttempts,
  pairingTranscript,
  type PairingOffer,
  type PairingJoin
} from "./pairing-attempt.js";

const privateKey = createPrivateKey({
  key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.alloc(32, 7)
  ]),
  format: "der",
  type: "pkcs8"
});
const publicKey = createPublicKey(privateKey)
  .export({ format: "der", type: "spki" })
  .toString("base64url");
const otherKey = createPrivateKey({
  key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.alloc(32, 8)
  ]),
  format: "der",
  type: "pkcs8"
});
const encryptionPrivateKey = createPrivateKey({
  key: Buffer.concat([
    Buffer.from("302e020100300506032b656e04220420", "hex"),
    Buffer.alloc(32, 9)
  ]),
  format: "der",
  type: "pkcs8"
});
const encryptionKey = createPublicKey(encryptionPrivateKey)
  .export({ format: "der", type: "spki" })
  .toString("base64url");

function join(
  offer: PairingOffer,
  changes: Partial<PairingJoin> = {}
): PairingJoin {
  const value: PairingJoin = {
    deviceId: "joiner",
    signingKey: publicKey,
    encryptionKey,
    code: "123456",
    signature: "",
    ...changes
  };
  value.signature = sign(
    null,
    pairingTranscript(offer, value),
    privateKey
  ).toString("base64url");
  return value;
}

function setup(
  commit: (input: unknown) => Promise<string> = async () => "committed"
) {
  let now = 1_000;
  const attempts = new PairingAttempts({
    now: () => now,
    authorizeLocal: () => true,
    commit
  });
  const offer = attempts.create({
    groupId: "group",
    initiatorId: "trusted",
    initiatorKey: "trusted-key"
  });
  return {
    attempts,
    offer,
    advance: (ms = 1_000) => {
      now += ms;
    }
  };
}

describe("peer-online pairing attempts", () => {
  it("binds a proved joiner and commits once only after correct approval", async () => {
    const commits: unknown[] = [];
    const { attempts, offer, advance } = setup(async (input) => {
      commits.push(input);
      return "secret";
    });
    expect(offer).not.toHaveProperty("code");
    attempts.join(offer, join(offer));
    await expect(attempts.approve(offer.id, "000000")).rejects.toThrow();
    expect(commits).toHaveLength(0);
    advance();
    await expect(attempts.approve(offer.id, "123456")).resolves.toBe("secret");
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({
      groupId: "group",
      deviceId: "joiner",
      signingKey: publicKey,
      encryptionKey
    });
    await expect(attempts.approve(offer.id, "123456")).rejects.toThrow();
    expect(() => attempts.join(offer, join(offer))).toThrow();
  });

  it("rejects an unusable low-order X25519 public key", () => {
    const { attempts, offer } = setup();
    const lowOrder = createPublicKey({
      key: {
        kty: "OKP",
        crv: "X25519",
        x: Buffer.alloc(32).toString("base64url")
      },
      format: "jwk"
    })
      .export({ format: "der", type: "spki" })
      .toString("base64url");
    expect(() =>
      attempts.join(offer, join(offer, { encryptionKey: lowOrder }))
    ).toThrow("Invalid pairing proof");
  });

  it("requires local authorization for creation and approval before consuming guesses", async () => {
    const authority = {};
    const options = {
      authorizeLocal: (context: unknown) => context === authority,
      commit: async () => "secret"
    };
    const attempts = new PairingAttempts(options) as unknown as {
      create: (
        input: { groupId: string; initiatorId: string; initiatorKey: string },
        context?: unknown
      ) => PairingOffer;
      join: (offer: PairingOffer, join: PairingJoin) => void;
      approve: (id: string, code: string, context?: unknown) => Promise<string>;
    };
    const input = {
      groupId: "group",
      initiatorId: "trusted",
      initiatorKey: "trusted-key"
    };
    expect(() => attempts.create(input, {})).toThrow();
    const offer = attempts.create(input, authority);
    attempts.join(offer, join(offer));
    for (let i = 0; i < 6; i++)
      await expect(attempts.approve(offer.id, "123456", {})).rejects.toThrow();
    await expect(attempts.approve(offer.id, "123456", authority)).resolves.toBe(
      "secret"
    );
  });

  it("prevents reentrant authorization from starting a second commit", async () => {
    let nested: Promise<string> | undefined;
    let calls = 0;
    let id = "";
    let innerStarted = false;
    let now = 1_000;
    const attempts = new PairingAttempts({
      now: () => now,
      authorizeLocal: (_context, action) => {
        if (action === "approve" && !innerStarted) {
          innerStarted = true;
          nested = attempts.approve(id, "123456");
          now += 1_000;
        }
        return true;
      },
      commit: async () => {
        calls++;
        return "secret";
      }
    });
    const offer = attempts.create({
      groupId: "group",
      initiatorId: "trusted",
      initiatorKey: "trusted-key"
    });
    id = offer.id;
    attempts.join(offer, join(offer));
    await expect(attempts.approve(id, "123456")).rejects.toThrow();
    await expect(nested).resolves.toBe("secret");
    expect(calls).toBe(1);
  });

  it("does not consume join quota for invalid offer tokens", () => {
    const { attempts, offer } = setup();
    for (let i = 0; i < 6; i++)
      expect(() =>
        attempts.join({ ...offer, token: "x".repeat(43) }, join(offer))
      ).toThrow();
    expect(() => attempts.join(offer, join(offer))).not.toThrow();
  });

  it("excludes the short code from the signed transcript", () => {
    const { offer } = setup();
    const original = join(offer);
    expect(
      pairingTranscript(offer, original).equals(
        pairingTranscript(offer, { ...original, code: "654321" })
      )
    ).toBe(true);
  });

  it("times out an indeterminate commit without returning late secrets or allowing replay", async () => {
    vi.useFakeTimers();
    try {
      let resolve!: (value: string) => void;
      const { attempts, offer } = setup(
        () =>
          new Promise((r) => {
            resolve = r;
          })
      );
      attempts.join(offer, join(offer));
      const pending = attempts.approve(offer.id, "123456");
      const input = {
        groupId: "group",
        initiatorId: "trusted",
        initiatorKey: "trusted-key"
      };
      for (let i = 0; i < 999; i++) attempts.create(input);
      expect(() => attempts.create(input)).toThrow(/capacity/i);
      const rejection = expect(pending).rejects.toThrow(/indeterminate/i);
      await vi.advanceTimersByTimeAsync(30_000);
      await rejection;
      expect(() => attempts.create(input)).not.toThrow();
      resolve("late secret");
      await expect(attempts.approve(offer.id, "123456")).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects substitution of offer, device or key after signing", () => {
    for (const change of [
      (o: PairingOffer, j: PairingJoin) => ({
        o: { ...o, groupId: "other" },
        j
      }),
      (o: PairingOffer, j: PairingJoin) => ({
        o: { ...o, expiresAt: o.expiresAt + 1 },
        j
      }),
      (o: PairingOffer, j: PairingJoin) => ({
        o,
        j: { ...j, deviceId: "other" }
      }),
      (o: PairingOffer, j: PairingJoin) => ({
        o,
        j: { ...j, encryptionKey: "other" }
      }),
      (o: PairingOffer, j: PairingJoin) => ({
        o,
        j: {
          ...j,
          signingKey: createPublicKey(otherKey)
            .export({ format: "der", type: "spki" })
            .toString("base64url")
        }
      })
    ]) {
      const { attempts, offer } = setup();
      const input = change(offer, join(offer));
      expect(() => attempts.join(input.o, input.j)).toThrow();
    }
  });

  it("rejects invalid encryption keys and malformed join codes", () => {
    for (const invalid of [
      { encryptionKey: "not-a-key" },
      { encryptionKey: publicKey },
      { code: 123456 as unknown as string }
    ]) {
      const { attempts, offer } = setup();
      expect(() => attempts.join(offer, join(offer, invalid))).toThrow();
    }
  });

  it("expires at deadline and rate limits and bounds guesses", async () => {
    const { attempts, offer, advance } = setup();
    attempts.join(offer, join(offer));
    await expect(attempts.approve(offer.id, "000000")).rejects.toThrow();
    await expect(attempts.approve(offer.id, "123456")).rejects.toThrow();
    for (let i = 0; i < 4; i++) {
      advance();
      await expect(attempts.approve(offer.id, "000000")).rejects.toThrow();
    }
    advance();
    await expect(attempts.approve(offer.id, "123456")).rejects.toThrow();
    const second = setup();
    second.advance(120_000);
    expect(() =>
      second.attempts.join(second.offer, join(second.offer))
    ).toThrow();
  });

  it("serializes concurrent commits and fails closed after commit failure", async () => {
    let resolve!: (value: string) => void;
    let calls = 0;
    const { attempts, offer } = setup(() => {
      calls++;
      return new Promise((r) => {
        resolve = r;
      });
    });
    attempts.join(offer, join(offer));
    const first = attempts.approve(offer.id, "123456");
    await expect(attempts.approve(offer.id, "123456")).rejects.toThrow();
    expect(calls).toBe(1);
    resolve("secret");
    await expect(first).resolves.toBe("secret");
    const failed = setup(async () => {
      throw new Error("transaction failed");
    });
    failed.attempts.join(failed.offer, join(failed.offer));
    await expect(
      failed.attempts.approve(failed.offer.id, "123456")
    ).rejects.toThrow("transaction failed");
    failed.advance();
    await expect(
      failed.attempts.approve(failed.offer.id, "123456")
    ).rejects.toThrow();
  });
});
