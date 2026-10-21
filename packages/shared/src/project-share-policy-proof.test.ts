import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  generateProjectSharePolicyKeyPair,
  projectSharePolicyProofPayloadSchema,
  projectSharePolicyPublicKeyHash,
  signProjectSharePolicyProof,
  verifyProjectSharePolicyProof
} from "./project-share-policy-proof.js";

const issuedAt = "2026-10-21T12:00:00.000Z";
const expiresAt = "2026-10-21T12:04:59.999Z";
const payload = () => {
  const workspaceProjectId = randomUUID();
  return {
    protocol: "koed_project_share_policy_future_proof" as const,
    version: 1 as const,
    type: "future_summary" as const,
    policyId: randomUUID(),
    policyVersion: 8,
    backendId: "team-primary",
    workspaceProjectId,
    personalOwnerUserId: randomUUID(),
    ownerUserId: randomUUID(),
    ownerTeamMemberId: randomUUID(),
    deviceCredentialId: randomUUID(),
    personalProjectBindingHash: "a".repeat(64),
    sessionId: randomUUID(),
    logicalMemoryId: randomUUID(),
    sourceRevision: 3,
    mappingRevision: 5,
    capturePolicyVersion: 8,
    captureWorkspaceProjectId: workspaceProjectId,
    captureContextVersion: 4,
    captureAt: "2026-10-21T11:58:00.000Z",
    issuedAt,
    expiresAt,
    nonce: randomUUID(),
    candidateHash: "b".repeat(64),
    closureHash: "c".repeat(64)
  };
};
const atIssue = new Date("2026-10-21T12:01:00.000Z");

describe("Project policy future proof", () => {
  it("signs canonical domain-separated claims with a dedicated Ed25519 key", () => {
    const key = generateProjectSharePolicyKeyPair();
    expect(Buffer.from(key.publicKeyDerBase64, "base64")).toHaveLength(44);
    expect(projectSharePolicyPublicKeyHash(key.publicKeyDerBase64)).toMatch(
      /^[0-9a-f]{64}$/
    );
    const claim = payload();
    expect(claim.personalOwnerUserId).not.toBe(claim.ownerUserId);
    const proof = signProjectSharePolicyProof(claim, key.privateKeyDerBase64);
    expect(
      verifyProjectSharePolicyProof(proof, key.publicKeyDerBase64, atIssue)
    ).toBe(true);
    // Input object insertion order does not alter the signed representation.
    const reordered = Object.fromEntries(Object.entries(claim).reverse());
    expect(
      signProjectSharePolicyProof(
        reordered as typeof claim,
        key.privateKeyDerBase64
      ).signature
    ).toBe(proof.signature);
  });

  it("rejects altered scope, capture stamp, source, closure, nonce and foreign key", () => {
    const key = generateProjectSharePolicyKeyPair();
    const proof = signProjectSharePolicyProof(
      payload(),
      key.privateKeyDerBase64
    );
    for (const [field, changed] of [
      ["policyId", randomUUID()],
      ["backendId", "foreign-backend"],
      ["workspaceProjectId", randomUUID()],
      ["personalOwnerUserId", randomUUID()],
      ["ownerUserId", randomUUID()],
      ["deviceCredentialId", randomUUID()],
      ["sessionId", randomUUID()],
      ["logicalMemoryId", randomUUID()],
      ["sourceRevision", 4],
      ["mappingRevision", 6],
      ["captureContextVersion", 5],
      ["captureAt", "2026-10-21T11:57:00.000Z"],
      ["nonce", randomUUID()],
      ["candidateHash", "d".repeat(64)],
      ["closureHash", "e".repeat(64)]
    ] as const) {
      expect(
        verifyProjectSharePolicyProof(
          {
            ...proof,
            payload: {
              ...proof.payload,
              [field]: changed
            }
          },
          key.publicKeyDerBase64,
          atIssue
        ),
        field
      ).toBe(false);
    }
    expect(
      verifyProjectSharePolicyProof(
        proof,
        generateProjectSharePolicyKeyPair().publicKeyDerBase64,
        atIssue
      )
    ).toBe(false);
    expect(
      verifyProjectSharePolicyProof(
        { ...proof, signature: "AAAA" },
        key.publicKeyDerBase64,
        atIssue
      )
    ).toBe(false);
  });

  it("rejects malformed, noncanonical and expired claims", () => {
    const key = generateProjectSharePolicyKeyPair();
    const proof = signProjectSharePolicyProof(
      payload(),
      key.privateKeyDerBase64
    );
    expect(
      verifyProjectSharePolicyProof(
        proof,
        key.publicKeyDerBase64,
        new Date("2026-10-21T11:59:59.999Z")
      )
    ).toBe(false);
    expect(
      verifyProjectSharePolicyProof(
        proof,
        key.publicKeyDerBase64,
        new Date(expiresAt)
      )
    ).toBe(false);
    expect(
      verifyProjectSharePolicyProof(
        { ...proof, extra: true },
        key.publicKeyDerBase64,
        atIssue
      )
    ).toBe(false);
    expect(
      verifyProjectSharePolicyProof(
        { ...proof, signature: `${proof.signature}\n` },
        key.publicKeyDerBase64,
        atIssue
      )
    ).toBe(false);
    expect(
      verifyProjectSharePolicyProof(proof, "A".repeat(100_000), atIssue)
    ).toBe(false);
    expect(() =>
      signProjectSharePolicyProof(payload(), "A".repeat(100_000))
    ).toThrow();
    expect(() =>
      projectSharePolicyProofPayloadSchema.parse({
        ...payload(),
        expiresAt: "2026-10-21T12:05:00.001Z"
      })
    ).toThrow();
    expect(() =>
      projectSharePolicyProofPayloadSchema.parse({
        ...payload(),
        capturePolicyVersion: 7
      })
    ).toThrow();
    expect(() =>
      projectSharePolicyProofPayloadSchema.parse({
        ...payload(),
        captureAt: "2026-10-21T13:00:00.000Z"
      })
    ).toThrow();
    expect(() =>
      projectSharePolicyProofPayloadSchema.parse({
        ...payload(),
        issuedAt: "2026-10-21T12:00:00+00:00"
      })
    ).toThrow();
    expect(() =>
      projectSharePolicyProofPayloadSchema.parse({
        ...payload(),
        backendId: " team-primary "
      })
    ).toThrow();
  });

  it("requires external one-use nonce custody for replay prevention", () => {
    const key = generateProjectSharePolicyKeyPair();
    const proof = signProjectSharePolicyProof(
      payload(),
      key.privateKeyDerBase64
    );
    const consumed = new Set<string>();
    const acceptOnce = () =>
      verifyProjectSharePolicyProof(proof, key.publicKeyDerBase64, atIssue) &&
      !consumed.has(proof.payload.nonce) &&
      Boolean(consumed.add(proof.payload.nonce));
    expect(acceptOnce()).toBe(true);
    expect(acceptOnce()).toBe(false);
  });
});
