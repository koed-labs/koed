import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalizePdsJson } from "./personal-device-sync-jcs.js";
import {
  derivePeerSessionKey,
  peerOnlineDeletionIdentity,
  samePeerOnlineDeletionIdentity,
  signPeerOnlineDeletion,
  signPeerOnlineDeletionAck,
  validatePeerOnlineDeletion,
  validatePeerOnlineDeletionAck
} from "./peer-online-deletion.js";

const origin = generateKeyPairSync("ed25519");
const author = generateKeyPairSync("ed25519");
const outsider = generateKeyPairSync("ed25519");
const encoded = (n: number) => Buffer.alloc(32, n).toString("base64url");
const tuple = {
  groupId: "group",
  originDeviceId: "origin",
  originSessionId: encoded(1)
};
const head = encoded(2);
const originKey = origin.publicKey.export({ format: "jwk" }).x!;
const authorKey = author.publicKey.export({ format: "jwk" }).x!;
const signed = (domain: string, unsigned: object, signer = origin) => ({
  unsigned,
  signature: sign(
    null,
    Buffer.from(`${domain}\n${canonicalizePdsJson(unsigned)}`),
    signer.privateKey
  ).toString("base64url")
});
function fixtures() {
  const sessionKey = derivePeerSessionKey(tuple);
  const binding = signed("koed/peer-online-session-binding/v1", {
    protocol: "koed/peer-online-session-binding/v1",
    ...tuple,
    sessionKey,
    sourceIdentityCommitment: encoded(3)
  });
  const deletion = signed(
    "koed/peer-online-deletion/v1",
    {
      protocol: "koed/peer-online-deletion/v1",
      ...tuple,
      sessionKey,
      authorDeviceId: "author",
      membershipHeadHash: head,
      eventId: encoded(4)
    },
    author
  );
  return { binding, deletion };
}
const boundary = {
  historicalOriginKey: (groupId: string, deviceId: string) =>
    groupId === "group" && deviceId === "origin" ? originKey : undefined,
  currentAuthorKey: (
    groupId: string,
    membershipHeadHash: string,
    deviceId: string
  ) =>
    groupId === "group" && membershipHeadHash === head && deviceId === "author"
      ? authorKey
      : undefined
};
const validate = (binding: object, deletion: object, lookup = boundary) =>
  validatePeerOnlineDeletion(
    canonicalizePdsJson(binding),
    canonicalizePdsJson(deletion),
    lookup
  );

describe("peer-online deletion records", () => {
  it("accepts an active author deleting a revoked origin's session", () => {
    const { binding, deletion } = fixtures();
    expect(boundary.currentAuthorKey("group", head, "origin")).toBeUndefined();
    expect(validate(binding, deletion).status).toBe("accepted");
  });
  it("rejects missing historical origin identity, revoked authors and stale or conflicted heads", () => {
    const { binding, deletion } = fixtures();
    expect(
      validate(binding, deletion, {
        ...boundary,
        historicalOriginKey: () => undefined
      }).status
    ).toBe("invalid");
    expect(
      validate(binding, deletion, {
        ...boundary,
        currentAuthorKey: () => undefined
      }).status
    ).toBe("invalid");
    const stale = signed(
      "koed/peer-online-deletion/v1",
      { ...deletion.unsigned, membershipHeadHash: encoded(7) },
      author
    );
    expect(validate(binding, stale).status).toBe("invalid");
  });
  it("rejects valid signatures from the wrong signer and substituted identity", () => {
    const { binding, deletion } = fixtures();
    expect(
      validate(
        signed("koed/peer-online-session-binding/v1", binding.unsigned, author),
        deletion
      ).status
    ).toBe("invalid");
    expect(
      validate(
        binding,
        signed("koed/peer-online-deletion/v1", deletion.unsigned, origin)
      ).status
    ).toBe("invalid");
    expect(
      validate(
        binding,
        signed("koed/peer-online-deletion/v1", deletion.unsigned, outsider)
      ).status
    ).toBe("invalid");
    expect(
      validate(binding, {
        ...deletion,
        unsigned: { ...deletion.unsigned, groupId: "other" }
      }).status
    ).toBe("invalid");
    expect(
      validate(binding, {
        ...deletion,
        unsigned: { ...deletion.unsigned, sessionKey: encoded(8) }
      }).status
    ).toBe("invalid");
    expect(
      validate(
        {
          ...binding,
          unsigned: {
            ...binding.unsigned,
            sourceIdentityCommitment: encoded(9)
          }
        },
        deletion
      ).status
    ).toBe("invalid");
  });
  it("rejects a different valid binding when an immutable binding was retained", () => {
    const { binding, deletion } = fixtures();
    const first = validate(binding, deletion);
    expect(first.status).toBe("accepted");
    if (first.status !== "accepted") throw new Error("expected accepted");
    const replacement = signed("koed/peer-online-session-binding/v1", {
      ...binding.unsigned,
      sourceIdentityCommitment: encoded(9)
    });
    expect(
      validatePeerOnlineDeletion(
        canonicalizePdsJson(replacement),
        canonicalizePdsJson(deletion),
        boundary,
        first.bindingHash
      ).status
    ).toBe("invalid");
  });
  it("rejects noncanonical JSON, unknown fields, oversized input and malformed public keys", () => {
    const { binding, deletion } = fixtures();
    expect(
      validatePeerOnlineDeletion(
        JSON.stringify(binding, null, 2),
        canonicalizePdsJson(deletion),
        boundary
      ).status
    ).toBe("invalid");
    expect(validate({ ...binding, extra: true }, deletion).status).toBe(
      "invalid"
    );
    expect(
      validatePeerOnlineDeletion(
        " ".repeat(20000),
        canonicalizePdsJson(deletion),
        boundary
      ).status
    ).toBe("invalid");
    expect(
      validate(binding, deletion, {
        ...boundary,
        historicalOriginKey: () => encoded(0)
      }).status
    ).toBe("invalid");
    expect(
      validate(binding, deletion, {
        ...boundary,
        currentAuthorKey: () => "bad"
      }).status
    ).toBe("invalid");
  });
});

