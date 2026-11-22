import { describe, expect, it, vi } from "vitest";
import type { PersonalDesktopApi } from "@koed-labs/shared/personal-desktop";
import type { DesktopProject } from "../../../project-memory-ui.js";
import { applySuggestions } from "./apply-suggestion.js";
import type { SuggestionRow } from "./use-folder-suggestions.js";

vi.mock("./repository-project.js", () => ({
  repositoryTargetFor: (_projects: unknown, key: string) =>
    key === "gr_lyons"
      ? { sourceId: "repo-source", repository: { key } }
      : undefined
}));
vi.mock("./conversation-organization.js", async (original) => ({
  ...(await original<typeof import("./conversation-organization.js")>()),
  organizationEdit: vi.fn(() => ({ edit: true })),
  reviewConversationOrganization: vi.fn(async () => ({
    context: { sessionId: "s", git: { revision: 1 }, folder: { revision: 2 } },
    projects: [],
    memberships: []
  }))
}));
vi.mock("./correction-review.js", () => ({
  reviewSourceCorrections: vi.fn(async (_api, _review, corrections) => ({
    corrections,
    projects: []
  }))
}));

const row = (
  sessionId: string,
  kind: SuggestionRow["proposal"]["kind"],
  repositoryKey?: string
): SuggestionRow => ({
  sessionId,
  title: `Conversation ${sessionId}`,
  proposal: {
    action: kind === "repository" ? "anchor" : "use",
    kind,
    tier: "medium",
    ...(repositoryKey ? { repositoryKey } : {}),
    projects: ["Koed"],
    evidence: []
  }
});
const api = () =>
  ({
    createHintedFolder: vi.fn(async () => ({
      folder: { folderId: "main" },
      normalizedPath: "/work/main"
    })),
    manageSourceContext: vi.fn(async () => ({}))
  }) as unknown as PersonalDesktopApi;
const projects = [] as unknown as DesktopProject[];

describe("applySuggestions", () => {
  it("makes a Folder known, then saves a Folder correction", async () => {
    const a = api();
    expect(
      await applySuggestions(a, projects, [row("a", "worktree-parent")])
    ).toEqual({ done: 1, failed: [] });
    expect(a.createHintedFolder).toHaveBeenCalledWith({
      sessionId: "a",
      kind: "worktree-parent"
    });
    const { reviewSourceCorrections } = await import("./correction-review.js");
    expect(vi.mocked(reviewSourceCorrections).mock.calls.at(-1)?.[2]).toEqual([
      expect.objectContaining({
        axis: "folder",
        action: "set",
        expectedVersion: 2
      })
    ]);
    expect(a.manageSourceContext).toHaveBeenCalledWith(
      expect.objectContaining({ action: "organize", sessionId: "a" })
    );
  });

  it("sets a Git Anchor without registering a Folder", async () => {
    const a = api();
    await applySuggestions(a, projects, [row("b", "repository", "gr_lyons")]);
    expect(a.createHintedFolder).not.toHaveBeenCalled();
    const { reviewSourceCorrections } = await import("./correction-review.js");
    expect(vi.mocked(reviewSourceCorrections).mock.calls.at(-1)?.[2]).toEqual([
      expect.objectContaining({
        axis: "git",
        repository: { key: "gr_lyons" }
      })
    ]);
  });

  it("counts a failure without stopping the rest", async () => {
    const a = api();
    vi.mocked(a.createHintedFolder!).mockRejectedValueOnce(
      new Error("no longer qualifies")
    );
    const result = await applySuggestions(a, projects, [
      row("c", "registered"),
      row("d", "registered"),
      row("e", "repository", "gone")
    ]);
    expect(result.done).toBe(1);
    expect(result.failed).toEqual([
      "Conversation c: no longer qualifies",
      "Conversation e: That Git Anchor is no longer available."
    ]);
  });
});
