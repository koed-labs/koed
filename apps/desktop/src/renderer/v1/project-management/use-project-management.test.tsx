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
import { useProjectManagement } from "./use-project-management.js";

function settingsScreen(
  f: ReturnType<typeof createProjectManagementValidationApi>,
  scopeKey = "settings-test"
) {
  const projectId = validationId(2);
  // Deliberately keep the parent inventory fixed. Only the explicit refresh
  // should replace the dialog's reviewed Project version.
  const projects = mergeProjectSources(f.inventory(), []);
  const store = new PersonalMemoryStore(f.api);
  function Screen() {
    const management = useProjectManagement({
      scopeKey,
      api: f.api,
      store,
      projects,
      onOrganized: () => {}
    });
    return (
      <>
        <button onClick={() => management.openSettings(projectId)}>
          Open settings
        </button>
        {management.overlays}
      </>
    );
  }
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const button = (text: RegExp) =>
    [...document.querySelectorAll("button")].find((b) =>
      text.test(b.textContent?.trim() ?? "")
    )!;
  const click = (el: HTMLElement) => act(async () => el.click());
  const rowAction = (label: string) =>
    document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  // Groups start closed; open each one so its rows can be used.
  const openGroups = async () => {
    for (const toggle of document.querySelectorAll<HTMLElement>(
      '.v1-pm-group-toggle[aria-expanded="false"]'
    ))
      await click(toggle);
  };
  return {
    button,
    click,
    rowAction,
    openGroups,
    store,
    open: async () => {
      await act(async () => root.render(<Screen />));
      await click(button(/^Open settings$/));
    },
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    }
  };
}

const conversationSearch = () =>
  document.querySelector<HTMLInputElement>(
    '[aria-label="Search Project Conversations"]'
  )!;

const setInput = (input: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

it("keeps Conversations open and uses the refreshed Project version on the next save", async () => {
  const f = createProjectManagementValidationApi();
  const projectId = validationId(2);
  const sessionId = validationId(100);
  await f.api.manageProject!({
    action: "exclude_session",
    projectId,
    expectedVersion: 1,
    sessionId
  });
  const manage = vi.spyOn(f.api, "manageProject");
  const ui = settingsScreen(f);
  try {
    await ui.open();
    await ui.click(ui.button(/^Conversations/));
    await ui.openGroups();
    await ui.click(ui.rowAction("Remove Refine the settings popup"));
    await ui.openGroups();
    await setInput(conversationSearch(), "sidebar");
    await ui.click(ui.button(/^Save changes$/));
    expect(f.projects.get(projectId)!.meta.version).toBe(3);
    expect(
      document.querySelector('[role="dialog"] h2:last-child')?.textContent
    ).toBe("Conversations");
    expect(conversationSearch().value).toBe("sidebar");
    expect(ui.button(/^Save changes$/).disabled).toBe(true);

    await ui.click(ui.rowAction("Add back A calmer sidebar for Koed"));
    await ui.click(ui.button(/^Save changes$/));
    expect(f.projects.get(projectId)!.meta.version).toBe(4);
    expect(manage).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "apply_sources",
        projectId,
        expectedVersion: 3
      })
    );
    expect(conversationSearch().value).toBe("sidebar");
    expect(ui.rowAction("Add back A calmer sidebar for Koed")).toBeNull();
    expect(ui.button(/^Save changes$/).disabled).toBe(true);
  } finally {
    await ui.cleanup();
  }
});

