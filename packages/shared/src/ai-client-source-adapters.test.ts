import { describe, expect, it } from "vitest";
import {
  aiClientSourceAdapterRegistry,
  assertSupportedAiClientSourceAdapter,
  isPrivacyMaterializationSourceAdapter,
  isSupportedAiClientSourceAdapter,
  resolveAiClientSourceAdapter
} from "./ai-client-source-adapters.js";

describe("AI-client source adapter registry", () => {
  it("contains supported Codex, Claude Code, and Pi tuples", () => {
    expect(aiClientSourceAdapterRegistry).toEqual([
      {
        sourceKind: "codex",
        sourceRuntime: "codex",
        artifactFormat: "codex_rollout_jsonl",
        artifactFormatVersion: 1,
        sourceAdapterVersion: "codex-transcript-v1"
      },
      {
        sourceKind: "codex",
        sourceRuntime: "codex-cli",
        artifactFormat: "codex_rollout_jsonl",
        artifactFormatVersion: 1,
        sourceAdapterVersion: "codex-transcript-v1"
      },
      {
        sourceKind: "claude-code",
        sourceRuntime: "claude-code",
        artifactFormat: "claude_session_jsonl",
        artifactFormatVersion: 1,
        sourceAdapterVersion: "claude-code-transcript-v1"
      },
      {
        sourceKind: "pi",
        sourceRuntime: "pi",
        artifactFormat: "pi_session_jsonl",
        artifactFormatVersion: 1,
        sourceAdapterVersion: "pi-session-v1"
      }
    ]);
    expect(Object.isFrozen(aiClientSourceAdapterRegistry)).toBe(true);
    expect(
      aiClientSourceAdapterRegistry.every((adapter) => Object.isFrozen(adapter))
    ).toBe(true);
  });

  it("limits Team source sanitization to the implemented Codex format", () => {
    expect(
      isPrivacyMaterializationSourceAdapter({
        sourceKind: "codex",
        artifactFormat: "codex_rollout_jsonl",
        artifactFormatVersion: 1
      })
    ).toBe(true);
    expect(
      isPrivacyMaterializationSourceAdapter({
        sourceKind: "claude-code",
        artifactFormat: "claude_session_jsonl",
        artifactFormatVersion: 1
      })
    ).toBe(false);
    expect(
      isPrivacyMaterializationSourceAdapter({
        sourceKind: "pi",
        artifactFormat: "pi_session_jsonl",
        artifactFormatVersion: 1
      })
    ).toBe(false);
  });

  it("resolves complete tuples and rejects mixed or unknown adapters", () => {
    const claude = {
      sourceKind: "claude-code",
      sourceRuntime: "claude-code",
      artifactFormat: "claude_session_jsonl",
      artifactFormatVersion: 1,
      sourceAdapterVersion: "claude-code-transcript-v1"
    } as const;

    expect(resolveAiClientSourceAdapter(claude)).toEqual(claude);
    expect(isSupportedAiClientSourceAdapter(claude)).toBe(true);
    expect(
      isSupportedAiClientSourceAdapter({
        ...claude,
        artifactFormat: "codex_rollout_jsonl"
      })
    ).toBe(false);
    expect(() =>
      assertSupportedAiClientSourceAdapter({
        ...claude,
        sourceAdapterVersion: "future-adapter-v2"
      })
    ).toThrow("unsupported");
  });
});
