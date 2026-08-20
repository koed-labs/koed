import { describe, expect, it } from "vitest";
import {
  conversationSourceArtifactLookupSchema,
  conversationSourceArtifactSchema,
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
