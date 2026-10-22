import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  CURATED_SOURCE_COMMITMENT_PROTOCOL,
  CURATED_SOURCE_MATERIAL_PROTOCOL,
  CURATED_SOURCE_UPDATE_PROTOCOL,
  curatedSourceAttestationFingerprint,
  curatedSourceCommitmentHash,
  signCuratedSourceMaterial,
  signCuratedSourceUpdate,
  verifyCuratedSourceMaterial,
  verifyCuratedSourceUpdate,
  type CuratedSourceCommitmentV1,
  type CuratedSourceMaterialV1,
  type CuratedSourceUpdateV1
} from "./curated-source-material.js";

const signingFixture = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const rawPublicKey = (publicKey.export({ format: "jwk" }) as JsonWebKey).x!;
  const keyId = randomUUID();
  const signer = {
    keyId,
    publicKey: rawPublicKey,
    sign: (payload: Buffer) =>
      sign(null, payload, privateKey).toString("base64url")
  };
  const source = {
    kind: "captured_session" as const,
    sessionId: randomUUID(),
    logicalMemoryId: randomUUID()
  };
  const commitment: CuratedSourceCommitmentV1 = {
    protocol: CURATED_SOURCE_COMMITMENT_PROTOCOL,
    source,
    sourceDeploymentProtocolId: randomUUID(),
    sourceOwnerPrincipalId: randomUUID(),
    sourceProjectId: randomUUID(),
    workspaceProjectId: randomUUID(),
    teamBackendId: "team-fixture",
    teamId: randomUUID(),
    teamWorkspaceId: randomUUID(),
    sourceRevision: 4,
    manifest: [],
    items: [],
    assertions: []
  };
  return { signer, commitment };
};

describe("Curated source host attestation", () => {
  it("binds even an empty eligible set to one approved Pending Share and pinned key", () => {
    const { signer, commitment } = signingFixture();
    const material: CuratedSourceMaterialV1 = {
      protocol: CURATED_SOURCE_MATERIAL_PROTOCOL,
      pendingShareId: randomUUID(),
      consentId: randomUUID(),
      previewHash: "a".repeat(64),
      commitmentHash: curatedSourceCommitmentHash(commitment),
      commitment
    };
    const signed = signCuratedSourceMaterial(material, signer);
    expect(verifyCuratedSourceMaterial(signed, signer)).toBe(true);
    expect(curatedSourceAttestationFingerprint(signer.publicKey)).toMatch(
      /^[0-9a-f]{64}$/
    );
    expect(
      verifyCuratedSourceMaterial(
        {
          ...signed,
          material: { ...material, pendingShareId: randomUUID() }
        },
        signer
      )
    ).toBe(false);
    expect(
      verifyCuratedSourceMaterial(signed, { ...signer, keyId: randomUUID() })
    ).toBe(false);
  });

  it("separates continuous generation signatures from initial material signatures", () => {
    const { signer, commitment } = signingFixture();
    const update: CuratedSourceUpdateV1 = {
      protocol: CURATED_SOURCE_UPDATE_PROTOCOL,
      originalPendingShareId: randomUUID(),
      grantId: randomUUID(),
      consentId: randomUUID(),
      previewHash: "b".repeat(64),
      generation: 7,
      commitmentHash: curatedSourceCommitmentHash(commitment),
      commitment
    };
    const signed = signCuratedSourceUpdate(update, signer);
    expect(verifyCuratedSourceUpdate(signed, signer)).toBe(true);
    expect(
      verifyCuratedSourceUpdate(
        {
          ...signed,
          update: { ...update, generation: 8 }
        },
        signer
      )
    ).toBe(false);
    expect(
      verifyCuratedSourceMaterial(
        {
          material: {
            protocol: CURATED_SOURCE_MATERIAL_PROTOCOL,
            pendingShareId: update.originalPendingShareId,
            consentId: update.consentId,
            previewHash: update.previewHash,
            commitmentHash: update.commitmentHash,
            commitment
          },
          attestation: {
            keyId: signed.attestation.keyId,
            publicKey: signed.attestation.publicKey,
            materialHash: signed.attestation.updateHash,
            signature: signed.attestation.signature
          }
        },
        signer
      )
    ).toBe(false);
  });
});