it("uses authoritative versions even when a background refresh supersedes the save refresh", async () => {
  const f = createProjectManagementValidationApi();
  const ui = settingsScreen(f);
  await ui.store.loadProjects();
  const saveRefresh = deferredInventory(f);
  const backgroundRefresh = deferredInventory(f);
  try {
    await ui.open();
    await ui.click(ui.button(/^Conversations/));
    await ui.openGroups();
    await ui.click(ui.rowAction("Remove Refine the settings popup"));
    vi.spyOn(f.api, "listProjects")
      .mockReturnValueOnce(saveRefresh.promise)
      .mockReturnValueOnce(backgroundRefresh.promise);
    await ui.click(ui.button(/^Save changes$/));
    const background = ui.store.loadProjects({ silent: true });
    await act(async () => saveRefresh.resolve());
    expect(document.body.textContent).not.toContain("Project changed");
    await ui.openGroups();
    await ui.click(ui.rowAction("Add back Refine the settings popup"));
    await ui.click(ui.button(/^Save changes$/));
    expect(f.projects.get(validationId(2))!.meta.version).toBe(3);
    await act(async () => {
      backgroundRefresh.resolve();
      await background;
    });
  } finally {
    await ui.cleanup();
  }
});

function deferredInventory(
  f: ReturnType<typeof createProjectManagementValidationApi>
) {
  let resolve!: (projects: ReturnType<typeof f.inventory>) => void;
  const promise = new Promise<ReturnType<typeof f.inventory>>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve(f.inventory()) };
}

it.each(["sidebar inventory", "authoritative inventory", "draft"])(
  "recovers from a failed %s refresh without replaying committed edits",
  async (failure) => {
    const f = createProjectManagementValidationApi();
    const projectId = validationId(2);
    const ui = settingsScreen(f);
    try {
      await ui.open();
      await ui.click(ui.button(/^Conversations/));
      await ui.openGroups();
      await ui.click(ui.rowAction("Remove Refine the settings popup"));
      await ui.openGroups();
      await setInput(conversationSearch(), "settings");
      const original = f.api.manageProject!;
      const manage = vi.spyOn(f.api, "manageProject");
      if (failure !== "draft") {
        const originalList = f.api.listProjects;
        const list = vi.spyOn(f.api, "listProjects");
        if (failure === "authoritative inventory")
          list.mockImplementationOnce(originalList);
        list.mockRejectedValueOnce(new Error("Inventory unavailable"));
      } else {
        manage.mockImplementation(async (input) => {
          if (input.action === "list_exclusions") {
            manage.mockImplementation(original);
            throw new Error("Draft unavailable");
          }
          return original(input);
        });
      }
      await ui.click(ui.button(/^Save changes$/));
      expect(f.projects.get(projectId)!.meta.version).toBe(2);
      expect(document.body.textContent).toContain(
        failure === "draft" ? "Draft unavailable" : "Inventory unavailable"
      );
      expect(ui.button(/^Conversations/)?.getAttribute("aria-current")).toBe(
        "page"
      );
      expect(ui.button(/^Save changes$/).disabled).toBe(true);
      expect(ui.rowAction("Undo for Refine the settings popup")).toBeNull();
      const retry = ui.button(/^Retry refresh$/);
      if (failure === "sidebar inventory") {
        expect(retry).toBeUndefined();
      } else {
        expect(retry).toBeDefined();
        await ui.click(retry);
      }
      expect(conversationSearch().value).toBe("settings");
      expect(ui.rowAction("Add back Refine the settings popup")).not.toBeNull();
      expect(ui.button(/^Save changes$/).disabled).toBe(true);
      expect(
        manage.mock.calls.filter(([input]) => input.action === "apply_sources")
      ).toHaveLength(1);
      expect(f.projects.get(projectId)!.meta.version).toBe(2);
    } finally {
      await ui.cleanup();
    }
  }
);

it("blocks row menu edits during save without disabling search or filters", async () => {
  const f = createProjectManagementValidationApi();
  const ui = settingsScreen(f);
  const inventory = deferredInventory(f);
  try {
    await ui.open();
    await ui.click(ui.button(/^Conversations/));
    await ui.openGroups();
    await ui.click(ui.rowAction("Remove Refine the settings popup"));
    const more = ui.rowAction("More for A calmer sidebar for Koed");
    await ui.click(more);
    const keep = document.querySelector<HTMLElement>(
      '[role="menuitemcheckbox"]'
    )!;
    expect(keep.textContent).toContain("Keep if rules change");
    vi.spyOn(f.api, "listProjects").mockReturnValueOnce(inventory.promise);
    await ui.click(ui.button(/^Save changes$/));
    expect(more.disabled).toBe(true);
    expect(
      keep.isConnected && keep.getAttribute("aria-disabled") !== "true"
    ).toBe(false);
    expect(conversationSearch().disabled).toBe(false);
    await ui.openGroups();
  } finally {
    await act(async () => inventory.resolve());
    await ui.cleanup();
  }
});

