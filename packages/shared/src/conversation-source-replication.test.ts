import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CONVERSATION_SOURCE_REPLICATION_PROTOCOL,
  assertConversationSourceReplicationJsonlSegment,
  assertConversationSourceOriginKeyAcceptsManifest,
  calculateConversationSourceGenerationRegistrationDigest,
  calculateConversationSourceClosureDigest,
  calculateConversationSourceDiscoveryRequestHash,
  calculateConversationSourceDiscoveryScopeHash,
  calculateConversationSourceOriginKeyRegistrationDigest,
  calculateConversationSourceReplicationContentDigest,
  calculateConversationSourceReplicationManifestDigest,
  calculateConversationSourceReplicationOperationDigest,
  calculateConversationSourceReplicationPlaintextDigest,
  calculateConversationSourceRootDigest,
  canonicalizeConversationSourceClosureManifest,
  canonicalizeConversationSourceReplicationManifest,
  exportConversationSourceReplicationPublicKey,
  generateConversationSourceReplicationOriginKeyPair,
  importConversationSourceReplicationPublicKey,
  parseConversationSourceOriginKeyPin,
  parseCanonicalConversationSourceReplicationManifestJson,
  parseConversationSourceOriginKeyRegistration,
  parseConversationSourceClosureManifest,
  parseConversationSourceReplicationManifest,
  parseConversationSourceReplicationSegmentEnvelope,
  parseConversationSourceReplicationSourceDescriptor,
  parseSignedConversationSourceReplicationManifest,
  signConversationSourceClosureManifest,
  signConversationSourceReplicationManifest,
  verifyConversationSourceReplicationManifestForAcceptance,
  verifyConversationSourceClosureManifestSignature,
  verifyConversationSourceReplicationManifestSignature,
  type ConversationSourceOriginKeyPin,
  type ConversationSourceOriginKeyRegistration,
  type ConversationSourceClosureManifest,
  type ConversationSourceReplicationManifest
} from "./conversation-source-replication.js";

const logicalSourceId = "018f47f2-e195-7c5b-a33c-2ef5f7036a11";
const sourceGenerationId = "018f47f2-e195-7c5b-a33c-2ef5f7036a12";
const priorSourceGenerationId = "018f47f2-e195-7c5b-a33c-2ef5f7036a13";
const bytes = Buffer.from('{"type":"message","text":"hello"}\n', "utf8");

const manifestFor = (
  originKeyId: string,
  overrides: Partial<ConversationSourceReplicationManifest> = {}
): ConversationSourceReplicationManifest => ({
  protocol: CONVERSATION_SOURCE_REPLICATION_PROTOCOL,
  logicalSourceId,
  sourceGenerationId,
  originKeyId,
  segmentIndex: 0,
  startByteCursor: 0,
  endByteCursor: bytes.length,
  startItemCursor: 0,
  endItemCursor: 1,
  previousContentDigest: null,
  plaintextDigest: calculateConversationSourceReplicationPlaintextDigest(bytes),
  sourceFormat: "codex-jsonl",
  adapterVersion: "codex-transcript-v1",
  sourceCreatedAt: "2026-07-27T12:34:56.789Z",
  priorGenerationClosure: {
    sourceGenerationId: priorSourceGenerationId,
    contentDigest: "1".repeat(64),
    closedAt: "2026-07-27T12:30:00.000Z"
  },
  ...overrides
});

const registrationFor = (
  originKeyId: string,
  publicKey: string,
  overrides: Partial<ConversationSourceOriginKeyRegistration> = {}
): ConversationSourceOriginKeyRegistration => ({
  protocol: CONVERSATION_SOURCE_REPLICATION_PROTOCOL,
  logicalSourceId,
  sourceGenerationId,
  originKeyId,
  publicKey,
  lifecycle: "active",
  sourceCreatedAt: "2026-07-27T12:34:56.789Z",
  priorGenerationClosure: {
    sourceGenerationId: priorSourceGenerationId,
    contentDigest: "1".repeat(64),
    closedAt: "2026-07-27T12:30:00.000Z"
  },
  ...overrides
});

