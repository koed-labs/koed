import { randomBytes, randomUUID } from "node:crypto";
import {
  createEncryptedJsonPackage,
  createLocalTestKeyEnvelopeEncryptionProvider,
  createRecipientPublicKeyEnvelopeEncryptionProvider,
  generateRecipientKeyMaterial,
  toRecipientPublicKeyMaterial
} from "@koed/shared";
import { describe, expect, it } from "vitest";
import { uploadChunkSchema } from "./schemas.js";

const encryptedSyncChunk = async () => {
  const rootProvider = createLocalTestKeyEnvelopeEncryptionProvider(
    randomBytes(32).toString("base64")
  );
  const deploymentId = randomUUID();
  const targetUserId = randomUUID();
  const relationshipId = randomUUID();
  const protocolPackageId = randomUUID();
  const material = await generateRecipientKeyMaterial(rootProvider, {
    keyId: `sync-recipient:${deploymentId}`,
    keyVersion: 1
  });
  const provider = createRecipientPublicKeyEnvelopeEncryptionProvider(
    toRecipientPublicKeyMaterial(material)
  );
  const encryptedPackage = await createEncryptedJsonPackage(provider, {
    objectClass: "sync_package",
    payload: { format: "koed.captured-session-sync", formatVersion: 1 },
    scope: { deploymentId, tenantId: targetUserId },
    provenance: {
      rowFamily: "sync_package",
      sourceId: protocolPackageId
    },
    aad: {
      relationshipId,
      packageId: protocolPackageId,
      packageSequence: 1,
      chunkIndex: 0,
      chunkCount: 1,
      sourceDeploymentId: randomUUID(),
      targetDeploymentId: deploymentId
    },
    metadata: { formatVersion: 1, chunkIndex: 0, chunkCount: 1 }
  });
  return {
    checksum_sha256: "a".repeat(64),
    byte_count: Buffer.byteLength(JSON.stringify(encryptedPackage), "utf8"),
    encrypted_package: encryptedPackage
  };
};

describe("Cross-Identity Sync upload schemas", () => {
  it("accepts the exact encrypted sync package contract", async () => {
    expect(uploadChunkSchema.parse(await encryptedSyncChunk())).toBeDefined();
  });

  it("rejects unknown manifest fields and malformed ciphertext", async () => {
    const input = await encryptedSyncChunk();
    expect(() =>
      uploadChunkSchema.parse({
        ...input,
        encrypted_package: {
          ...input.encrypted_package,
          manifest: {
            ...input.encrypted_package.manifest,
            plaintext: "must never be accepted"
          }
        }
      })
    ).toThrow();
    expect(() =>
      uploadChunkSchema.parse({
        ...input,
        encrypted_package: {
          ...input.encrypted_package,
          envelope: {
            ...input.encrypted_package.envelope,
            ciphertext: "not base64!"
          }
        }
      })
    ).toThrow();
  });
});
