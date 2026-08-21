import { describe, expect, it } from "vitest";
import {
  CODEX_GUIDANCE_MARKER_END,
  CODEX_GUIDANCE_MARKER_START,
  inspectManagedCodexGuidance,
  removeManagedCodexGuidance,
  reconcileManagedCodexGuidance,
  renderManagedCodexGuidance,
  resolveCodexGlobalInstructionsPath
} from "./codex-global-instructions.js";

const guidance = "# Koed Memory\n\nConsult Koed when prior work could help.";

describe("Codex global instructions", () => {
  it("adds one managed block while preserving user instructions", () => {
    const result = reconcileManagedCodexGuidance("# User rules\n", guidance);
    expect(result).toBe(
      `# User rules\n\n\n${renderManagedCodexGuidance(guidance)}\n`
    );
    expect(inspectManagedCodexGuidance(result, guidance)).toBe("current");
  });

  it("updates only stale managed guidance and remains idempotent", () => {
    const existing = `Before\n\n${renderManagedCodexGuidance("old")}\n\nAfter\n`;
    const updated = reconcileManagedCodexGuidance(existing, guidance);
    expect(updated).toBe(
      `Before\n\n${renderManagedCodexGuidance(guidance)}\n\nAfter\n`
    );
    expect(reconcileManagedCodexGuidance(updated, guidance)).toBe(updated);
  });

  it("removes only the managed block and remains idempotent", () => {
    const original = "Before  \n    indented rule\n";
    const existing = reconcileManagedCodexGuidance(original, guidance);
    const removed = removeManagedCodexGuidance(existing);
    expect(removed).toBe(original);
    expect(removeManagedCodexGuidance(removed)).toBe(removed);
  });

  it("preserves hard breaks and indented content around the managed block", () => {
    const before = "Before  \n";
    const after = "    indented code\n";
    const existing = `${before}\n\n${renderManagedCodexGuidance(guidance)}\n${after}`;
    expect(removeManagedCodexGuidance(existing)).toBe(`${before}${after}`);
  });

  it.each([
    `${CODEX_GUIDANCE_MARKER_START}\nbroken`,
    `${CODEX_GUIDANCE_MARKER_END}\nbroken`,
    `${CODEX_GUIDANCE_MARKER_START}\na\n${CODEX_GUIDANCE_MARKER_START}\nb\n${CODEX_GUIDANCE_MARKER_END}`,
    `${CODEX_GUIDANCE_MARKER_END}\nwrong order\n${CODEX_GUIDANCE_MARKER_START}`
  ])("rejects malformed managed markers", (content) => {
    expect(inspectManagedCodexGuidance(content, guidance)).toBe("malformed");
    expect(() => reconcileManagedCodexGuidance(content, guidance)).toThrow(
      "malformed Koed guidance markers"
    );
    expect(() => removeManagedCodexGuidance(content)).toThrow(
      "malformed Koed guidance markers"
    );
  });

  it("resolves global instructions beside an explicit Codex config", () => {
    expect(
      resolveCodexGlobalInstructionsPath({
        CODEX_CONFIG_PATH: "/profiles/alice/config.toml"
      })
    ).toBe("/profiles/alice/AGENTS.md");
  });
});
