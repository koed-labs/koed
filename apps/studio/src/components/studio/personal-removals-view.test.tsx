import { describe, expect, it } from "vitest";
import {
  hasConversationRemoval,
  hasProjectRemoval,
  managedConversationRemovalTarget
} from "./personal-removals-view";
import {
  applyPersonalRemoval,
  personalRemovalsLoadMayApply
} from "./personal-removals-state";

describe("Personal removal browsing filters", () => {
  it("scopes project removal to the matching Project", () => {
    expect(
      hasProjectRemoval(
        [{ kind: "project", projectId: "project-a" }],
        "project-a"
      )
    ).toBe(true);
    expect(
      hasProjectRemoval(
        [{ kind: "project", projectId: "project-a" }],
        "project-b"
      )
    ).toBe(false);
  });

  it("matches conversation removals by source ID and alias", () => {
    const removals = [
      {
        kind: "conversation" as const,
        sourceId: "managed:execution-a",
        aliases: ["codex:thread-a"]
      }
    ];
    expect(hasConversationRemoval(removals, ["codex:thread-a"])).toBe(true);
    expect(hasConversationRemoval(removals, ["managed:execution-a"])).toBe(
      true
    );
    expect(hasConversationRemoval(removals, ["codex:thread-b"])).toBe(false);
  });

  it("keeps managed and provider source IDs linked for later filtering", () => {
    expect(
      managedConversationRemovalTarget({
        executionId: "execution-a",
        providerSourceIds: ["codex:thread-a", "codex:thread-alias"]
      })
    ).toEqual({
      kind: "conversation",
      sourceId: "codex:thread-a",
      aliases: ["managed:execution-a", "codex:thread-alias"]
    });
    expect(
      managedConversationRemovalTarget({ executionId: "execution-b" })
    ).toEqual({ kind: "conversation", sourceId: "managed:execution-b" });
  });

  it("preserves successive removals and rejects an older initial load", () => {
    const initial = [{ kind: "project" as const, projectId: "project-a" }];
    const afterFirst = applyPersonalRemoval(
      initial,
      { kind: "conversation", sourceId: "codex:thread-a" },
      true
    );
    const afterSecond = applyPersonalRemoval(
      afterFirst,
      { kind: "conversation", sourceId: "managed:execution-b" },
      true
    );

    expect(afterSecond).toHaveLength(3);
    expect(personalRemovalsLoadMayApply(2, 3)).toBe(false);
    expect(personalRemovalsLoadMayApply(3, 3)).toBe(true);
  });
});
