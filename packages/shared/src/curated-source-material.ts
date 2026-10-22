import { createHash, verify } from "node:crypto";

import { z } from "zod";

import { crossIdentitySyncDigest } from "./cross-identity-sync.js";
import { importConversationSourceReplicationPublicKey } from "./conversation-source-replication.js";
import type { DeviceBoundSourceSigner } from "./device-identity.js";
import type { SharedMemoryCanonicalSourceItemDto } from "./shared-memory-semantic-contract.js";
import type { SharedSourceArtifactV1 } from "./shared-source-artifact.js";

export const CURATED_SOURCE_MATERIAL_PROTOCOL =
  "koed.curated-source-material/v1" as const;
export const CURATED_SOURCE_COMMITMENT_PROTOCOL =
  "koed.curated-source-commitment/v1" as const;
export const CURATED_SOURCE_UPDATE_PROTOCOL =
  "koed.curated-source-update/v1" as const;

const uuid = z.uuid();
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const base64url = z.string().regex(/^[A-Za-z0-9_-]+$/);

export const curatedDirectSourceSchema = z
  .object({
    kind: z.enum(["conversation_item", "memory_event", "memory_node"]),
    sourceId: uuid,
    /** Personal canonical-source digest signed by the host; distinct from sync transport revision hashes. */
    revisionHash: digest,
    sourceSessionId: uuid
  })
  .strict();

export const curatedAssertionProvenanceSchema = z
  .object({
    assertionId: uuid,
    classificationVersion: z.number().int().safe().positive(),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
    directSources: z.array(curatedDirectSourceSchema).min(1).max(2_048)
  })
  .strict();

const manifestEntry = z
  .object({
    sourceId: uuid,
    sourceTable: z.literal("curated_memory_assertions"),
    itemType: z.literal("curated_assertion"),
    sourceCursor: z.number().int().safe().nonnegative(),
    revisionHash: digest,
    occurredAt: z.string().datetime({ offset: true }).nullable(),
    sourceEventId: z.null(),
    sourceNodeId: z.null()
  })
  .strict();

/** Owner-derived material only. Canonical Personal assertion rows never cross this boundary. */
export const curatedSourceCommitmentSchema = z
  .object({
    protocol: z.literal(CURATED_SOURCE_COMMITMENT_PROTOCOL),
    source: z
      .object({
        kind: z.literal("captured_session"),
        sessionId: uuid,
        logicalMemoryId: uuid
      })
      .strict(),
    sourceDeploymentProtocolId: uuid,
    sourceOwnerPrincipalId: uuid,
    sourceProjectId: uuid,
    workspaceProjectId: uuid,
    teamBackendId: z.string().trim().min(1).max(160),
    teamId: uuid,
    teamWorkspaceId: uuid,
    sourceRevision: z.number().int().safe().nonnegative(),
    manifest: z.array(manifestEntry).max(100),
    items: z.array(z.unknown()).max(100),
    assertions: z.array(curatedAssertionProvenanceSchema).max(100)
  })
  .strict();

export type CuratedSourceCommitmentV1 = Omit<
  z.infer<typeof curatedSourceCommitmentSchema>,
  "items" | "manifest"
> & {
  manifest: SharedSourceArtifactV1["manifest"];
  items: SharedMemoryCanonicalSourceItemDto[];
};

export const curatedSourceMaterialSchema = z
  .object({
    protocol: z.literal(CURATED_SOURCE_MATERIAL_PROTOCOL),
    pendingShareId: uuid,
    consentId: uuid,
    previewHash: digest,
    commitmentHash: digest,
    commitment: curatedSourceCommitmentSchema
  })
  .strict();

export type CuratedSourceMaterialV1 = Omit<
  z.infer<typeof curatedSourceMaterialSchema>,
  "commitment"
> & { commitment: CuratedSourceCommitmentV1 };

export const signedCuratedSourceMaterialSchema = z
  .object({
    material: curatedSourceMaterialSchema,
    attestation: z
      .object({
        keyId: uuid,
        publicKey: base64url.length(43),
        materialHash: digest,
        signature: base64url
      })
      .strict()
  })
  .strict();

export type SignedCuratedSourceMaterialV1 = {
  material: CuratedSourceMaterialV1;
  attestation: z.infer<typeof signedCuratedSourceMaterialSchema>["attestation"];
};

export const curatedSourceCommitmentHash = (
  commitment: CuratedSourceCommitmentV1
): string =>
  crossIdentitySyncDigest(curatedSourceCommitmentSchema.parse(commitment));

export const curatedSourceMaterialHash = (
  material: CuratedSourceMaterialV1
): string =>
  crossIdentitySyncDigest(curatedSourceMaterialSchema.parse(material));

const signingPayload = (materialHash: string): Buffer =>
  Buffer.from(`${CURATED_SOURCE_MATERIAL_PROTOCOL}:${materialHash}`, "utf8");

export const curatedSourceAttestationFingerprint = (
  publicKey: string
): string => {
  importConversationSourceReplicationPublicKey(publicKey);
  return createHash("sha256")
    .update(Buffer.from(publicKey, "base64url"))
    .digest("hex");
};

