import { describe, expect, it, vi } from "vitest";
import {
  createProjectManagementValidationApi,
  validationId
} from "../../../project-management-validation-api.js";
import { mergeProjectSources } from "../../../project-memory-ui.js";
import { applySuggestions } from "./apply-suggestion.js";
import type { SuggestionRow } from "./use-folder-suggestions.js";

const sessionId = validationId(108);
const gitProject = validationId(2);
const folderProject = validationId(3);

function fixture() {
  const f = createProjectManagementValidationApi();
  const projects = mergeProjectSources(f.inventory(), []);
  const folder = projects.find((p) => p.id === folderProject)!
    .inclusionRules![0]!.target;
  if (folder.kind !== "folder") throw new Error("Missing Folder fixture");
  const originalManage = f.api.manageSourceContext!;
  const manage = vi.spyOn(f.api, "manageSourceContext");
  const confirm = vi.fn(async () => ({ folder: folder.folder }));
  f.api.confirmFolderHint = confirm;
  const row: SuggestionRow = {
    sessionId,
    title: "Historical Conversation",
    proposal: {
      action: "use",
      kind: "worktree-parent",
      folder: folder.folder,
      tier: "medium",
      projects: ["Voice exploration"],
      evidence: []
    }
  };
  return {
    ...f,
    projects,
    row,
    originalManage,
    manage,
    confirm,
    folder: folder.folder
  };
}

describe("applySuggestions", () => {
  it("does not preview or commit when the same-kind Folder changes on re-score", async () => {
    const f = fixture();
    f.confirm.mockRejectedValueOnce(
      new Error("The Folder hint no longer matches.")
    );
    expect(
      await applySuggestions(f.api, f.projects, [f.row], folderProject)
    ).toMatchObject({
      done: 0,
      failed: [expect.stringContaining("no longer matches")]
    });
    expect(f.manage).not.toHaveBeenCalled();
  });

  it("does not commit when the version-pinned preview includes only another Project", async () => {
    const f = fixture();
    expect(
      await applySuggestions(f.api, f.projects, [f.row], gitProject)
    ).toMatchObject({
      done: 0,
      failed: [expect.stringContaining("destination Project")]
    });
    expect(f.manage.mock.calls.map(([input]) => input.action)).toEqual([
      "get",
      "preview"
    ]);
  });

  it("uses the exact Folder and version-pinned preview to add through the destination rule", async () => {
    const f = fixture();
    expect(
      await applySuggestions(f.api, f.projects, [f.row], folderProject)
    ).toEqual({ done: 1, failed: [] });
    expect(f.confirm).toHaveBeenCalledExactlyOnceWith({
      sessionId,
      kind: "worktree-parent",
      folder: f.folder
    });
    expect(f.manage).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "organize",
        edit: expect.objectContaining({
          memberships: [],
          reviewedProjects: expect.arrayContaining([
            { projectId: folderProject, expectedVersion: 1 }
          ]),
          corrections: [
            {
              axis: "folder",
              action: "set",
              folder: f.folder,
              expectedVersion: 1
            }
          ]
        })
      })
    );
    expect(f.inventory().find((p) => p.id === folderProject)?.threads).toEqual(
      expect.arrayContaining([expect.objectContaining({ sessionId })])
    );
  });

  it("counts a failed confirmation without stopping the remaining additions", async () => {
    const f = fixture();
    f.confirm.mockRejectedValueOnce(
      new Error("The Folder hint no longer matches.")
    );
    const rejected = {
      ...f.row,
      sessionId: validationId(109),
      title: "Stale Conversation"
    };
    expect(
      await applySuggestions(
        f.api,
        f.projects,
        [rejected, f.row],
        folderProject
      )
    ).toEqual({
      done: 1,
      failed: ["Stale Conversation: The Folder hint no longer matches."]
    });
    expect(
      f.manage.mock.calls.filter(([input]) => input.action === "organize")
    ).toHaveLength(1);
  });

  it("does not commit if the account or backend changes during preview", async () => {
    const f = fixture();
    let active = true;
    f.manage.mockImplementation(async (input) => {
      const result = await f.originalManage(input);
      if (input.action === "preview") active = false;
      return result;
    });
    await expect(
      applySuggestions(f.api, f.projects, [f.row], folderProject, () => {
        if (!active) throw new Error("Account or backend changed.");
      })
    ).rejects.toThrow("Account or backend changed.");
    expect(f.manage.mock.calls.map(([input]) => input.action)).toEqual([
      "get",
      "preview"
    ]);
  });

  it("preserves the selected portable Git Anchor key without Folder confirmation", async () => {
    const f = fixture();
    const row: SuggestionRow = {
      ...f.row,
      proposal: {
        action: "anchor",
        kind: "repository",
        tier: "medium",
        repositoryKey: "gr_validation_0",
        projects: ["koed"],
        evidence: []
      }
    };
    expect(
      await applySuggestions(f.api, f.projects, [row], gitProject)
    ).toEqual({ done: 1, failed: [] });
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.manage).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "preview",
        correction: expect.objectContaining({
          axis: "git",
          repository: expect.objectContaining({ key: "gr_validation_0" })
        })
      })
    );
  });
});
