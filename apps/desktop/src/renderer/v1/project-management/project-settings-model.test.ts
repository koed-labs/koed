import { describe, expect, it } from "vitest";
import {
  createProjectManagementValidationApi,
  validationId
} from "../../../project-management-validation-api.js";
import { mergeProjectSources } from "../../../project-memory-ui.js";
import {
  loadProjectSettings,
  selectSettingsSource,
  settingsChanges,
  settingsMembership
} from "./project-settings-model.js";
import {
  inverseOrganizationEdit,
  moveConversationEdit,
  reviewConversationOrganization
} from "./conversation-organization.js";

describe("Project settings and organization integration", () => {
  it("updates membership when a staged direct membership loses its last source", async () => {
    const f = createProjectManagementValidationApi();
    const projects = mergeProjectSources(f.inventory(), []);
    const draft = await loadProjectSettings(
      f.api,
      projects.find((p) => p.id === validationId(2))!,
      projects
    );
    const row = draft.conversations[0]!;
    draft.memberships[row.sessionId] = {
      included: true,
      direct: false,
      restore: false
    };
    expect(settingsMembership(draft, row).included).toBe(true);
    draft.selectedSources.clear();
    expect(settingsMembership(draft, row).included).toBe(false);
  });
  it("previews only source matches, keeps excluded items blocked, and stages changes until Save", async () => {
    const f = createProjectManagementValidationApi();
    let projects = mergeProjectSources(await f.api.listProjects(), []);
    let draft = await loadProjectSettings(
      f.api,
      projects.find((p) => p.id === validationId(4))!,
      projects
    );
    expect(draft.conversations).toHaveLength(2);
    const source = draft.sources.find(
      (s) =>
        s.target?.kind === "folder" && s.target.folder.folderId === "folder_1"
    )!;
    draft = await selectSettingsSource(f.api, draft, source.id, true);
    expect(draft.conversations).toHaveLength(4);
    expect(
      draft.conversations.filter((c) => settingsMembership(draft, c).included)
    ).toHaveLength(4);
    expect(f.projects.get(validationId(4))!.rules).toHaveLength(0);
    draft.name = "Release planning";
    await f.api.manageProject!({
      action: "apply_sources",
      projectId: draft.project.id,
      expectedVersion: draft.project.namedProject!.version,
      changes: settingsChanges(draft)
    });
    projects = mergeProjectSources(await f.api.listProjects(), []);
    expect(projects.find((p) => p.id === validationId(4))).toMatchObject({
      name: "Release planning",
      threads: expect.any(Array)
    });
    expect(
      projects.find((p) => p.id === validationId(4))!.threads
    ).toHaveLength(4);
  });
  it("moves, clears both references, resets them and undoes a move through the same API", async () => {
    const f = createProjectManagementValidationApi(),
      sessionId = validationId(100);
    const read = () => mergeProjectSources(f.inventory(), []);
    let review = await reviewConversationOrganization(f.api, read(), sessionId);
    const edit = moveConversationEdit(
      review,
      validationId(1),
      validationId(3),
      { removeGit: true, removeFolder: true }
    )!;
    const moved = await f.api.manageSourceContext!({
      action: "organize",
      sessionId,
      edit
    });
    expect(
      read()
        .find((p) => p.id === validationId(1))!
        .threads.some((t) => t.sessionId === sessionId)
    ).toBe(false);
    expect(
      read()
        .find((p) => p.id === validationId(2))!
        .threads.some((t) => t.sessionId === sessionId)
    ).toBe(false);
    expect(
      read()
        .find((p) => p.id === validationId(3))!
        .threads.some((t) => t.sessionId === sessionId)
    ).toBe(true);
    const inverse = inverseOrganizationEdit(moved.organization!)!;
    await f.api.manageSourceContext!({
      action: "organize",
      sessionId,
      edit: inverse
    });
    review = await reviewConversationOrganization(f.api, read(), sessionId);
    expect(review.context.git.correction.state).toBe("original");
    expect(review.context.folder.correction.state).toBe("original");
    expect(
      review.memberships
        .filter((m) => m.explanation.included)
        .map((m) => m.project.id)
        .sort()
    ).toEqual([validationId(1), validationId(2)]);
  });
});
