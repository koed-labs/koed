// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
  createProjectManagementValidationApi,
  validationId
} from "../../../project-management-validation-api.js";
import { mergeProjectSources } from "../../../project-memory-ui.js";
import { PersonalMemoryStore } from "../../state/personal-memory.js";
import { ProjectSettingsDialog } from "./ProjectSettingsDialog.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("opens sync conflict review even when a retained exclusion blocks membership inspection", async () => {
  const f = createProjectManagementValidationApi();
  const projectId = validationId(2),
    sessionId = validationId(100);
  await f.api.manageProject!({
    action: "exclude_session",
    projectId,
    expectedVersion: f.projects.get(projectId)!.meta.version,
    sessionId
  });
  const projects = mergeProjectSources(f.inventory(), []);
  const project = projects.find((p) => p.id === projectId)!;
  project.threads = [];
  const sync = await f.api.manageMembershipSync!({ action: "list", projectId });
  sync.state.catalog!.state = "conflict";
  const head = sync.state.catalog!.heads[0]!;
  sync.state.catalog!.heads.push({
    ...head,
    revisionId: "competing-name",
    operation: { kind: "set_project", name: "Other name" }
  });
  const manageSync = vi.fn(f.api.manageMembershipSync!).mockResolvedValue(sync);
  f.api.manageMembershipSync = manageSync;
  f.api.manageProject = vi
    .fn()
    .mockRejectedValue(
      new Error(
        "Synchronized Project membership needs review before it can be changed."
      )
    );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (text: string) =>
    [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === text
    )!;
  try {
    await act(async () =>
      root.render(
        <ProjectSettingsDialog
          api={f.api}
          store={new PersonalMemoryStore(f.api)}
          projects={projects}
          projectId={projectId}
          onClose={vi.fn()}
          onSave={vi.fn()}
          onDelete={vi.fn()}
        />
      )
    );
    expect(f.api.manageProject).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "explain_sessions",
        sessionIds: [sessionId]
      })
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "needs review"
    );
    expect(button("Save changes").disabled).toBe(true);
    await act(async () => button("Sync").click());
    expect(document.body.textContent).toContain("Conflicting changes");
    expect(button("Review sync").disabled).toBe(false);
    await act(async () => button("Review sync").click());
    expect(manageSync).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("Project catalog");
    expect(document.body.textContent).toContain("Other name");
    expect(button("Review this choice").disabled).toBe(false);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
