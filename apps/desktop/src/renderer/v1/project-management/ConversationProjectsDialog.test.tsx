// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
  createProjectManagementValidationApi,
  validationId
} from "../../../project-management-validation-api.js";
import { mergeProjectSources } from "../../../project-memory-ui.js";
import { ConversationProjectsDialog } from "./ConversationProjectsDialog.js";

it("lists each Project with how the Conversation is in it, staging Remove and Add with Undo", async () => {
  const f = createProjectManagementValidationApi();
  const projects = mergeProjectSources(f.inventory(), []);
  const project = projects.find((p) => p.id === validationId(2))!;
  const thread = project.threads.find((t) => t.sessionId)!;
  const onApply = vi.fn(async () => {});
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const click = (label: string) =>
    act(async () =>
      document.querySelector<HTMLElement>(`[aria-label="${label}"]`)!.click()
    );
  try {
    await act(async () =>
      root.render(
        <ConversationProjectsDialog
          api={f.api}
          projects={projects}
          target={{ sessionId: thread.sessionId!, title: thread.name }}
          onClose={vi.fn()}
          onApply={onApply}
        />
      )
    );
    const text = () => document.body.textContent ?? "";
    // Words match Project settings; no checkboxes.
    expect(text()).toMatch(/Git Anchor|Folder|Added directly/);
    expect(document.querySelector('[role="checkbox"]')).toBeNull();
    // Projects it is in, then the rest, each under its own heading.
    expect(
      [...document.querySelectorAll(".v1-pm-membership-heading")].map(
        (h) => h.textContent
      )
    ).toEqual([expect.stringMatching(/^In \d+ Projects?$/), "Other Projects"]);
    expect(document.querySelector(".is-outside")).not.toBeNull();
    await click(`Remove ${project.name}`);
    expect(text()).toMatch(/Will be (excluded|removed)/);
    await click(`Undo for ${project.name}`);
    expect(text()).not.toMatch(/Will be (excluded|removed)/);
    await click(`Remove ${project.name}`);
    const save = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Save changes"
    )!;
    await act(async () => save.click());
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        memberships: [
          expect.objectContaining({ projectId: project.id, direct: false })
        ]
      }),
      undefined
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