describe("peer-online deletion identity and re-authoring", () => {
  it("keeps identity across a re-authored record at another head", () => {
    const { binding, deletion } = fixtures();
    const original = canonicalizePdsJson(deletion);
    const identity = peerOnlineDeletionIdentity(original)!;
    expect(identity).toEqual({
      ...tuple,
      sessionKey: derivePeerSessionKey(tuple),
      eventId: encoded(4)
    });
    const newHead = encoded(9);
    const reauthored = signPeerOnlineDeletion(
      { identity, authorDeviceId: "origin", membershipHeadHash: newHead },
      origin.privateKey
    );
    expect(reauthored).not.toBe(original);
    expect(
      samePeerOnlineDeletionIdentity(
        identity,
        peerOnlineDeletionIdentity(reauthored)!
      )
    ).toBe(true);
    const result = validatePeerOnlineDeletion(
      canonicalizePdsJson(binding),
      reauthored,
      {
        ...boundary,
        currentAuthorKey: (groupId, membershipHeadHash, deviceId) =>
          groupId === "group" &&
          membershipHeadHash === newHead &&
          deviceId === "origin"
            ? originKey
            : undefined
      }
    );
    expect(result.status).toBe("accepted");
    if (result.status === "accepted") expect(result.identity).toEqual(identity);
  });
  it("distinguishes identities and rejects malformed records", () => {
    const identity = peerOnlineDeletionIdentity(
      canonicalizePdsJson(fixtures().deletion)
    )!;
    expect(
      samePeerOnlineDeletionIdentity(identity, {
        ...identity,
        eventId: encoded(5)
      })
    ).toBe(false);
    expect(peerOnlineDeletionIdentity("{}")).toBeUndefined();
    expect(peerOnlineDeletionIdentity("x".repeat(20000))).toBeUndefined();
  });
});

describe("peer-online deletion acknowledgements", () => {
  const recipient = generateKeyPairSync("ed25519");
  const recipientKey = recipient.publicKey.export({ format: "jwk" }).x!;
  const lookup = (groupId: string, deviceId: string) =>
    groupId === "group" && deviceId === "recipient" ? recipientKey : undefined;
  const fields = () => ({
    identity: peerOnlineDeletionIdentity(
      canonicalizePdsJson(fixtures().deletion)
    )!,
    recipientDeviceId: "recipient",
    appliedFloorHash: encoded(7),
    membershipHeadHash: head
  });
  it("round-trips a signed acknowledgement", () => {
    const { ack, ackHash } = signPeerOnlineDeletionAck(
      fields(),
      recipient.privateKey
    );
    expect(validatePeerOnlineDeletionAck(ack, lookup)).toEqual({
      status: "accepted",
      ackHash,
      ...fields()
    });
  });
  it("rejects a wrong signer, unknown recipient, tampering and extra fields", () => {
    const { ack } = signPeerOnlineDeletionAck(fields(), outsider.privateKey);
    expect(validatePeerOnlineDeletionAck(ack, lookup).status).toBe("invalid");
    const good = signPeerOnlineDeletionAck(fields(), recipient.privateKey).ack;
    expect(validatePeerOnlineDeletionAck(good, () => undefined).status).toBe(
      "invalid"
    );
    const parsed = JSON.parse(good) as {
      unsigned: Record<string, string>;
      signature: string;
    };
    expect(
      validatePeerOnlineDeletionAck(
        canonicalizePdsJson({
          ...parsed,
          unsigned: { ...parsed.unsigned, eventId: encoded(8) }
        }),
        lookup
      ).status
    ).toBe("invalid");
    expect(
      validatePeerOnlineDeletionAck(
        canonicalizePdsJson({
          ...parsed,
          unsigned: { ...parsed.unsigned, extra: "x" }
        }),
        lookup
      ).status
    ).toBe("invalid");
    expect(validatePeerOnlineDeletionAck("{}", lookup).status).toBe("invalid");
  });
  it("rejects an acknowledgement whose session key does not match its tuple", () => {
    const f = fields();
    expect(() =>
      signPeerOnlineDeletionAck(
        { ...f, identity: { ...f.identity, sessionKey: encoded(6) } },
        recipient.privateKey
      )
    ).not.toThrow();
    const { ack } = signPeerOnlineDeletionAck(
      { ...f, identity: { ...f.identity, sessionKey: encoded(6) } },
      recipient.privateKey
    );
    expect(validatePeerOnlineDeletionAck(ack, lookup).status).toBe("invalid");
  });
});
