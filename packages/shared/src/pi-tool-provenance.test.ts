import { describe, expect, it } from "vitest";
import {
  readPiToolProvenance,
  resolvePiToolProvenance
} from "./pi-tool-provenance.js";
const result = (message: Record<string, unknown>) => ({
  sourceKind: "pi",
  sourceEventType: "tool_result",
  rawJson: {
    type: "pi_session_record",
    sourceRecord: { type: "message", message }
  }
});
describe("native Pi tool provenance", () => {
  it("recovers only native identities and rejects conflicting normalized identities", () => {
    const input = result({
      role: "toolResult",
      toolName: "read",
      toolCallId: "call-1"
    });
    expect(
      resolvePiToolProvenance({ ...input, toolName: null, toolCallId: null })
    ).toEqual({ toolName: "read", toolCallId: "call-1" });
    expect(() =>
      resolvePiToolProvenance({ ...input, toolName: "bash", toolCallId: null })
    ).toThrow("contradicts");
    expect(() =>
      resolvePiToolProvenance({
        ...input,
        toolName: "read",
        toolCallId: "other"
      })
    ).toThrow("contradicts");
    expect(readPiToolProvenance({ ...input, sourceKind: "codex" })).toBeNull();
    expect(
      readPiToolProvenance(
        result({ role: "user", toolName: "read", content: "toolResult" })
      )
    ).toBeNull();
    for (const name of ["", " ", "x".repeat(241), null])
      expect(
        readPiToolProvenance(result({ role: "toolResult", toolName: name }))
      ).toBeNull();
  });
  it("reads native calls including retained reference blocks without guessing from arguments", () => {
    const input = {
      sourceKind: "pi",
      sourceEventType: "tool_call",
      rawJson: {
        type: "pi_session_record",
        sourceRecordReference: "native-entry",
        contentBlock: {
          type: "toolCall",
          name: "read",
          id: "call-1",
          arguments: { toolName: "fake" }
        }
      }
    };
    expect(readPiToolProvenance(input)).toEqual({
      toolName: "read",
      toolCallId: "call-1"
    });
    expect(
      readPiToolProvenance({
        ...input,
        rawJson: { ...input.rawJson, sourceRecordReference: "" }
      })
    ).toBeNull();
    expect(
      readPiToolProvenance({
        ...input,
        rawJson: {
          ...input.rawJson,
          sourceRecord: { type: "message", message: { role: "user" } }
        }
      })
    ).toBeNull();
    expect(
      readPiToolProvenance({
        ...input,
        rawJson: {
          ...input.rawJson,
          contentBlock: { type: "text", name: "read" }
        }
      })
    ).toBeNull();
  });
});