export const signCuratedSourceMaterial = (
  material: CuratedSourceMaterialV1,
  signer: Pick<DeviceBoundSourceSigner, "keyId" | "publicKey" | "sign">
): SignedCuratedSourceMaterialV1 => {
  const materialHash = curatedSourceMaterialHash(material);
  if (
    material.commitmentHash !== curatedSourceCommitmentHash(material.commitment)
  ) {
    throw new TypeError("Curated source commitment hash is invalid");
  }
  return {
    material,
    attestation: {
      keyId: signer.keyId,
      publicKey: signer.publicKey,
      materialHash,
      signature: signer.sign(signingPayload(materialHash))
    }
  };
};

export const verifyCuratedSourceMaterial = (
  signed: SignedCuratedSourceMaterialV1,
  expected: { keyId: string; publicKey: string }
): boolean => {
  const parsed = signedCuratedSourceMaterialSchema.safeParse(signed);
  if (!parsed.success) return false;
  const material = parsed.data.material as CuratedSourceMaterialV1;
  const attestation = parsed.data.attestation;
  if (
    attestation.keyId !== expected.keyId ||
    attestation.publicKey !== expected.publicKey ||
    material.commitmentHash !==
      curatedSourceCommitmentHash(material.commitment) ||
    attestation.materialHash !== curatedSourceMaterialHash(material)
  )
    return false;
  const signature = Buffer.from(attestation.signature, "base64url");
  if (
    signature.length !== 64 ||
    signature.toString("base64url") !== attestation.signature
  )
    return false;
  return verify(
    null,
    signingPayload(attestation.materialHash),
    importConversationSourceReplicationPublicKey(attestation.publicKey),
    signature
  );
};

/** A new, owner-signed classification generation for an existing continuous consent. */
export const curatedSourceUpdateSchema = z
  .object({
    protocol: z.literal(CURATED_SOURCE_UPDATE_PROTOCOL),
    originalPendingShareId: uuid,
    grantId: uuid,
    consentId: uuid,
    previewHash: digest,
    generation: z.number().int().safe().positive(),
    commitmentHash: digest,
    commitment: curatedSourceCommitmentSchema
  })
  .strict();

export type CuratedSourceUpdateV1 = Omit<
  z.infer<typeof curatedSourceUpdateSchema>,
  "commitment"
> & { commitment: CuratedSourceCommitmentV1 };

export const signedCuratedSourceUpdateSchema = z
  .object({
    update: curatedSourceUpdateSchema,
    attestation: z
      .object({
        keyId: uuid,
        publicKey: base64url.length(43),
        updateHash: digest,
        signature: base64url
      })
      .strict()
  })
  .strict();

export type SignedCuratedSourceUpdateV1 = {
  update: CuratedSourceUpdateV1;
  attestation: z.infer<typeof signedCuratedSourceUpdateSchema>["attestation"];
};

export const curatedSourceUpdateHash = (
  update: CuratedSourceUpdateV1
): string => crossIdentitySyncDigest(curatedSourceUpdateSchema.parse(update));

const updateSigningPayload = (updateHash: string): Buffer =>
  Buffer.from(`${CURATED_SOURCE_UPDATE_PROTOCOL}:${updateHash}`, "utf8");

export const signCuratedSourceUpdate = (
  update: CuratedSourceUpdateV1,
  signer: Pick<DeviceBoundSourceSigner, "keyId" | "publicKey" | "sign">
): SignedCuratedSourceUpdateV1 => {
  if (
    update.commitmentHash !== curatedSourceCommitmentHash(update.commitment)
  ) {
    throw new TypeError("Curated source update commitment is invalid");
  }
  const updateHash = curatedSourceUpdateHash(update);
  return {
    update,
    attestation: {
      keyId: signer.keyId,
      publicKey: signer.publicKey,
      updateHash,
      signature: signer.sign(updateSigningPayload(updateHash))
    }
  };
};

export const verifyCuratedSourceUpdate = (
  signed: SignedCuratedSourceUpdateV1,
  expected: { keyId: string; publicKey: string }
): boolean => {
  const parsed = signedCuratedSourceUpdateSchema.safeParse(signed);
  if (!parsed.success) return false;
  const update = parsed.data.update as CuratedSourceUpdateV1;
  const attestation = parsed.data.attestation;
  if (
    attestation.keyId !== expected.keyId ||
    attestation.publicKey !== expected.publicKey ||
    update.commitmentHash !== curatedSourceCommitmentHash(update.commitment) ||
    attestation.updateHash !== curatedSourceUpdateHash(update)
  )
    return false;
  const signature = Buffer.from(attestation.signature, "base64url");
  if (
    signature.length !== 64 ||
    signature.toString("base64url") !== attestation.signature
  )
    return false;
  return verify(
    null,
    updateSigningPayload(attestation.updateHash),
    importConversationSourceReplicationPublicKey(attestation.publicKey),
    signature
  );
};
