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

it.each([
  ["Add", "candidate"],
  ["Add all", "candidate"],
  ["Add", "revision"],
  ["Add all", "revision"]
])(
  "%s does not approve a changed Folder %s for the same Conversation and Project",
  async (action, change) => {
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
        folderRevision: 1,
        tier: "medium" as const,
        projects: [{ id: projectId, name: project.name }],
        evidence: []
      }
    };
    const replacement = {
      ...candidate,
      proposal: {
        ...candidate.proposal,
        ...(change === "candidate"
          ? { folder: alternate.value.reference }
          : { folderRevision: 2 })
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
      expect(document.body.textContent).not.toContain("Recording origin");
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

it("keeps a staged exclusion individually undoable when its final rule is removed", async () => {
  const f = createProjectManagementValidationApi();
  const projectId = validationId(2);
  const projects = mergeProjectSources(f.inventory(), []);
  const project = projects.find((p) => p.id === projectId)!;
  const rule = project.inclusionRules![0]!;
  const save = vi.fn(async () => projects);
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const click = (el: HTMLElement) => act(async () => el.click());
  const action = (label: string) =>
    document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  const row = (title: string) =>
    [...document.querySelectorAll(".v1-pm-conversation-row")].find(
      (el) => el.querySelector("b")?.textContent === title
    );
  const excludedTitle = "A calmer sidebar for Koed";
  const untouchedTitle = "Refine the settings popup";
  try {
    await act(async () =>
      root.render(
        <ProjectSettingsDialog
          api={f.api}
          store={new PersonalMemoryStore(f.api)}
          projects={projects}
          projectId={projectId}
          page="conversations"
          onClose={vi.fn()}
          onSave={save}
          onRefresh={vi.fn()}
          onDelete={vi.fn()}
        />
      )
    );
    await openGroups();
    await click(action(`Remove ${excludedTitle}`)!);
    expect(row(excludedTitle)?.textContent).toContain("Will be excluded");
    const ruleName = document.querySelector(
      ".v1-pm-group-toggle b"
    )!.textContent;
    await click(action(`More for ${ruleName}`)!);
    await click(
      [...document.querySelectorAll<HTMLElement>("[role=menuitem]")].find(
        (item) => item.textContent?.includes("Remove Git Anchor")
      )!
    );
    expect(row(excludedTitle)?.textContent).toContain("Will be excluded");
    expect(row(excludedTitle)?.textContent).not.toContain(
      "Leaves with this rule"
    );
    expect(row(untouchedTitle)?.textContent).toContain("Leaves with this rule");
    expect(action(`Undo for ${untouchedTitle}`)).toBeNull();
    const ruleStatus = () =>
      document.querySelector(".v1-pm-group-toggle")?.textContent;
    expect(ruleStatus()).toContain("Will be removed · 5 leave");
    await click(action(`Undo for ${excludedTitle}`)!);
    expect(row(excludedTitle)?.textContent).toContain("Leaves with this rule");
    expect(action(`Undo for ${excludedTitle}`)).toBeNull();
    expect(action(`Undo for ${ruleName}`)).not.toBeNull();
    expect(ruleStatus()).toContain("Will be removed · 6 leave");
    await click(
      [...document.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Save changes"
      )!
    );
    expect(save).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: projectId }),
      [{ action: "remove_rule", inclusionId: rule.inclusionId }],
      [],
      []
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("distinguishes same-named Folder rule options by path, device, and directory incarnation", async () => {
  const f = createProjectManagementValidationApi();
  const projectId = validationId(2);
  const projects = mergeProjectSources(f.inventory(), []);
  const original = projects.find((p) => p.folder && p.name === "koed-desktop")!;
  const folder = original.folder!;
  const otherPath = { ...folder.reference, folderId: "folder_other_path" };
  const otherDevice = {
    ...folder.reference,
    originatingDeviceId: "test-device"
  };
  const unnamedDevice = {
    ...folder.reference,
    originatingDeviceId: "test-unnamed"
  };
  const replacement = {
    ...folder.reference,
    directoryIncarnationId: "directory_replacement"
  };
  projects.push(
    {
      ...original,
      id: "test-folder-replacement",
      folder: { ...folder, reference: replacement }
    },
    {
      ...original,
      id: "test-folder-other-path",
      folder: {
        ...folder,
        reference: otherPath,
        normalizedPath: "/work/koed-desktop"
      }
    },
    {
      ...original,
      id: "test-folder-other-device",
      folder: { ...folder, reference: otherDevice },
      threads: [
        {
          ...original.threads[0]!,
          originDevice: { id: "test-device", name: "This Mac" }
        }
      ]
    },
    {
      ...original,
      id: "test-folder-unnamed-device",
      folder: { ...folder, reference: unnamedDevice },
      threads: []
    }
  );
  const save = vi.fn(async () => projects);
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const click = (el: HTMLElement) => act(async () => el.click());
  const button = (label: string) =>
    [...document.querySelectorAll("button")].find(
      (el) => el.textContent?.trim() === label
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
          onClose={vi.fn()}
          onSave={save}
          onRefresh={vi.fn()}
          onDelete={vi.fn()}
        />
      )
    );
    await click(button("Add rule"));
    const options = [
      ...document.querySelectorAll<HTMLElement>("[role=menuitem]")
    ];
    const folderOptions = options.filter((el) =>
      el.textContent?.startsWith("koed-desktop")
    );
    const originalDetail = "/code/koed-desktop · This Mac · this-mac";
    const replacementDetail = `${originalDetail} · ${replacement.directoryIncarnationId}`;
    expect(
      folderOptions.map((el) => el.querySelector("small")?.textContent).sort()
    ).toEqual(
      [
        `${originalDetail} · ${folder.reference.directoryIncarnationId}`,
        replacementDetail,
        "/work/koed-desktop · This Mac",
        "/code/koed-desktop · This Mac · test-device",
        "/code/koed-desktop · test-unnamed"
      ].sort()
    );
    await click(
      folderOptions.find(
        (el) => el.querySelector("small")?.textContent === replacementDetail
      )!
    );
    await click(button("Save changes"));
    expect(save).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: projectId }),
      [{ action: "add_folder", folder: replacement }],
      [],
      []
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("discloses unverified recording origin from collapsed bulk Add through Save changes", async () => {
  const f = createProjectManagementValidationApi();
  const projectId = validationId(2);
  const projects = mergeProjectSources(f.inventory(), []);
  const project = projects.find((p) => p.id === projectId)!;
  const rule = project.inclusionRules![0]!.target;
  if (rule.kind !== "repository") throw new Error("Missing Git Anchor fixture");
  const ordinary = {
    sessionId: validationId(901),
    title: "Ordinary suggestion",
    proposal: {
      action: "anchor" as const,
      kind: "repository" as const,
      repositoryKey: rule.repository.key,
      gitRevision: 1,
      tier: "medium" as const,
      projects: [{ id: projectId, name: project.name }],
      evidence: []
    }
  };
  const historical = {
    sessionId: validationId(902),
    title: "Historical suggestion",
    proposal: {
      ...ordinary.proposal,
      directory: "/code/koed",
      manualGitReview: {
        intent: "assumed-local-import" as const,
        incarnation: "a".repeat(64)
      }
    }
  };
  const save = vi.fn(async () => projects);
  const close = vi.fn();
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const click = (el: HTMLElement) => act(async () => el.click());
  const button = (text: string) =>
    [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === text
    )!;
  const description = (button: HTMLElement) =>
    document.getElementById(button.getAttribute("aria-describedby") ?? "");
  const warning = "Recording origin unverified for 1 Conversation";
  const footer = () => button("Save changes").parentElement;
  try {
    await act(async () =>
      root.render(
        <ProjectSettingsDialog
          api={f.api}
          store={new PersonalMemoryStore(f.api)}
          projects={projects}
          projectId={projectId}
          page="conversations"
          suggestions={{ rows: [ordinary, historical], loading: false }}
          onClose={close}
          onSave={save}
          onRefresh={vi.fn()}
          onDelete={vi.fn()}
        />
      )
    );
    expect(document.body.textContent).not.toContain(historical.title);
    expect(footer()?.textContent).not.toContain("Recording origin");
    const add = button("Add 2");
    const groupWarning = description(add);
    expect.soft(groupWarning?.parentElement).toBe(add.parentElement);
    expect.soft(groupWarning?.textContent).toBe(warning);
    await click(add);
    expect(document.body.textContent).not.toContain(historical.title);
    expect(save).not.toHaveBeenCalled();
    expect.soft(footer()?.textContent).toContain(warning);
    expect.soft(description(button("Save changes"))?.textContent).toBe(warning);
    const undo = button("Undo");
    expect(description(undo)).toBeNull();
    expect(undo.parentElement?.textContent).not.toContain("Recording origin");
    await click(undo);
    expect(description(button("Add 2"))?.textContent).toBe(warning);
    expect(footer()?.textContent).not.toContain("Recording origin");
    expect(button("Save changes").disabled).toBe(true);

    await click(button("Add 2"));
    await openGroups();
    await click(
      document.querySelector<HTMLButtonElement>(
        '[aria-label="Undo for Historical suggestion"]'
      )!
    );
    expect(footer()?.textContent).toContain("1 to add");
    expect(footer()?.textContent).not.toContain("Recording origin");
    expect(description(button("Save changes"))).toBeNull();
    expect(button("Save changes").disabled).toBe(false);
    await click(button("Add 2"));
    await click(button("General"));
    expect.soft(footer()?.textContent).toContain(warning);
    expect(description(button("Save changes"))?.textContent).toBe(warning);
    await click(button("Save changes"));
    expect(save).toHaveBeenCalledExactlyOnceWith(
      project,
      [],
      [ordinary, historical],
      []
    );
    expect(close).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("groups suggestions by rule and saves ticked ones with the Project's changes", async () => {
  const f = createProjectManagementValidationApi();
  const projectId = validationId(2);
  const projects = mergeProjectSources(f.inventory(), []);
  // A Conversation already in the Project is never suggested for it.
  const project = projects.find((p) => p.id === projectId)!;
  const member = project.threads[0]!.sessionId!;
  const rule = project.inclusionRules![0]!.target;
  if (rule.kind !== "repository") throw new Error("Missing Git Anchor fixture");
  const row = (n: number, destinationId = projectId, gitRevision = 1) => ({
    sessionId: validationId(900 + n),
    title: `Suggested ${n}`,
    client: "claude" as const,
    proposal: {
      action: "anchor" as const,
      kind: "repository" as const,
      repositoryKey: rule.repository.key,
      gitRevision,
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
  const store = new PersonalMemoryStore(f.api);
  const renderSuggestions = (gitRevision: number) =>
    act(async () =>
      root.render(
        <ProjectSettingsDialog
          api={f.api}
          store={store}
          projects={projects}
          projectId={projectId}
          page="conversations"
          suggestions={{
            rows: [
              row(1, projectId, gitRevision),
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
  try {
    await renderSuggestions(1);
    // Every group starts closed.
    expect(document.body.textContent).not.toContain("Suggested 1");
    // The first section is the Project's rules, titled without a count.
    const heading = document.querySelector(".v1-pm-group-heading h3")!;
    expect(heading.textContent).toBe("Rules");
    expect(heading.querySelector(".v1-pm-coin")).toBeNull();
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
    await renderSuggestions(2);
    expect(document.body.textContent).not.toContain("Will be added");
    expect(button("Save changes").disabled).toBe(true);
    await act(async () =>
      document
        .querySelector<HTMLElement>('[aria-label="Add Suggested 1"]')!
        .click()
    );
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
      [
        expect.objectContaining({
          title: "Suggested 1",
          proposal: expect.objectContaining({ gitRevision: 2 })
        })
      ],
      [expect.objectContaining({ title: "Suggested 2" })]
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
