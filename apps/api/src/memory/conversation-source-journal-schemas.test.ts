import { describe, expect, it } from "vitest";
import {
  conversationSourceArtifactLookupSchema,
  conversationSourceArtifactSchema,
  conversationSourceCursorSchema,
  conversationSourceGenerationLookupSchema
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
  it("accepts canonical paginated checkpoint initialization at its live boundary", () => {
    const checkpoint = {
      consumerKind: "canonical_live",
      expectedSourceOffset: 200,
      sourceOffset: 200,
      sourceLine: 2,
      segmentIndex: 0,
      lastVerifiedDigest: "1".repeat(64),
      parserState: { historyMode: "paginated", lastRecordOrdinal: 2 }
    };
    expect(conversationSourceCursorSchema.parse(checkpoint)).toEqual(
      checkpoint
    );
    expect(
      conversationSourceCursorSchema.parse({ ...checkpoint, sourceOffset: 300 })
    ).toMatchObject({ sourceOffset: 300 });
    for (const input of [
      { ...checkpoint, sourceOffset: 100 },
      { ...checkpoint, consumerKind: "remote_processing" },
      { ...checkpoint, parserState: {} },
      { ...checkpoint, parserState: { historyMode: "legacy" } }
    ]) {
      expect(conversationSourceCursorSchema.safeParse(input).success).toBe(
        false
      );
    }
  });
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
