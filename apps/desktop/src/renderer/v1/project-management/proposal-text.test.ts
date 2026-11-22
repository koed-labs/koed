import { describe, expect, it } from "vitest";
import {
  folderProposal,
  type FolderProposal
} from "./folder-hint-suggestion.js";
import {
  evidenceLines,
  proposalLead,
  proposalNote,
  shortPath
} from "./proposal-text.js";

const proposal = (overrides: Partial<FolderProposal>): FolderProposal => ({
  action: "anchor",
  kind: "repository",
  tier: "medium",
  directory: "/Users/someone/repos/koed-ai",
  projects: ["koed-ai"],
  evidence: [],
  ...overrides
});

describe("proposal text", () => {
  it("shortens the home folder and cuts the middle of a long path", () => {
    expect(shortPath("/Users/someone/repos/koed-ai")).toBe("~/repos/koed-ai");
    expect(shortPath("/home/someone")).toBe("~");
    const long = shortPath(
      "/Users/someone/agents/koed/.claude/worktrees/a-very-long-task-name-here"
    );
    expect(long.length).toBe(44);
    expect(long).toContain("…");
    expect(long.endsWith("a-very-long-task-name-here")).toBe(true);
  });

  it("leads with the reason and names the Project", () => {
    expect(proposalLead(proposal({}))).toBe("Same Git remote as koed-ai");
    expect(
      proposalLead(
        proposal({
          kind: "worktree-parent",
          action: "use",
          directory: "/w/koed"
        })
      )
    ).toBe("Worktree of koed");
    expect(
      proposalLead(proposal({ kind: "create", action: "create", projects: [] }))
    ).toBe("New Folder for ~/repos/koed-ai");
  });

  it("keeps each piece of evidence short, with the path or Git Anchor as detail", () => {
    expect(
      evidenceLines(
        proposal({ evidence: ["directory-remote", "directory-birthtime"] }),
        { anchor: "github.com/org/koed-ai" }
      )
    ).toEqual([
      { text: "~/repos/koed-ai", detail: "→ github.com/org/koed-ai" },
      { text: "Folder existed before this conversation" }
    ]);
    expect(
      evidenceLines(
        proposal({
          kind: "worktree-parent",
          directory: "/Users/someone/agents/koed",
          evidence: ["worktree-link-recorded"]
        }),
        { client: "Claude Code" }
      )
    ).toEqual([
      {
        text: "Claude Code recorded it as a worktree of",
        detail: "~/agents/koed"
      }
    ]);
  });

  it("orders evidence strongest first and drops weak evidence beside strong", () => {
    const made = folderProposal([
      {
        sessionId: "00000000-0000-4000-8000-000000000001",
        tier: "medium",
        score: 5,
        kind: "create",
        directory: "/w/x",
        reasons: [
          { code: "directory-activity", outcome: "agrees" },
          { code: "directory-birthtime", outcome: "agrees" },
          { code: "git-remote", outcome: "agrees" }
        ]
      }
    ]);
    expect(made?.evidence).toEqual(["git-remote", "directory-birthtime"]);
  });

  it("adds a note only when accepting registers a new folder", () => {
    expect(proposalNote(proposal({}), "bulk")).toBeUndefined();
    expect(
      proposalNote(proposal({ action: "create", kind: "create" }), "bulk")
    ).toBe("Adding it registers this folder on this device.");
    expect(
      proposalNote(proposal({ action: "create", kind: "create" }), "single")
    ).toBe("Using it registers this folder on this device.");
  });
});
