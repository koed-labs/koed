import { describe, expect, it } from "vitest";
import {
  folderLabel,
  folderLabelText,
  folderSourceLabel
} from "./folder-label.js";

describe("folderLabel", () => {
  it("names a Claude Code worktree after its project, keeping the worktree as detail", () => {
    expect(
      folderLabel("/Users/me/agents/koed/.claude/worktrees/pr-547-local-4a2b")
    ).toEqual({ name: "koed", detail: "worktree pr-547-local-4a2b" });
    expect(
      folderLabelText("/Users/me/agents/koed/.claude/worktrees/task-1/apps/web")
    ).toBe("koed · worktree task-1");
  });

  it("uses the directory name for anything else", () => {
    expect(folderLabel("/Users/me/repos/koed-ai")).toEqual({
      name: "koed-ai"
    });
    expect(folderLabel("/Users/me/repos/koed-ai/")).toEqual({
      name: "koed-ai"
    });
    expect(folderLabel("/")).toEqual({ name: "/" });
  });

  it("drops the device id from a Folder source label", () => {
    expect(
      folderSourceLabel(
        "/Users/me/agents/koed/.claude/worktrees/logo-fix-5c3960 · 83252748-3d8d"
      )
    ).toBe("koed · worktree logo-fix-5c3960");
    expect(folderSourceLabel("/Users/me/repos/api · device")).toBe("api");
    expect(folderSourceLabel("No path recorded")).toBe("No path recorded");
  });
});
