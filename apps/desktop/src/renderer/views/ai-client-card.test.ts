import { describe, expect, it } from "vitest";
import { clientVersionLabel } from "./ai-client-card.js";

describe("clientVersionLabel", () => {
  it.each([
    ["codex-cli 0.152.1", "v0.152.1"],
    ["2.1.233 (Claude Code)", "v2.1.233"],
    ["0.84.3", "v0.84.3"],
    ["v1.2.3-beta.1", "v1.2.3-beta.1"],
    ["development build", "development build"]
  ])("normalizes %s for a common client-meta display", (version, expected) => {
    expect(clientVersionLabel(version)).toBe(expected);
  });
});