it.each(["General", "Conversations"])(
  "uses the live %s tab when the post-save refresh finishes",
  async (panel) => {
    const f = createProjectManagementValidationApi();
    const projectId = validationId(2);
    const ui = settingsScreen(f);
    try {
      await ui.open();
      await setInput(
        document.querySelector<HTMLInputElement>("#v1-pm-project-name")!,
        "Renamed Koed"
      );
      const inventory = deferredInventory(f);
      vi.spyOn(f.api, "listProjects").mockReturnValueOnce(inventory.promise);
      await ui.click(ui.button(/^Save changes$/));
      expect(f.projects.get(projectId)!.meta.version).toBe(2);
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      if (panel === "Conversations")
        await ui.click(ui.button(/^Conversations/));
      await ui.openGroups();
      await act(async () => inventory.resolve());
      if (panel === "Conversations") {
        expect(conversationSearch()).not.toBeNull();
        expect(ui.button(/^Save changes$/).disabled).toBe(true);
      } else {
        expect(document.querySelector('[role="dialog"]')).toBeNull();
      }
    } finally {
      await ui.cleanup();
    }
  }
);

it.each([
  { receipt: "matching", scope: "a", error: null },
  { receipt: "mismatched", scope: "b", error: "another Project" },
  {
    receipt: "rejected by main",
    scope: "c",
    error: "Local Personal Memory returned an invalid response."
  }
])(
  "handles a scoped suggestion rejection when the receipt is $receipt",
  async ({ receipt, scope, error }) => {
    const f = createProjectManagementValidationApi();
    const projectId = validationId(2);
    const sessionId = validationId(108);
    const scopeKey = scope.repeat(64);
    f.api.folderHints = vi.fn(async () => [
      {
        sessionId,
        kind: "repository" as const,
        tier: "medium" as const,
        score: 4,
        repositoryKey: "gr_validation_0",
        gitRevision: 1,
        reasons: []
      }
    ]);
    const manage = vi.spyOn(f.api, "manageProject");
    const ui = settingsScreen(f, scopeKey);
    vi.useFakeTimers();
    try {
      await ui.open();
      await act(async () => vi.advanceTimersByTimeAsync(3000));
      await ui.click(ui.button(/^Conversations/));
      await ui.openGroups();
      await ui.click(ui.rowAction("More for Notes on personal knowledge"));
      const reject = [
        ...document.querySelectorAll<HTMLElement>("[role=menuitem]")
      ].find((item) => item.textContent?.trim() === "Not this one")!;
      await ui.click(reject);
      if (receipt === "mismatched") {
        manage.mockResolvedValueOnce({
          project: f.projects.get(validationId(1))!.meta
        });
      } else if (receipt === "rejected by main") {
        manage.mockRejectedValueOnce(new Error(error!));
      }
      await ui.click(ui.button(/^Save changes$/));
      expect(manage).toHaveBeenCalledWith({
        action: "apply_sources",
        projectId,
        expectedVersion: 1,
        expectedScopeKey: scopeKey,
        changes: [{ action: "exclude_session", sessionId }]
      });
      const undo = ui.rowAction("Undo for Notes on personal knowledge");
      if (error) {
        expect(ui.button(/^Save changes$/).disabled).toBe(false);
        expect(undo).not.toBeNull();
        expect(document.body.textContent).toContain("Will be excluded");
        expect(document.body.textContent).toContain(error);
        expect(document.body.textContent).not.toContain(
          "Project settings saved"
        );
      } else {
        expect(ui.button(/^Save changes$/).disabled).toBe(true);
        expect(undo).toBeNull();
        expect(ui.rowAction("More for Notes on personal knowledge")).toBeNull();
        expect(document.body.textContent).toContain("Project settings saved");
      }
    } finally {
      await ui.cleanup();
      vi.useRealTimers();
    }
  }
);