describe("conversation source replication content protocol", () => {
  it("uses RFC 8785 canonical bytes for deterministic Ed25519 signing and digests", () => {
    const keys = generateConversationSourceReplicationOriginKeyPair();
    const manifest = manifestFor(keys.originKeyId);
    const reordered = Object.fromEntries(
      Object.entries(manifest).reverse()
    ) as unknown as ConversationSourceReplicationManifest;

    const signed = signConversationSourceReplicationManifest(
      reordered,
      keys.privateKey
    );
    const canonical = canonicalizeConversationSourceReplicationManifest(
      signed.manifest
    );

    expect(canonical).toBe(
      '{"adapterVersion":"codex-transcript-v1","endByteCursor":34,"endItemCursor":1,"logicalSourceId":"018f47f2-e195-7c5b-a33c-2ef5f7036a11","originKeyId":"' +
        keys.originKeyId +
        '","plaintextDigest":"1e5205389de552a1a3149a2dc24024dead327d5b4d29a2e8262d0b33f0878969","previousContentDigest":null,"priorGenerationClosure":{"closedAt":"2026-07-27T12:30:00.000Z","contentDigest":"' +
        "1".repeat(64) +
        '","sourceGenerationId":"018f47f2-e195-7c5b-a33c-2ef5f7036a13"},"protocol":"koed.conversation-source-replication/v1","segmentIndex":0,"sourceCreatedAt":"2026-07-27T12:34:56.789Z","sourceFormat":"codex-jsonl","sourceGenerationId":"018f47f2-e195-7c5b-a33c-2ef5f7036a12","startByteCursor":0,"startItemCursor":0}'
    );
    expect(calculateConversationSourceReplicationManifestDigest(manifest)).toBe(
      createHash("sha256").update(canonical).digest("hex")
    );
    expect(
      verifyConversationSourceReplicationManifestSignature(
        signed,
        keys.publicKey
      )
    ).toBe(true);
    expect(
      verifyConversationSourceReplicationManifestSignature(
        signed,
        keys.publicKeyBase64url
      )
    ).toBe(true);
    expect(calculateConversationSourceReplicationContentDigest(signed)).toMatch(
      /^[0-9a-f]{64}$/
    );
  });

  it("generates and round-trips raw Ed25519 public keys", () => {
    const keys = generateConversationSourceReplicationOriginKeyPair();
    expect(keys.originKeyId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(keys.publicKeyBase64url).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(
      exportConversationSourceReplicationPublicKey(
        importConversationSourceReplicationPublicKey(keys.publicKeyBase64url)
      )
    ).toBe(keys.publicKeyBase64url);
  });

  it("binds the complete source descriptor into generation registration", () => {
    const keys = generateConversationSourceReplicationOriginKeyPair();
    const registration = registrationFor(
      keys.originKeyId,
      keys.publicKeyBase64url
    );
    const source = {
      sourceKind: "codex",
      logicalSessionId: "018f47f2-e195-7c5b-a33c-2ef5f7036a16",
      externalSessionId: "session-1",
      forkedFromExternalThreadId: "parent-session-1",
      sourceFingerprint: "2".repeat(64),
      artifactFormat: "codex_rollout_jsonl",
      artifactFormatVersion: 1,
      sourceAdapterVersion: "codex-transcript-v1",
      sourceRuntime: "codex",
      redactedSourceLabel: "Conversation source",
      originDeploymentId: "018f47f2-e195-7c5b-a33c-2ef5f7036a14",
      originDeviceId: "018f47f2-e195-7c5b-a33c-2ef5f7036a15",
      journalStartOffset: 24,
      journalStartLine: 2,
      liveStartOffset: 24,
      liveStartLine: 2,
      project: {
        id: "lp_0123456789abcdef0123456789abcdef",
        name: "Koed"
      }
    } as const;

    expect(parseConversationSourceReplicationSourceDescriptor(source)).toEqual(
      source
    );
    const digest = calculateConversationSourceGenerationRegistrationDigest(
      registration,
      source
    );
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(
      calculateConversationSourceGenerationRegistrationDigest(registration, {
        ...source,
        journalStartOffset: 25,
        liveStartOffset: 25
      })
    ).not.toBe(digest);
    expect(
      calculateConversationSourceGenerationRegistrationDigest(registration, {
        ...source,
        forkedFromExternalThreadId: "different-parent-session"
      })
    ).not.toBe(digest);
    expect(() =>
      parseConversationSourceReplicationSourceDescriptor({
        ...source,
        forkedFromExternalThreadId: undefined
      })
    ).toThrow();
    expect(() =>
      parseConversationSourceReplicationSourceDescriptor({
        ...source,
        liveStartOffset: 23
      })
    ).toThrow("precedes");
  });

  it("rejects malformed, partial, empty, and mismatched JSONL segments", () => {
    expect(() =>
      assertConversationSourceReplicationJsonlSegment(bytes, 1)
    ).not.toThrow();
    expect(() =>
      assertConversationSourceReplicationJsonlSegment(
        Buffer.from('{"ok":true}', "utf8"),
        1
      )
    ).toThrow(/boundary/);
    expect(() =>
      assertConversationSourceReplicationJsonlSegment(
        Buffer.from('{"ok":true}\n\n', "utf8"),
        2
      )
    ).toThrow(/item range/);
    expect(() =>
      assertConversationSourceReplicationJsonlSegment(
        Buffer.from('{"ok":}\n', "utf8"),
        1
      )
    ).toThrow(/malformed/);
    expect(() =>
      assertConversationSourceReplicationJsonlSegment(bytes, 2)
    ).toThrow(/item range/);
  });

  it("binds source discovery pagination into its fresh authorization", () => {
    const request = {
      cursor: {
        updatedAt: "2026-07-27T12:34:56.789Z",
        id: sourceGenerationId
      },
      limit: 50
    };
    expect(calculateConversationSourceDiscoveryScopeHash()).toMatch(
      /^[0-9a-f]{64}$/
    );
    expect(calculateConversationSourceDiscoveryRequestHash(request)).not.toBe(
      calculateConversationSourceDiscoveryRequestHash({
        ...request,
        limit: 51
      })
    );
    expect(() =>
      calculateConversationSourceDiscoveryRequestHash({
        cursor: null,
        limit: 101
      })
    ).toThrow(/limit/);
  });

  it("rejects manifest and signature tampering", () => {
    const keys = generateConversationSourceReplicationOriginKeyPair();
    const signed = signConversationSourceReplicationManifest(
      manifestFor(keys.originKeyId),
      keys.privateKey
    );

    const changedCursor = structuredClone(signed);
    changedCursor.manifest.endByteCursor += 1;
    expect(
      verifyConversationSourceReplicationManifestSignature(
        changedCursor,
        keys.publicKey
      )
    ).toBe(false);

    const changedFormat = structuredClone(signed);
    changedFormat.manifest.sourceFormat = "other-jsonl";
    expect(
      verifyConversationSourceReplicationManifestSignature(
        changedFormat,
        keys.publicKey
      )
    ).toBe(false);

    const changedSignature = structuredClone(signed);
    const signature = Buffer.from(changedSignature.signature, "base64url");
    signature[0] = signature[0]! ^ 1;
    changedSignature.signature = signature.toString("base64url");
    expect(
      verifyConversationSourceReplicationManifestSignature(
        changedSignature,
        keys.publicKey
      )
    ).toBe(false);
  });

  it("strictly rejects unknown, missing, and malformed manifest fields", () => {
    const keys = generateConversationSourceReplicationOriginKeyPair();
    const valid = manifestFor(keys.originKeyId);

    expect(() =>
      parseConversationSourceReplicationManifest({ ...valid, recipientId: "x" })
    ).toThrow("unknown or missing");

    const missing = { ...valid } as Record<string, unknown>;
    delete missing.adapterVersion;
    expect(() => parseConversationSourceReplicationManifest(missing)).toThrow(
      "unknown or missing"
    );

    expect(() =>
      parseConversationSourceReplicationManifest({
        ...valid,
        logicalSourceId: logicalSourceId.toUpperCase()
      })
    ).toThrow("UUID");
    expect(() =>
      parseConversationSourceReplicationManifest({
        ...valid,
        segmentIndex: -1
      })
    ).toThrow("nonnegative");
    expect(() =>
      parseConversationSourceReplicationManifest({
        ...valid,
        startByteCursor: 2,
        endByteCursor: 1
      })
    ).toThrow("must not precede");
    expect(() =>
      parseConversationSourceReplicationManifest({
        ...valid,
        plaintextDigest: "A".repeat(64)
      })
    ).toThrow("lowercase");
    expect(() =>
      parseConversationSourceReplicationManifest({
        ...valid,
        sourceCreatedAt: "2026-07-27"
      })
    ).toThrow("RFC3339");
    expect(() =>
      parseConversationSourceReplicationManifest({
        ...valid,
        protocol: "koed.conversation-source-replication/v0"
      })
    ).toThrow("protocol");
    expect(() =>
      parseConversationSourceReplicationManifest({
        ...valid,
        segmentIndex: 1,
        previousContentDigest: null
      })
    ).toThrow("nonzero segment");
    expect(() =>
      parseConversationSourceReplicationManifest({
        ...valid,
        priorGenerationClosure: {
          ...valid.priorGenerationClosure!,
          relationshipId: "not-signed-content"
        }
      })
    ).toThrow("unknown or missing");
  });

  it("requires canonical JSON when parsing canonical manifest wire bytes", () => {
    const keys = generateConversationSourceReplicationOriginKeyPair();
    const manifest = manifestFor(keys.originKeyId);
    const canonical =
      canonicalizeConversationSourceReplicationManifest(manifest);

    expect(
      parseCanonicalConversationSourceReplicationManifestJson(canonical)
    ).toEqual(manifest);
    expect(() =>
      parseCanonicalConversationSourceReplicationManifestJson(` ${canonical}`)
    ).toThrow("RFC 8785");
    expect(() =>
      parseCanonicalConversationSourceReplicationManifestJson(
        JSON.stringify(manifest)
      )
    ).toThrow("RFC 8785");
  });

  it("pins origin identity and rejects new acceptance after key loss or revocation", () => {
    const keys = generateConversationSourceReplicationOriginKeyPair();
    const manifest = manifestFor(keys.originKeyId);
    const signed = signConversationSourceReplicationManifest(
      manifest,
      keys.privateKey
    );
    const active = registrationFor(keys.originKeyId, keys.publicKeyBase64url);

    expect(
      verifyConversationSourceReplicationManifestForAcceptance(signed, active)
    ).toBe(true);
    expect(() =>
      assertConversationSourceOriginKeyAcceptsManifest(
        { ...active, lifecycle: "lost" },
        manifest
      )
    ).toThrow("rejects new segment acceptance");
    expect(() =>
      verifyConversationSourceReplicationManifestForAcceptance(signed, {
        ...active,
        lifecycle: "revoked"
      })
    ).toThrow("rejects new segment acceptance");
    expect(() =>
      assertConversationSourceOriginKeyAcceptsManifest(
        {
          ...active,
          sourceGenerationId: priorSourceGenerationId
        },
        manifest
      )
    ).toThrow("pinned");
  });

  it("validates authority registration and rejects unknown lifecycle fields", () => {
    const keys = generateConversationSourceReplicationOriginKeyPair();
    const registration = registrationFor(
      keys.originKeyId,
      keys.publicKeyBase64url
    );
    expect(parseConversationSourceOriginKeyRegistration(registration)).toEqual(
      registration
    );
    expect(
      calculateConversationSourceOriginKeyRegistrationDigest(registration)
    ).toMatch(/^[0-9a-f]{64}$/);
    const pin = Object.fromEntries(
      Object.entries(registration).filter(([key]) => key !== "lifecycle")
    ) as unknown as ConversationSourceOriginKeyPin;
    expect(parseConversationSourceOriginKeyPin(pin)).toEqual(pin);
    expect(() =>
      parseConversationSourceOriginKeyPin({ ...pin, lifecycle: "active" })
    ).toThrow("unknown or missing");
    expect(() =>
      parseConversationSourceOriginKeyRegistration({
        ...registration,
        lifecycle: "rotated"
      })
    ).toThrow("lifecycle");
    expect(() =>
      parseConversationSourceOriginKeyRegistration({
        ...registration,
        recipientId: "recipient-specific"
      })
    ).toThrow("unknown or missing");
  });

  it("keeps recipient metadata outside content envelopes and detects byte tampering", () => {
    const keys = generateConversationSourceReplicationOriginKeyPair();
    const signedManifest = signConversationSourceReplicationManifest(
      manifestFor(keys.originKeyId),
      keys.privateKey
    );
    const envelope = {
      signedManifest,
      plaintextBytes: bytes.toString("base64url")
    };

    expect(parseConversationSourceReplicationSegmentEnvelope(envelope)).toEqual(
      envelope
    );
    expect(() =>
      parseConversationSourceReplicationSegmentEnvelope({
        ...envelope,
        recipientId: "recipient-a",
        relationshipId: "relationship-a"
      })
    ).toThrow("unknown or missing");
    expect(() =>
      parseConversationSourceReplicationSegmentEnvelope({
        ...envelope,
        plaintextBytes: Buffer.from("tampered").toString("base64url")
      })
    ).toThrow("plaintext digest");
    expect(() =>
      parseSignedConversationSourceReplicationManifest({
        ...signedManifest,
        keyEpoch: 2
      })
    ).toThrow("unknown or missing");

    const digest = calculateConversationSourceReplicationContentDigest(
      envelope.signedManifest
    );
    expect(
      calculateConversationSourceReplicationContentDigest({
        ...envelope.signedManifest
      })
    ).toBe(digest);
  });

  it("derives stable operation idempotency from signed content identity", () => {
    const input = {
      operationId: "018f47f2-e195-7c5b-a33c-2ef5f7036a14",
      operationKind: "append_segment" as const,
      logicalSourceId,
      sourceGenerationId,
      contentDigest: createHash("sha256").update("content").digest("hex"),
      targetDeploymentId: "018f47f2-e195-7c5b-a33c-2ef5f7036a15"
    };
    const digest = calculateConversationSourceReplicationOperationDigest(input);
    expect(calculateConversationSourceReplicationOperationDigest(input)).toBe(
      digest
    );
    expect(
      calculateConversationSourceReplicationOperationDigest({
        ...input,
        operationKind: "register_generation"
      })
    ).not.toBe(digest);
    expect(
      calculateConversationSourceReplicationOperationDigest({
        ...input,
        operationKind: "close_generation"
      })
    ).not.toBe(digest);
  });

  it("signs a terminal closure over the exact ordered source chain", () => {
    const keys = generateConversationSourceReplicationOriginKeyPair();
    const contentDigests = [
      createHash("sha256").update("segment-0").digest("hex"),
      createHash("sha256").update("segment-1").digest("hex")
    ];
    const manifest: ConversationSourceClosureManifest = {
      protocol: CONVERSATION_SOURCE_REPLICATION_PROTOCOL,
      logicalSourceId,
      sourceGenerationId,
      originKeyId: keys.originKeyId,
      segmentCount: contentDigests.length,
      endByteCursor: 72,
      endItemCursor: 2,
      chainHeadDigest: contentDigests.at(-1)!,
      sourceRootDigest: calculateConversationSourceRootDigest(contentDigests),
      sourceCreatedAt: "2026-07-27T12:34:56.789Z",
      closedAt: "2026-07-27T12:35:00.000Z",
      priorGenerationClosure: {
        sourceGenerationId: priorSourceGenerationId,
        contentDigest: "1".repeat(64),
        closedAt: "2026-07-27T12:30:00.000Z"
      }
    };
    const signed = signConversationSourceClosureManifest(
      manifest,
      keys.privateKey
    );

    expect(parseConversationSourceClosureManifest(manifest)).toEqual(manifest);
    expect(canonicalizeConversationSourceClosureManifest(manifest)).toContain(
      `"sourceRootDigest":"${manifest.sourceRootDigest}"`
    );
    expect(
      verifyConversationSourceClosureManifestSignature(signed, keys.publicKey)
    ).toBe(true);
    expect(calculateConversationSourceClosureDigest(signed)).toMatch(
      /^[0-9a-f]{64}$/
    );

    const tampered = structuredClone(signed);
    tampered.manifest.endItemCursor += 1;
    expect(
      verifyConversationSourceClosureManifestSignature(tampered, keys.publicKey)
    ).toBe(false);
    expect(() =>
      parseConversationSourceClosureManifest({
        ...manifest,
        segmentCount: 0
      })
    ).toThrow(/inconsistent/);
    expect(calculateConversationSourceRootDigest([])).toMatch(/^[0-9a-f]{64}$/);
  });
});
