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
    await click(button(/^Suggested/));
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