it.each([
  "same account and backend",
  "account changed",
  "backend changed",
  "inventory failed"
])("saves a rename and guards suggested Add: %s", async (scenario) => {
  const f = createProjectManagementValidationApi();
  const projectId = validationId(2),
    sessionId = validationId(108);
  f.api.folderHints = vi.fn(async () => [
    {
      sessionId,
      kind: "repository" as const,
      tier: "medium" as const,
      score: 4,
      repositoryKey: "gr_validation_0",
      gitRevision: 1,
      reasons: []
    }
  ]);
  const manage = vi.spyOn(f.api, "manageSourceContext");
  const projects = mergeProjectSources(f.inventory(), []);
  const store = new PersonalMemoryStore(f.api);
  const replacement = createProjectManagementValidationApi().api;
  function Screen({ scopeKey = "test-account", api = f.api } = {}) {
    const management = useProjectManagement({
      scopeKey,
      api,
      store,
      projects,
      onOrganized: vi.fn()
    });
    return (
      <>
        <button onClick={() => management.openSettings(projectId)}>
          Open settings
        </button>
        {management.overlays}
      </>
    );
  }
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const click = (el: HTMLElement) => act(async () => el.click());
  const button = (text: RegExp) =>
    [...document.querySelectorAll("button")].find((b) =>
      text.test(b.textContent?.trim() ?? "")
    )!;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  try {
    await act(async () => root.render(<Screen />));
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    await click(button(/^Open settings$/));
    const name = document.querySelector<HTMLInputElement>(
      "#v1-pm-project-name"
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )!.set!.call(name, "Renamed Koed");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button(/^Conversations/));
    for (const toggle of document.querySelectorAll<HTMLElement>(
      '.v1-pm-group-toggle[aria-expanded="false"]'
    ))
      await click(toggle);
    await click(
      document.querySelector<HTMLElement>(
        '[aria-label="Add Notes on personal knowledge"]'
      )!
    );
    const list = vi.spyOn(f.api, "listProjects");
    let resolveInventory!: (inventory: ReturnType<typeof f.inventory>) => void;
    const pending = new Promise<ReturnType<typeof f.inventory>>((resolve) => {
      resolveInventory = resolve;
    });
    if (scenario === "inventory failed")
      list.mockRejectedValueOnce(new Error("Inventory unavailable"));
    else if (scenario !== "same account and backend")
      list.mockReturnValueOnce(pending);
    await click(button(/^Save changes$/));
    expect(f.projects.get(projectId)!.meta).toMatchObject({
      name: "Renamed Koed",
      version: 2
    });
    expect(list).toHaveBeenCalled();
    if (scenario !== "same account and backend") {
      if (scenario === "inventory failed") {
        expect(document.body.textContent).toContain(
          "Project settings saved. No suggested conversations added."
        );
        expect(document.body.textContent).toContain("Inventory unavailable");
      } else {
        await act(async () =>
          root.render(
            scenario === "account changed" ? (
              <Screen scopeKey="new-account" />
            ) : (
              <Screen api={replacement} />
            )
          )
        );
        await act(async () => resolveInventory(f.inventory()));
        expect(document.body.textContent).not.toContain(
          "Project settings saved"
        );
      }
      expect(manage).not.toHaveBeenCalled();
      return;
    }
    expect(manage).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "organize",
        sessionId,
        edit: expect.objectContaining({
          memberships: [],
          reviewedProjects: expect.arrayContaining([
            { projectId, expectedVersion: 2 }
          ])
        })
      })
    );
    expect(document.body.textContent).toContain(
      "Project settings saved. Added 1 conversation."
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
