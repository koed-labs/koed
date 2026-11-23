import { describe, expect, it } from "vitest";
import {
  leavingWith,
  memberGroups,
  suggestionGroups
} from "./ConversationsPanel.js";
import type {
  ProjectSettingsDraft,
  SettingsConversation,
  SettingsSource
} from "./project-settings-model.js";
import type { SuggestionRow } from "./use-folder-suggestions.js";

const rule = (
  id: string,
  kind: "repository" | "folder",
  inclusionId?: string
): SettingsSource =>
  ({
    id,
    name: id,
    detail: "",
    kind,
    threads: [],
    target:
      kind === "repository"
        ? { kind, repository: { key: `key-${id}` } }
        : { kind, folder: { folderId: id } },
    ...(inclusionId ? { inclusionId } : {})
  }) as unknown as SettingsSource;

const conversation = (
  sessionId: string,
  reasons: { kind: string; inclusionId: string }[],
  excluded = false
): SettingsConversation =>
  ({
    sessionId,
    title: sessionId,
    explanation: {
      sessionId,
      logicalSessionId: sessionId,
      reasons,
      exclusion: excluded
        ? { exclusionId: `x-${sessionId}`, clearedAt: null }
        : null,
      included: reasons.length > 0 && !excluded
    }
  }) as unknown as SettingsConversation;

function draft(
  sources: SettingsSource[],
  conversations: SettingsConversation[],
  selected = sources.map((s) => s.id)
): ProjectSettingsDraft {
  return {
    sources,
    selectedSources: new Set(selected),
    conversations,
    memberships: {}
  } as unknown as ProjectSettingsDraft;
}

describe("memberGroups", () => {
  const git = rule("koed", "repository", "inc-git");
  const folder = rule("scratch", "folder", "inc-folder");
  const both = conversation("both", [
    { kind: "rule", inclusionId: "inc-git" },
    { kind: "rule", inclusionId: "inc-folder" }
  ]);
  const onlyFolder = conversation("folder-only", [
    { kind: "rule", inclusionId: "inc-folder" }
  ]);
  const direct = conversation("direct", [
    { kind: "session", inclusionId: "inc-direct" }
  ]);
  const excludedByRule = conversation(
    "excluded-git",
    [{ kind: "rule", inclusionId: "inc-git" }],
    true
  );
  const excludedAlone = conversation("excluded-alone", [], true);

  it("lists each Conversation once, under its first rule, with direct ones last", () => {
    const groups = memberGroups(
      draft(
        [folder, git],
        [direct, both, onlyFolder, excludedByRule, excludedAlone]
      )
    );
    expect(groups.map((g) => g.key)).toEqual([
      "koed",
      "scratch",
      "direct",
      "excluded"
    ]);
    expect(groups[0]!.members.map((c) => c.sessionId)).toEqual(["both"]);
    expect(groups[0]!.excluded.map((c) => c.sessionId)).toEqual([
      "excluded-git"
    ]);
    expect(groups[1]!.members.map((c) => c.sessionId)).toEqual(["folder-only"]);
    expect(groups[2]!.members.map((c) => c.sessionId)).toEqual(["direct"]);
    expect(groups[3]!.excluded.map((c) => c.sessionId)).toEqual([
      "excluded-alone"
    ]);
  });

  it("moves a Conversation to a rule that stays when its first rule is removed", () => {
    const groups = memberGroups(draft([git, folder], [both], [folder.id]));
    expect(groups.find((g) => g.key === "koed")!.members).toEqual([]);
    expect(groups.find((g) => g.key === "scratch")!.members).toEqual([both]);
  });

  it("counts only the Conversations that leave with a removed rule", () => {
    const d = draft([git, folder], [both, onlyFolder, direct]);
    expect(leavingWith(d, folder)).toBe(1);
    expect(leavingWith(d, git)).toBe(0);
  });
});

describe("suggestionGroups", () => {
  const row = (sessionId: string, key: string): SuggestionRow => ({
    sessionId,
    title: sessionId,
    proposal: {
      action: "anchor",
      kind: "repository",
      repositoryKey: key,
      tier: "medium",
      projects: ["koed"],
      evidence: []
    }
  });

  it("groups suggestions by the rule they would join, largest first, named after it", () => {
    const groups = suggestionGroups(
      draft([rule("koed", "repository", "inc-git")], []),
      [row("a", "key-other"), row("b", "key-koed"), row("c", "key-koed")]
    );
    expect(groups.map((g) => [g.name, g.rows.length])).toEqual([
      ["koed", 2],
      ["Git Anchor", 1]
    ]);
  });
});
