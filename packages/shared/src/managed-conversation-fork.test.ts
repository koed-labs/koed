import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign
} from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  MANAGED_CONVERSATION_FORK_PROTOCOL,
  MANAGED_CONVERSATION_FORK_PROTOCOL_V2,
  canonicalManagedConversationForkManifest,
  managedConversationForkAiClientInstanceIdAfterVerification,
  managedConversationForkManifestDigest,
  parseManagedConversationForkManifest,
  verifyManagedConversationForkManifest,
  type ManagedConversationForkManifest
} from "./managed-conversation-fork.js";

const fixture = () => {
  const source = generateKeyPairSync("ed25519");
  const sourceKeyId = randomUUID();
  const targetDeviceId = randomUUID();
  const manifest: ManagedConversationForkManifest = {
    protocol: MANAGED_CONVERSATION_FORK_PROTOCOL_V2,
    operationId: randomUUID(),
    requestDigest: "1".repeat(64),
    ownerUserId: randomUUID(),
    parentExecutionId: randomUUID(),
    parentExecutionGeneration: 3,
    parentLogicalSessionId: randomUUID(),
    logicalSourceId: randomUUID(),
    sourceGenerationId: randomUUID(),
    parentNextSourceGenerationId: randomUUID(),
    parentNextOriginKeyId: randomUUID(),
    sourceClosureHash: "2".repeat(64),
    sourceEndByteCursor: 42_100,
    sourceEndItemCursor: 92,
    provider: "codex",
    aiClientInstanceId: "codex.work",
    providerThreadId: randomUUID(),
    providerArtifactRelativePath:
      "sessions/2026/07/27/rollout-2026-07-27-example.jsonl",
    providerCliVersion: "1.2.3",
    workspaceSnapshotId: randomUUID(),
    workspaceManifestDigest: "3".repeat(64),
    sourceDeploymentId: randomUUID(),
    sourceDeviceId: randomUUID(),
    targetDeploymentId: randomUUID(),
    targetDeviceId,
    nonce: randomBytes(32).toString("base64url"),
    createdAt: "2020-01-01T12:00:00.000Z",
    expiresAt: "2020-01-01T12:10:00.000Z"
  };
  const signed = {
    manifest,
    source: {
      keyId: sourceKeyId,
      signature: sign(
        null,
        Buffer.from(canonicalManagedConversationForkManifest(manifest)),
        source.privateKey
      ).toString("base64url")
    }
  };
  return { source, targetDeviceId, manifest, signed };
};

describe("Managed Conversation fork protocol", () => {
  it("verifies legacy v1 without accepting v2 owner fields", () => {
    const value = fixture();
    const legacyFields = { ...value.manifest };
    delete legacyFields.aiClientInstanceId;
    const manifest: ManagedConversationForkManifest = {
      ...legacyFields,
      protocol: MANAGED_CONVERSATION_FORK_PROTOCOL
    };
    const signed = {
      manifest,
      source: {
        keyId: value.signed.source.keyId,
        signature: sign(
          null,
          Buffer.from(canonicalManagedConversationForkManifest(manifest)),
          value.source.privateKey
        ).toString("base64url")
      }
    };
    expect(
      verifyManagedConversationForkManifest({
        signed,
        sourcePublicKey: value.source.publicKey,
        enforceExpiry: false
      })
    ).toBe(true);
    expect(
      managedConversationForkAiClientInstanceIdAfterVerification({
        manifest,
        verified: true
      })
    ).toBe("codex.default");
  });

  it("verifies an exact signed parent boundary and target", () => {
    const value = fixture();
    expect(value.manifest.aiClientInstanceId).toBe("codex.work");
    expect(
      verifyManagedConversationForkManifest({
        signed: value.signed,
        sourcePublicKey: value.source.publicKey,
        expectedTargetDeviceId: value.targetDeviceId,
        enforceExpiry: false
      })
    ).toBe(true);
    expect(managedConversationForkManifestDigest(value.signed)).toMatch(
      /^[0-9a-f]{64}$/
    );
  });

  it("rejects altered, wrong-target, expired, and non-exact manifests", () => {
    const value = fixture();
    const altered = structuredClone(value.signed);
    altered.manifest.sourceEndByteCursor += 1;
    expect(
      verifyManagedConversationForkManifest({
        signed: altered,
        sourcePublicKey: value.source.publicKey,
        enforceExpiry: false
      })
    ).toBe(false);
    expect(
      verifyManagedConversationForkManifest({
        signed: value.signed,
        sourcePublicKey: value.source.publicKey,
        expectedTargetDeviceId: randomUUID(),
        enforceExpiry: false
      })
    ).toBe(false);
    expect(
      verifyManagedConversationForkManifest({
        signed: value.signed,
        sourcePublicKey: value.source.publicKey
      })
    ).toBe(false);
    expect(() =>
      parseManagedConversationForkManifest({
        ...value.manifest,
        unsupported: true
      })
    ).toThrow(/unknown or missing/);
    expect(() =>
      parseManagedConversationForkManifest({
        ...value.manifest,
        providerArtifactRelativePath: "../outside.jsonl"
      })
    ).toThrow(/invalid/);
  });

  it("binds the parent's successor generation and key into the signature", () => {
    const value = fixture();
    const changedGeneration = structuredClone(value.signed);
    changedGeneration.manifest.parentNextSourceGenerationId = randomUUID();
    const changedKey = structuredClone(value.signed);
    changedKey.manifest.parentNextOriginKeyId = randomUUID();
    for (const signed of [changedGeneration, changedKey]) {
      expect(
        verifyManagedConversationForkManifest({
          signed,
          sourcePublicKey: value.source.publicKey,
          enforceExpiry: false
        })
      ).toBe(false);
    }
  });
});
