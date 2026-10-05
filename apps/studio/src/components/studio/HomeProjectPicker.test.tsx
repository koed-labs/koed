// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { HomeProjectPicker } from "./HomeProjectPicker";
import type { HomeProject } from "@/lib/studio-home";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement;
const existing = { id: "existing-folder", name: "Existing folder" };
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
});
async function mount(
  choose = vi.fn(async (): Promise<HomeProject | null> => null),
  canChooseFolder = true,
  restrictions: {
    disabled?: boolean;
    noFolderUnavailableReason?: string;
    unavailableReason?: string;
  } = {}
) {
  const select = vi.fn();
  function Harness() {
    const [project, setProject] = useState<HomeProject | null>(existing);
    return (
      <HomeProjectPicker
        {...restrictions}
        project={project}
        projects={[existing]}
        canChooseFolder={canChooseFolder}
        onChooseFolder={choose}
        onSelect={(value) => {
          select(value);
          setProject(value);
        }}
      />
    );
  }
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<Harness />));
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!
      .click()
  );
  return { choose, select };
}
function button(text: string) {
  return [
    ...container.querySelectorAll<HTMLButtonElement>('[role="menu"] button'),
    ...container.querySelectorAll<HTMLButtonElement>("button")
  ].find((item) => item.textContent!.trim() === text)!;
}
it("selects No folder, then an existing project, and updates the selected label", async () => {
  const { select } = await mount();
  await act(async () => button("No folder").click());
  expect(select).toHaveBeenLastCalledWith(null);
  expect(container.querySelector('[aria-haspopup="menu"]')?.textContent).toBe(
    "Personal"
  );
  await act(async () => button("Personal").click());
  await act(async () => button("Existing folder").click());
  expect(select).toHaveBeenLastCalledWith(existing);
  expect(container.querySelector('[role="menu"]')).toBeNull();
});
it("selects a successfully registered folder", async () => {
  const created = { id: "new-folder", name: "Chosen folder" };
  const { select, choose } = await mount(vi.fn(async () => created));
  await act(async () => button("Choose folder…").click());
  expect(choose).toHaveBeenCalledOnce();
  expect(select).toHaveBeenCalledWith(created);
  expect(button("Chosen folder")).toBeDefined();
});
it("preserves the previous selection when the native picker is cancelled", async () => {
  const { select } = await mount();
  await act(async () => button("Choose folder…").click());
  expect(select).not.toHaveBeenCalled();
  expect(container.querySelector('[role="menu"]')).not.toBeNull();
  expect(container.querySelector('[aria-haspopup="menu"]')?.textContent).toBe(
    "Existing folder"
  );
});
it("shows registration errors and allows retry", async () => {
  const choose = vi
    .fn()
    .mockRejectedValueOnce(new Error("Folder registration failed"))
    .mockResolvedValueOnce(existing);
  const { select } = await mount(choose);
  await act(async () => button("Choose folder…").click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Folder registration failed"
  );
  await act(async () => button("Choose folder…").click());
  expect(select).toHaveBeenCalledWith(existing);
});
it("does not expose native folder selection when unavailable", async () => {
  const { choose } = await mount(undefined, false);
  expect(button("Choose folder…")).toBeUndefined();
  expect(button("No folder")).toBeDefined();
  expect(button("Existing folder")).toBeDefined();
  expect(choose).not.toHaveBeenCalled();
});
it("supports keyboard navigation and Escape, restoring focus to the trigger", async () => {
  await mount();
  expect(document.activeElement).toBe(button("Existing folder"));
  await act(async () =>
    button("Existing folder").dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })
    )
  );
  expect(document.activeElement).toBe(button("No folder"));
  await act(async () =>
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    )
  );
  expect(container.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(
    container.querySelector('[aria-haspopup="menu"]')
  );
});

it("keeps No folder unavailable for existing chats while allowing a reviewed destination", async () => {
  const { select } = await mount(undefined, true, {
    noFolderUnavailableReason: "Start a new chat to use No folder."
  });
  expect(button("No folder").disabled).toBe(true);
  await act(async () => button("No folder").click());
  expect(select).not.toHaveBeenCalled();
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    "Start a new chat"
  );
  expect(button("Existing folder").disabled).toBe(false);
});
it("blocks all changes while a chat cannot move, with a visible reason", async () => {
  const { select, choose } = await mount(undefined, true, {
    disabled: true,
    unavailableReason: "Wait for the active task."
  });
  await act(async () => button("Choose folder…").click());
  await act(async () => button("Existing folder").click());
  expect(select).not.toHaveBeenCalled();
  expect(choose).not.toHaveBeenCalled();
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    "Wait for the active task."
  );
});
