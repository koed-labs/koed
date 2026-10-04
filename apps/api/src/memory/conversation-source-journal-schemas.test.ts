import { describe, expect, it } from "vitest";
import {
  conversationSourceArtifactLookupSchema,
  conversationSourceArtifactSchema,
  conversationSourceGenerationLookupSchema,
  conversationSourceRebaseSuccessorSchema
} from "./conversation-source-journal-schemas.js";

const artifact = {
  sourceSession: {
    externalSessionId: "session-1",
    sourceRuntime: "codex-cli",
    captureMethod: "api",
    idempotencyKey: "session-1",
    metadata: {}
  },
  sourceKind: "codex",
  externalSessionId: "session-1",
  sourceFingerprint: "1".repeat(64),
  artifactFormat: "codex_rollout_jsonl",
  artifactFormatVersion: 1,
  journalStartOffset: 0,
  journalStartLine: 0,
  liveStartOffset: 0,
  liveStartLine: 0,
  currentSourceLength: 0,
  sourceCreatedAt: "2026-08-11T00:00:00.000Z",
  redactedSourceLabel: "Conversation source"
} as const;

describe("conversation source journal component schemas", () => {
  it("defaults existing artifacts and lookups to the canonical main component", () => {
    expect(conversationSourceArtifactSchema.parse(artifact)).toMatchObject({
      sourceComponentId: "main",
      sourceComponentRole: "primary",
      parentSourceComponentId: null,
      contentFraming: "jsonl"
    });
    expect(
      conversationSourceArtifactLookupSchema.parse({
        source_kind: "codex",
        external_session_id: "session-1"
      })
    ).toMatchObject({ source_component_id: "main" });
    expect(conversationSourceGenerationLookupSchema.parse({})).toEqual({
      source_component_id: "main"
    });
  });

  it("requires a verified EOF frontier and complete unique history proof for rebases", () => {
    const valid = {
      expectedParentFrontier: {
        sourceGenerationId: "11111111-1111-4111-8111-111111111111",
        providerCursorOffset: 256,
        providerCursorLine: 9,
        lastSegmentDigest: "a".repeat(64)
      },
      successor: {
        sourceGenerationId: "22222222-2222-4222-8222-222222222222",
        sourceFrontier: {
          offset: 512,
          line: 10,
          fileSize: 512,
          prefixSha256: "b".repeat(64),
          modifiedAt: "2026-08-11T00:00:00.000Z"
        }
      },
      commandProof: {
        executionId: "33333333-3333-4333-8333-333333333333",
        executionGeneration: 1,
        commandId: "44444444-4444-4444-8444-444444444444",
        clientUserMessageId: "55555555-5555-4555-8555-555555555555",
        providerThreadId: "thread-1",
        providerHistorySha256: "c".repeat(64),
        canonicalHistorySha256: "d".repeat(64),
        turnIds: ["66666666-6666-4666-8666-666666666666"],
        turnCount: 1,
        messageCount: 2,
        messages: [
          {
            kind: "user",
            clientUserMessageId: "77777777-7777-4777-8777-777777777777",
            turnId: "66666666-6666-4666-8666-666666666666",
            textSha256: "e".repeat(64)
          },
          {
            kind: "assistant",
            turnId: "66666666-6666-4666-8666-666666666666",
            textSha256: "f".repeat(64)
          }
        ],
        terminal: true,
        targetPromptAbsent: true
      }
    } as const;

    expect(conversationSourceRebaseSuccessorSchema.parse(valid)).toEqual(valid);
    expect(() =>
      conversationSourceRebaseSuccessorSchema.parse({
        ...valid,
        successor: {
          ...valid.successor,
          sourceFrontier: { ...valid.successor.sourceFrontier, offset: 511 }
        }
      })
    ).toThrow();
    expect(() =>
      conversationSourceRebaseSuccessorSchema.parse({
        ...valid,
        commandProof: {
          ...valid.commandProof,
          clientUserMessageId:
            valid.commandProof.messages[0]!.clientUserMessageId
        }
      })
    ).toThrow();
    expect(() =>
      conversationSourceRebaseSuccessorSchema.parse({
        ...valid,
        commandProof: { ...valid.commandProof, terminal: false }
      })
    ).toThrow();
  });

  it("accepts Pi persistent session source tuple", () => {
    expect(
      conversationSourceArtifactSchema.parse({
        ...artifact,
        sourceSession: {
          ...artifact.sourceSession,
          sourceRuntime: "pi"
        },
        sourceKind: "pi",
        artifactFormat: "pi_session_jsonl"
      })
    ).toMatchObject({
      sourceKind: "pi",
      sourceSession: { sourceRuntime: "pi" },
      artifactFormat: "pi_session_jsonl"
    });
  });

  it("accepts a parented immutable auxiliary component and rejects bad topology", () => {
    expect(
      conversationSourceArtifactSchema.parse({
        ...artifact,
        sourceComponentId: "attachment.notes",
        sourceComponentRole: "auxiliary",
        parentSourceComponentId: "main",
        contentFraming: "immutable_blob",
        artifactFormat: "claude_attachment_blob"
      })
    ).toMatchObject({
      sourceComponentId: "attachment.notes",
      sourceComponentRole: "auxiliary",
      parentSourceComponentId: "main",
      contentFraming: "immutable_blob"
    });
    expect(() =>
      conversationSourceArtifactSchema.parse({
        ...artifact,
        sourceComponentId: "attachment.notes",
        sourceComponentRole: "auxiliary",
        parentSourceComponentId: null
      })
    ).toThrow();
  });
});
