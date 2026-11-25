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
const scope = "a".repeat(64);

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
      folderRevision: 1,
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
        await applySuggestions(f.api, f.projects, [staged], gitProject, scope)
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

  it.each(["unresolved", "set"] as const)(
    "does not overwrite a newer Folder correction (%s)",
    async (action) => {
      const f = fixture();
      const other = f.contexts.get(validationId(100))!.folder.original;
      if (other.state !== "known") throw new Error("Missing Folder fixture");
      const review = await reviewConversationOrganization(
        f.api,
        f.projects,
        sessionId
      );
      const changed = await f.originalManage({
        action: "organize",
        sessionId,
        edit: organizationEdit(
          review,
          [],
          [
            action === "unresolved"
              ? { axis: "folder", action, expectedVersion: 1 }
              : {
                  axis: "folder",
                  action,
                  expectedVersion: 1,
                  folder: other.value.reference
                }
          ]
        )
      });
      f.manage.mockClear();

      expect(
        await applySuggestions(f.api, f.projects, [f.row], folderProject, scope)
      ).toMatchObject({
        done: 0,
        failed: [expect.stringContaining("Folder changed")]
      });
      expect(f.manage.mock.calls.map(([input]) => input.action)).toEqual([
        "get"
      ]);
      expect(
        (await f.originalManage({ action: "get", sessionId })).context.folder
      ).toEqual(changed.context.folder);
    }
  );

  it("does not preview or commit when the same-kind Folder changes on re-score", async () => {
    const f = fixture();
    f.confirm.mockRejectedValueOnce(
      new Error("The Folder hint no longer matches.")
    );
    expect(
      await applySuggestions(f.api, f.projects, [f.row], folderProject, scope)
    ).toMatchObject({
      done: 0,
      failed: [expect.stringContaining("no longer matches")]
    });
    expect(f.manage).not.toHaveBeenCalled();
  });

  it("does not commit when the version-pinned preview includes only another Project", async () => {
    const f = fixture();
    expect(
      await applySuggestions(f.api, f.projects, [f.row], gitProject, scope)
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
      await applySuggestions(f.api, f.projects, [f.row], folderProject, scope)
    ).toEqual({ done: 1, failed: [] });
    expect(f.confirm).toHaveBeenCalledExactlyOnceWith({
      sessionId,
      kind: "worktree-parent",
      folder: f.folder,
      expectedScopeKey: scope
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
        folderProject,
        scope
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
      applySuggestions(f.api, f.projects, [f.row], folderProject, scope, () => {
        if (!active) throw new Error("Account or backend changed.");
      })
    ).rejects.toThrow("Account or backend changed.");
    expect(f.manage.mock.calls.map(([input]) => input.action)).toEqual([
      "get",
      "preview"
    ]);
  });

  it.each([
    "valid",
    "importer-only",
    "checkout gone",
    "missing intent",
    "changed Project",
    "wrong destination"
  ])(
    "uses only a guarded version-pinned review for an approved unknown device: %s",
    async (scenario) => {
      const f = fixture();
      const staged = stagedGitSuggestion(f.row, 1);
      const intent =
        scenario === "importer-only"
          ? ("assumed-local-import" as const)
          : ("user-confirmed-unknown" as const);
      const incarnation = "a".repeat(64);
      const saved = scenario === "valid" || scenario === "importer-only";
      const row = {
        ...staged,
        proposal: {
          ...staged.proposal,
          manualGitReview: { intent, incarnation },
          directory: "/work/checkout"
        }
      };
      f.manage.mockImplementation(async (input) => {
        if (input.action === "apply") {
          if (!preview) throw new Error("Missing preview");
          return { context: preview.after, preview };
        }
        if (input.action === "preview" && scenario === "checkout gone")
          throw new Error(
            "This Git Anchor suggestion no longer matches current evidence."
          );
        const result = await f.originalManage(input);
        if (input.action === "preview" && result.preview) {
          preview = result.preview;
          if (scenario !== "missing intent") preview.inferenceIntent = intent;
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
        scenario === "wrong destination" ? folderProject : gitProject,
        scope
      );
      expect(result.done).toBe(saved ? 1 : 0);
      expect(f.manage).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "preview",
          reviewedCheckout: { directory: "/work/checkout", incarnation },
          correction: expect.objectContaining({
            inferenceIntent: intent,
            expectedVersion: 1,
            repository: expect.objectContaining({ key: "gr_validation_0" })
          })
        })
      );
      expect(f.manage.mock.calls.map(([input]) => input.action)).toEqual(
        saved ? ["get", "preview", "apply"] : ["get", "preview"]
      );
      expect(
        f.manage.mock.calls.map(([input]) => input.expectedScopeKey)
      ).toEqual(saved ? [scope, scope, scope] : [scope, scope]);
    }
  );

  it("preserves the selected portable Git Anchor key without Folder confirmation", async () => {
    const f = fixture();
    const row = stagedGitSuggestion(f.row, 1);
    expect(
      await applySuggestions(f.api, f.projects, [row], gitProject, scope)
    ).toEqual({ done: 1, failed: [] });
    expect(
      f.manage.mock.calls.map(([input]) => [
        input.action,
        input.expectedScopeKey
      ])
    ).toEqual([
      ["get", scope],
      ["preview", scope],
      ["organize", scope]
    ]);
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
