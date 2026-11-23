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
import { projectKinLook } from "../pixelkin/agent-kin.js";
import { homeProjectEntries } from "../home/home-model.js";
import { ProjectSettingsDialog } from "./ProjectSettingsDialog.js";

// Groups start closed; open each one so its rows can be used.
const openGroups = async () => {
  for (const toggle of document.querySelectorAll<HTMLElement>(
    '.v1-pm-group-toggle[aria-expanded="false"]'
  ))
    await act(async () => toggle.click());
};

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
  f.api.manageProject = vi.fn(async (input) => {
    if (input.action === "list_exclusions")
      return {
        project: f.projects.get(projectId)!.meta,
        excludedSessionIds: [sessionId]
      };
    throw new Error(
      "Synchronized Project membership needs review before it can be changed."
    );
  });
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
          onRefresh={vi.fn()}
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

it("previews, discards and retries a Kin edit, then restores the saved Kin for an empty Project", async () => {
  const f = createProjectManagementValidationApi();
  const store = new PersonalMemoryStore(f.api);
  const { projectId } = await f.api.createProject!({ name: "Empty Project" });
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const button = (text: string) =>
    [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === text
    )!;
  const swatch = () =>
    document.querySelector<HTMLButtonElement>('button[aria-label="Mint"]')!;
  const click = (element: HTMLElement) => act(async () => element.click());
  const personality = () =>
    document.querySelector<HTMLButtonElement>(
      '[role="combobox"][aria-label="Personality"]'
    )!;
  const save = vi
    .fn<Parameters<typeof ProjectSettingsDialog>[0]["onSave"]>(
      async (project, changes) => {
        await f.api.manageProject!({
          action: "apply_sources",
          projectId,
          expectedVersion: project.namedProject!.version,
          changes
        });
        return mergeProjectSources(await f.api.listProjects(), []);
      }
    )
    .mockRejectedValueOnce(new Error("Save failed"));
  const close = vi.fn();
  const open = async () => {
    const projects = mergeProjectSources(await f.api.listProjects(), []);
    await act(async () =>
      root.render(
        <ProjectSettingsDialog
          api={f.api}
          store={store}
          projects={projects}
          projectId={projectId}
          onClose={close}
          onSave={save}
          onRefresh={vi.fn()}
          onDelete={vi.fn()}
        />
      )
    );
    await click(button("Kin"));
  };
  try {
    await open();
    const preview = () => document.querySelector(".v1-pm-kin-preview")!;
    const initial = projectKinLook(projectId);
    expect(preview().textContent?.trim()).toBe("");
    expect(
      document.querySelector('[aria-label="Select Project"]')?.textContent
    ).toContain("Empty Project");
    expect(
      preview().querySelector(".v1-pixelkin")!.getAttribute("data-kin-colour")
    ).toBe(initial.palette.base);
    const shape = initial.body.shape === "sphere" ? "Cube" : "Sphere";
    await click(button(shape));
    await click(button("Cancel"));
    await click(button("Discard changes"));
    expect(close).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
    await act(async () => root.render(null));
    await open();
    expect(button("Save changes").disabled).toBe(true);
    await click(button(shape));
    await click(swatch());
    await click(personality());
    const curious = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]')
    ].find((option) => option.textContent?.trim() === "Curious")!;
    await click(curious);
    await click(button("Save changes"));
    expect(document.body.textContent).toContain("Save failed");
    expect(
      preview().querySelector('[data-kin-colour="#55cca3"]')
    ).not.toBeNull();
    await click(button("Save changes"));
    const kin = {
      shape: shape.toLowerCase(),
      colour: "#55cca3",
      personality: "curious"
    };
    expect(f.projects.get(projectId)!.meta.kin).toEqual(kin);
    await act(async () => root.render(null));
    await open();
    expect(button("Save changes").disabled).toBe(true);
    expect(button(shape).getAttribute("aria-pressed")).toBe("true");
    expect(swatch().getAttribute("aria-pressed")).toBe("true");
    expect(personality().textContent).toContain("Curious");
    const project = f.projects.get(projectId)!.meta;
    await f.api.manageProject!({
      action: "add_session",
      projectId,
      expectedVersion: project.version,
      sessionId: validationId(100)
    });
    expect(
      homeProjectEntries(
        mergeProjectSources(await f.api.listProjects(), [])
      ).find((p) => p.id === projectId)?.kin
    ).toEqual(kin);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it.each(["Add", "Add all"])(
  "%s does not approve a replacement Folder for the same Conversation and Project",
  async (action) => {
    const f = createProjectManagementValidationApi();
    const projectId = validationId(3);
    const alternate = f.contexts.get(validationId(100))!.folder.original;
    if (alternate.state !== "known") throw new Error("Missing Folder fixture");
    await f.api.manageProject!({
      action: "add_folder",
      projectId,
      expectedVersion: 1,
      folder: alternate.value.reference
    });
    const projects = mergeProjectSources(f.inventory(), []);
    const target = projects.find((p) => p.id === projectId)!.inclusionRules![0]!
      .target;
    if (target.kind !== "folder") throw new Error("Missing Folder fixture");
    const project = projects.find((p) => p.id === projectId)!;
    const candidate = {
      sessionId: validationId(108),
      title: "Historical Conversation",
      proposal: {
        action: "use" as const,
        kind: "worktree-parent" as const,
        folder: target.folder,
        tier: "medium" as const,
        projects: [{ id: projectId, name: project.name }],
        evidence: []
      }
    };
    const replacement = {
      ...candidate,
      proposal: {
        ...candidate.proposal,
        folder: alternate.value.reference
      }
    };
    const unchanged = {
      ...candidate,
      sessionId: validationId(900),
      title: "Unchanged Conversation"
    };
    const store = new PersonalMemoryStore(f.api);
    const save = vi.fn(async () => [...projects]);
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    const render = async (row: typeof candidate) => {
      await act(async () =>
        root.render(
          <ProjectSettingsDialog
            api={f.api}
            store={store}
            projects={projects}
            projectId={projectId}
            page="conversations"
            suggestions={{ rows: [row, unchanged], loading: false }}
            onSave={save}
            onRefresh={vi.fn()}
            onClose={vi.fn()}
            onDelete={vi.fn()}
          />
        )
      );
      await openGroups();
    };
    const button = (text: string) =>
      [...document.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === text
      )!;
    const click = (el: HTMLElement) => act(async () => el.click());
    const add = () =>
      document.querySelector<HTMLButtonElement>(
        '[aria-label="Add Historical Conversation"]'
      );
    try {
      await render(candidate);
      await click(action === "Add" ? add()! : button("Add 2"));
      expect(add()).toBeNull();
      await render(replacement);
      expect(add()).not.toBeNull();
      await render(candidate);
      expect(add()).not.toBeNull();
      await render(replacement);
      await click(button("General"));
      const name = document.querySelector<HTMLInputElement>(
        "#v1-pm-project-name"
      )!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value"
        )!.set!.call(name, "Renamed Project");
        name.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await click(button("Save changes"));
      expect(save).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: projectId }),
        [
          expect.objectContaining({
            action: "rename",
            name: "Renamed Project"
          })
        ],
        action === "Add all" ? [unchanged] : [],
        []
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  }
);

