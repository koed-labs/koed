import { describe, expect, it } from "vitest";
import {
  sourceDownloadAuthorizationSchema,
  sourceDiscoveryResultItemSchema,
  sourceGenerationRegistrationPayloadSchema
} from "./schemas.js";

const sourceDescriptor = {
  sourceKind: "codex",
  sourceComponentSchemaVersion: 1,
  sourceComponentId: "main",
  sourceComponentRole: "primary",
  parentSourceComponentId: null,
  contentFraming: "jsonl",
  logicalSessionId: "018f47f2-e195-7c5b-a33c-2ef5f7036a16",
  externalSessionId: "session-1",
  forkedFromExternalThreadId: null,
  sourceFingerprint: "2".repeat(64),
  artifactFormat: "codex_rollout_jsonl",
  artifactFormatVersion: 1,
  sourceAdapterVersion: "codex-transcript-v1",
  sourceRuntime: "codex",
  redactedSourceLabel: "Conversation source",
  originDeploymentId: "018f47f2-e195-7c5b-a33c-2ef5f7036a14",
  originDeviceId: "018f47f2-e195-7c5b-a33c-2ef5f7036a15",
  journalStartOffset: 0,
  journalStartLine: 0,
  liveStartOffset: 0,
  liveStartLine: 0,
  project: null
} as const;

const registrationPayload = (source: Record<string, unknown>) => ({
  protocol: "koed.conversation-source-replication/v1",
  operation: "register_generation",
  registration: {},
  source
});

describe("Conversation Source replication schemas", () => {
  it("accepts each exact Codex V1 runtime tuple", () => {
    expect(
      sourceGenerationRegistrationPayloadSchema.safeParse(
        registrationPayload(sourceDescriptor)
      ).success
    ).toBe(true);
    expect(
      sourceGenerationRegistrationPayloadSchema.safeParse(
        registrationPayload({
          ...sourceDescriptor,
          sourceRuntime: "codex-cli"
        })
      ).success
    ).toBe(true);
  });

  it("accepts the exact Claude Code V1 tuple", () => {
    expect(
      sourceGenerationRegistrationPayloadSchema.safeParse(
        registrationPayload({
          ...sourceDescriptor,
          sourceKind: "claude-code",
          sourceRuntime: "claude-code",
          artifactFormat: "claude_session_jsonl",
          sourceAdapterVersion: "claude-code-transcript-v1"
        })
      ).success
    ).toBe(true);
  });

  it("rejects mixed tuples and unknown adapters", () => {
    for (const source of [
      { ...sourceDescriptor, sourceRuntime: "claude-code" },
      {
        ...sourceDescriptor,
        sourceKind: "claude-code",
        sourceRuntime: "claude-code",
        sourceComponentId: "main",
        artifactFormat: "codex_rollout_jsonl",
        sourceAdapterVersion: "claude-code-transcript-v1"
      },
      { ...sourceDescriptor, sourceAdapterVersion: "future-adapter-v2" }
    ]) {
      expect(
        sourceGenerationRegistrationPayloadSchema.safeParse(
          registrationPayload(source)
        ).success
      ).toBe(false);
    }
  });

  it("returns Claude Code sources from discovery", () => {
    expect(
      sourceDiscoveryResultItemSchema.safeParse({
        sourceGenerationId: "018f47f2-e195-7c5b-a33c-2ef5f7036a12",
        redactedSourceLabel: "Conversation source",
        sourceRuntime: "claude-code",
        sourceComponentId: "main",
        sourceCreatedAt: "2026-07-27T12:34:56.789Z",
        sourceModifiedAt: null,
        currentSourceLength: 42,
        segmentCount: 1
      }).success
    ).toBe(true);
  });

  it("requires an exact component for source download authorization", () => {
    const input = {
      sourceGenerationId: "018f47f2-e195-7c5b-a33c-2ef5f7036a12",
      sourceComponentId: "agent.researcher",
      targetDeploymentId: "018f47f2-e195-7c5b-a33c-2ef5f7036a13",
      firstSegmentIndex: 0,
      recipientKey: {
        algorithm: "RSA-OAEP-SHA256",
        keyId: "sync-recipient:test",
        keyVersion: 1,
        publicJwk: {
          kty: "RSA",
          n: "test-modulus",
          e: "AQAB",
          alg: "RSA-OAEP-256",
          key_ops: ["encrypt"],
          ext: true,
          kid: "sync-recipient:test",
          use: "enc"
        }
      }
    };

    expect(sourceDownloadAuthorizationSchema.safeParse(input).success).toBe(
      true
    );
    const withoutComponent = { ...input } as Partial<typeof input>;
    delete withoutComponent.sourceComponentId;
    expect(
      sourceDownloadAuthorizationSchema.safeParse(withoutComponent).success
    ).toBe(false);
  });
});
