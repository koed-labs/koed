import { describe, expect, it, vi } from "vitest";
import type { PersonalDesktopApi } from "@koed-labs/shared/personal-desktop";
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
  it("loads 5,000 Conversations within the read quota using serial bounded requests", async () => {
    const f = createProjectManagementValidationApi();
    const projects = mergeProjectSources(f.inventory(), []);
    const project = projects.find((p) => p.id === validationId(2))!;
    project.threads = Array.from({ length: 5000 }, (_, i) => ({
      ...project.threads[0]!,
      id: validationId(1000 + i),
      sessionId: validationId(1000 + i),
      name: `Conversation ${i}`
    }));
    let requests = 0,
      active = 0,
      peak = 0;
    f.api.manageProject = vi.fn<
      NonNullable<PersonalDesktopApi["manageProject"]>
    >(async (input) => {
      if (++requests > 1000) throw new Error("429 Too Many Requests");
      peak = Math.max(peak, ++active);
      await Promise.resolve();
      active--;
      const sessionIds =
        input.action === "explain_sessions"
          ? input.sessionIds
          : input.action === "explain_session"
            ? [input.sessionId]
            : [];
      expect(sessionIds.length).toBeGreaterThan(0);
      expect(sessionIds.length).toBeLessThanOrEqual(100);
      const explanations = sessionIds.map((sessionId) => ({
        sessionId,
        logicalSessionId: sessionId,
        reasons: [],
        exclusion: null,
        included: false
      }));
      return {
        project: project.namedProject!,
        explanations,
        explanation: explanations[0]
      };
    });
    const draft = await loadProjectSettings(f.api, project, projects);
    expect(draft.inspectionError).toBeUndefined();
    expect(draft.conversations).toHaveLength(5000);
    expect(draft.conversations.at(-1)?.title).toBe("Conversation 4999");
    expect(requests).toBe(50);
    expect(peak).toBe(1);
  });

  it("keeps sync available and discards partial results when a later batch is stale", async () => {
    const f = createProjectManagementValidationApi();
    const projects = mergeProjectSources(f.inventory(), []);
    const project = projects.find((p) => p.id === validationId(2))!;
    project.threads = Array.from({ length: 101 }, (_, i) => ({
      ...project.threads[0]!,
      id: validationId(1000 + i),
      sessionId: validationId(1000 + i)
    }));
    let calls = 0;
    f.api.manageProject = async (input) => {
      if (input.action !== "explain_sessions")
        throw new Error("Unexpected action");
      return {
        project: {
          ...project.namedProject!,
          version: project.namedProject!.version + calls++
        },
        explanations: input.sessionIds.map((sessionId) => ({
          sessionId,
          logicalSessionId: sessionId,
          reasons: [],
          exclusion: null,
          included: false
        }))
      };
    };
    const draft = await loadProjectSettings(f.api, project, projects);
    expect(calls).toBe(2);
    expect(draft.inspectionError).toMatch(/membership changed/);
    expect(draft.sync?.project.projectId).toBe(project.id);
    expect(draft.conversations).toEqual([]);
    draft.name = "Unsafe edit";
    expect(settingsChanges(draft)).toEqual([]);
  });

  it("batches a large source preview and rejects mismatched Conversation identities", async () => {
    const f = createProjectManagementValidationApi();
    const projects = mergeProjectSources(f.inventory(), []);
    const project = projects.find((p) => p.id === validationId(4))!;
    const draft = await loadProjectSettings(f.api, project, projects);
    const source = draft.sources.find((s) => !s.inclusionId && s.target)!;
    const candidates = Array.from({ length: 5000 }, (_, i) => ({
      sessionId: validationId(1000 + i),
      logicalSessionId: validationId(1000 + i),
      name: `Conversation ${i}`
    }));
    let batches = 0,
      mismatch = false;
    f.api.manageProject = async (input) => {
      if (
        input.action === "preview_folder" ||
        input.action === "preview_repository"
      )
        return {
          project: project.namedProject!,
          preview: { target: source.target!, conversations: candidates }
        };
      if (input.action !== "explain_sessions")
        throw new Error("Unexpected action");
      batches++;
      expect(input.sessionIds.length).toBeLessThanOrEqual(100);
      return {
        project: project.namedProject!,
        explanations: input.sessionIds.map((sessionId) => ({
          sessionId,
          logicalSessionId: mismatch ? validationId(99999) : sessionId,
          reasons: [],
          exclusion: null,
          included: false
        }))
      };
    };
    const selected = await selectSettingsSource(f.api, draft, source.id, true);
    expect(selected.conversations).toHaveLength(
      draft.conversations.length + 5000
    );
    expect(batches).toBe(50);
    mismatch = true;
    await expect(
      selectSettingsSource(f.api, draft, source.id, true)
    ).rejects.toThrow("membership changed");
    expect(draft.selectedSources.has(source.id)).toBe(false);
  });
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