it("groups suggestions by rule and saves ticked ones with the Project's changes", async () => {
  const f = createProjectManagementValidationApi();
  const projectId = validationId(2);
  const projects = mergeProjectSources(f.inventory(), []);
  // A Conversation already in the Project is never suggested for it.
  const project = projects.find((p) => p.id === projectId)!;
  const member = project.threads[0]!.sessionId!;
  const rule = project.inclusionRules![0]!.target;
  if (rule.kind !== "repository") throw new Error("Missing Git Anchor fixture");
  const row = (n: number, destinationId = projectId) => ({
    sessionId: validationId(900 + n),
    title: `Suggested ${n}`,
    client: "claude" as const,
    proposal: {
      action: "anchor" as const,
      kind: "repository" as const,
      repositoryKey: rule.repository.key,
      tier: "medium" as const,
      projects: [{ id: destinationId, name: "koed" }],
      evidence: []
    }
  });
  const save = vi.fn(async () => [...projects]);
  const container = document.body.appendChild(document.createElement("div"));
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
          page="conversations"
          suggestions={{
            rows: [
              row(1),
              row(2),
              row(3, validationId(3)), // Same display name, different Project.
              { ...row(4), sessionId: member }
            ],
            loading: false
          }}
          onClose={vi.fn()}
          onSave={save}
          onRefresh={vi.fn()}
          onDelete={vi.fn()}
        />
      )
    );
    // Every group starts closed.
    expect(document.body.textContent).not.toContain("Suggested 1");
    await openGroups();
    const text = document.body.textContent ?? "";
    // Only this Project's suggestions, none ticked until the User chooses.
    expect(text).toContain("Suggested 1");
    expect(text).toContain("Suggested 2");
    expect(text).not.toContain("Suggested 3");
    expect(text).not.toContain("Suggested 4");
    expect(button("Save changes").disabled).toBe(true);
    await act(async () =>
      (
        document.querySelector('[aria-label="Add Suggested 1"]') as HTMLElement
      ).click()
    );
    expect(document.body.textContent).toContain("Will be added");
    expect(document.body.textContent).toContain("1 to add");
    // Removing the rule drops its staged addition. Undo restores the rule,
    // but the addition must be approved again.
    const ruleName = document.querySelector(
      ".v1-pm-group-toggle b"
    )!.textContent;
    const action = (label: string) =>
      document.querySelector<HTMLButtonElement>(
        `button[aria-label="${label}"]`
      )!;
    await act(async () => action(`More for ${ruleName}`).click());
    const removeRule = [
      ...document.querySelectorAll<HTMLElement>("[role=menuitem]")
    ].find((item) => item.textContent?.includes("Remove Git Anchor"))!;
    await act(async () => removeRule.click());
    expect(button("Add 2")).toBeUndefined();
    expect(document.body.textContent).not.toContain("1 to add");
    await act(async () => action(`Undo for ${ruleName}`).click());
    await openGroups();
    expect(action("Add Suggested 1")).not.toBeNull();
    await act(async () => action("Add Suggested 1").click());

    // Undo puts the row back; Add stages it again.
    await act(async () =>
      (
        document.querySelector(
          '[aria-label="Undo for Suggested 1"]'
        ) as HTMLElement
      ).click()
    );
    expect(document.body.textContent).not.toContain("Will be added");
    await act(async () =>
      (
        document.querySelector('[aria-label="Add Suggested 1"]') as HTMLElement
      ).click()
    );
    // "Not this one" lives in the row's menu and stages an exclusion.
    await act(async () =>
      (
        document.querySelector(
          '[aria-label="More for Suggested 2"]'
        ) as HTMLElement
      ).click()
    );
    const notThis = [...document.querySelectorAll("[role=menuitem]")].find(
      (item) => item.textContent?.includes("Not this one")
    ) as HTMLElement;
    await act(async () => notThis.click());
    expect(document.body.textContent).toContain("Will be excluded");
    expect(document.body.textContent).toContain("1 to add · 1 to exclude");
    // A Conversation in the Project is removed with one action, then saved.
    await openGroups();
    const memberTitle = projects.find((p) => p.id === projectId)!.threads[0]!
      .name;
    await act(async () =>
      (
        document.querySelector(
          `[aria-label="Remove ${memberTitle}"]`
        ) as HTMLElement
      ).click()
    );
    expect(document.body.textContent).toMatch(/Will be (excluded|removed)/);
    expect(document.body.textContent).toContain(
      "1 to add · 1 to remove · 1 to exclude"
    );
    await act(async () => button("Save changes").click());
    expect(save).toHaveBeenCalledWith(
      expect.anything(),
      [
        expect.objectContaining({
          action: expect.stringMatching(/exclude_session|remove_inclusion/)
        }),
        { action: "exclude_session", sessionId: validationId(902) }
      ],
      [expect.objectContaining({ title: "Suggested 1" })],
      [expect.objectContaining({ title: "Suggested 2" })]
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
