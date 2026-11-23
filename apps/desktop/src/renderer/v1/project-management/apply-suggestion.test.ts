import { describe, expect, it, vi } from "vitest";
import {
  createProjectManagementValidationApi,
  validationId
} from "../../../project-management-validation-api.js";
import { mergeProjectSources } from "../../../project-memory-ui.js";
import { applySuggestions } from "./apply-suggestion.js";
import {
  organizationEdit,
  reviewConversationOrganization
} from "./conversation-organization.js";
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
      projects: [{ id: validationId(3), name: "Voice exploration" }],
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

function stagedGitSuggestion(row: SuggestionRow, gitRevision: number) {
  const proposal = {
    action: "anchor" as const,
    kind: "repository" as const,
    tier: "medium" as const,
    repositoryKey: "gr_validation_0",
    gitRevision,
    projects: [{ id: gitProject, name: "koed" }],
    evidence: []
  };
  return { ...row, proposal };
}

describe("applySuggestions", () => {
  it.each(["manual correction", "reset"] as const)(
    "does not preview or overwrite a staged Git Anchor after %s",
    async (intervening) => {
      const f = fixture();
      const correctGit = async (action: "set" | "unresolved" | "reset") => {
        const review = await reviewConversationOrganization(
          f.api,
          f.projects,
          sessionId
        );
        const expectedVersion = review.context.git.revision;
        const other = f.contexts.get(validationId(104))!.git.original;
        if (other.state !== "known") throw new Error("Missing Git Anchor");
        return f.originalManage({
          action: "organize",
          sessionId,
          edit: organizationEdit(
            review,
            [],
            [
              action === "set"
                ? {
                    axis: "git",
                    action,
                    expectedVersion,
                    repository: other.value
                  }
                : { axis: "git", action, expectedVersion }
            ]
          )
        });
      };
      // A reset can make the same candidate available again at a new revision.
      if (intervening === "reset") await correctGit("unresolved");
      const staged = stagedGitSuggestion(
        f.row,
        f.contexts.get(sessionId)!.git.revision
      );
      const changed = await correctGit(
        intervening === "reset" ? "reset" : "set"
      );
      f.manage.mockClear();

      expect(
        await applySuggestions(f.api, f.projects, [staged], gitProject)
      ).toMatchObject({
        done: 0,
        failed: [expect.stringContaining("changed")]
      });
      expect(f.manage.mock.calls.map(([input]) => input.action)).toEqual([
        "get"
      ]);
      const saved = await f.originalManage({ action: "get", sessionId });
      expect(saved.context.git).toEqual(changed.context.git);
    }
  );

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

  it.each(["valid", "missing intent", "changed Project", "wrong destination"])(
    "uses only a guarded version-pinned review for an approved unknown device: %s",
    async (scenario) => {
      const f = fixture();
      const staged = stagedGitSuggestion(f.row, 1);
      const row = {
        ...staged,
        proposal: {
          ...staged.proposal,
          recordingDeviceUnknown: true as const,
          directory: "/work/checkout"
        }
      };
      f.manage.mockImplementation(async (input) => {
        if (input.action === "apply") {
          if (!preview) throw new Error("Missing preview");
          return { context: preview.after, preview };
        }
        const result = await f.originalManage(input);
        if (input.action === "preview" && result.preview) {
          preview = result.preview;
          if (scenario !== "missing intent")
            preview.inferenceIntent = "user-confirmed-unknown";
          if (scenario === "changed Project")
            preview.projects.find((p) => p.projectId === gitProject)!.version++;
        }
        return result;
      });
      let preview: Awaited<ReturnType<typeof f.originalManage>>["preview"];
      const result = await applySuggestions(
        f.api,
        f.projects,
        [row],
        scenario === "wrong destination" ? folderProject : gitProject
      );
      expect(result.done).toBe(scenario === "valid" ? 1 : 0);
      expect(f.manage).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "preview",
          reviewedDirectory: "/work/checkout",
          correction: expect.objectContaining({
            inferenceIntent: "user-confirmed-unknown",
            expectedVersion: 1,
            repository: expect.objectContaining({ key: "gr_validation_0" })
          })
        })
      );
      expect(f.manage.mock.calls.map(([input]) => input.action)).toEqual(
        scenario === "valid" ? ["get", "preview", "apply"] : ["get", "preview"]
      );
    }
  );

  it("preserves the selected portable Git Anchor key without Folder confirmation", async () => {
    const f = fixture();
    const row = stagedGitSuggestion(f.row, 1);
    expect(
      await applySuggestions(f.api, f.projects, [row], gitProject)
    ).toEqual({ done: 1, failed: [] });
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.manage).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "preview",
        correction: expect.objectContaining({
          axis: "git",
          expectedVersion: 1,
          repository: expect.objectContaining({ key: "gr_validation_0" })
        })
      })
    );
  });
});
