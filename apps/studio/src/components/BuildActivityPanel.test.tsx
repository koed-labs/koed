// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BuildActivityPanel } from "./BuildActivityPanel";
import { BuildViewProvider } from "./BuildViewProvider";
import type { BuildActivity } from "@/lib/studio-build-activity";
import {
  BUILD_PANEL_MODE_STORAGE_KEY,
  readBuildPanelMode
} from "@/lib/buildView";
let root: Root;
let container: HTMLDivElement;
const activity: BuildActivity = {
  source: "live",
  state: "completed",
  project: { name: "testing-the-ui" },
  events: [
    {
      id: "direct",
      kind: "completed",
      state: "completed",
      story: {
        title: "Task completed",
        detail: "Request: Create a Hello world page"
      },
      technical: {
        status: "completed",
        execution: {
          client: "codex",
          model: "test-model",
          reasoning: "medium",
          access: "full_access"
        }
      }
    }
  ]
};
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it("switches a direct conversation between Simple and Advanced and saves the preference", async () => {
  await act(async () =>
    root.render(
      <BuildViewProvider>
        <BuildActivityPanel activity={activity} initialMode="expanded" />
      </BuildViewProvider>
    )
  );
  expect(container.textContent).toContain("Task completed");
  const advanced = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Advanced"
  )!;
  await act(async () => advanced.click());
  expect(advanced.getAttribute("aria-pressed")).toBe("true");
  expect(container.textContent).toContain("test-model");
  expect(container.textContent).toContain("medium");
  expect(container.textContent).toContain("No file changes were reported");
  expect(window.localStorage.getItem("memory-layer.build-view")).toBe(
    "advanced"
  );
  const simple = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Simple"
  )!;
  await act(async () => simple.click());
  expect(container.textContent).toContain("Request: Create a Hello world page");
  expect(window.localStorage.getItem("memory-layer.build-view")).toBe("story");
});
it("shows existing command results instead of dropping them from Advanced", async () => {
  window.localStorage.setItem("memory-layer.build-view", "advanced");
  await act(async () =>
    root.render(
      <BuildViewProvider>
        <BuildActivityPanel
          activity={{
            ...activity,
            events: [
              {
                id: "command",
                kind: "command",
                technical: { command: "pnpm test", result: "All tests passed" }
              }
            ]
          }}
          initialMode="expanded"
        />
      </BuildViewProvider>
    )
  );
  expect(container.textContent).toContain("pnpm test");
  expect(container.textContent).toContain("All tests passed");
});

it("restores an expanded Advanced panel after a complete remount", async () => {
  const render = () => (
    <BuildViewProvider>
      <BuildActivityPanel activity={activity} />
    </BuildViewProvider>
  );
  await act(async () => root.render(render()));
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Expand Build activity"]')!
      .click()
  );
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Advanced")!
      .click()
  );
  expect(readBuildPanelMode()).toBe("expanded");
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(render()));
  expect(
    container.querySelector('[aria-label="Minimize Build activity"]')
  ).not.toBeNull();
  expect(container.textContent).toContain("test-model");
  expect(container.textContent).toContain("completed");
});

it.each([
  ["Minimize Build activity", "compact", "Expand Build activity"],
  ["Close Build activity", "hidden", "Reopen Build activity"]
])(
  "retains the choice made with %s across a remount",
  async (action, mode, reopen) => {
    window.localStorage.setItem(BUILD_PANEL_MODE_STORAGE_KEY, "expanded");
    const render = () => (
      <BuildViewProvider>
        <BuildActivityPanel activity={activity} />
      </BuildViewProvider>
    );
    await act(async () => root.render(render()));
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(`[aria-label="${action}"]`)!
        .click()
    );
    expect(readBuildPanelMode()).toBe(mode);
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(render()));
    expect(container.querySelector(`[aria-label="${reopen}"]`)).not.toBeNull();
  }
);

it("uses compact mode when saved panel state is invalid or storage is unavailable", () => {
  window.localStorage.setItem(BUILD_PANEL_MODE_STORAGE_KEY, "invalid");
  expect(readBuildPanelMode()).toBe("compact");
  const getter = vi
    .spyOn(Storage.prototype, "getItem")
    .mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
  expect(readBuildPanelMode()).toBe("compact");
  getter.mockRestore();
});

it("keeps a visible summary card when minimizing in a desktop chat with a sidebar", async () => {
  Object.defineProperty(container, "clientWidth", {
    value: 1080,
    configurable: true
  });
  const width = vi.spyOn(window, "innerWidth", "get").mockReturnValue(1440);
  await act(async () =>
    root.render(
      <BuildViewProvider>
        <BuildActivityPanel activity={activity} initialMode="expanded" />
      </BuildViewProvider>
    )
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Minimize Build activity"]'
      )!
      .click()
  );
  const summary = [
    ...container.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Expand Build activity"]'
    )
  ].find((button) => button.textContent?.includes("Open"))!;
  expect(
    summary.parentElement!.parentElement!.classList.contains("hidden")
  ).toBe(false);
  expect(summary.textContent).toContain("Completed");
  await act(async () => summary.click());
  expect(
    container.querySelector('[aria-label="Minimize Build activity"]')
  ).not.toBeNull();
  width.mockRestore();
});
