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
  expect(container.textContent).toContain("Request: Create a Hello world page");
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
  const maximize = container.querySelector<HTMLButtonElement>(
    '[aria-label="Maximize Build activity"]'
  )!;
  expect(maximize.closest(".no-drag")).not.toBeNull();
  await act(async () => maximize.click());
  expect(readBuildPanelMode()).toBe("expanded");
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Minimize Build activity"]'
      )!
      .click()
  );
  const reopenedSummary = [
    ...container.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Expand Build activity"]'
    )
  ].find((button) => button.textContent?.includes("Open"))!;
  await act(async () => reopenedSummary.click());
  expect(
    container.querySelector('[aria-label="Minimize Build activity"]')
  ).not.toBeNull();
  width.mockRestore();
});

it("reopens a closed panel directly to the full view", async () => {
  window.localStorage.setItem(BUILD_PANEL_MODE_STORAGE_KEY, "hidden");
  await act(async () =>
    root.render(
      <BuildViewProvider>
        <BuildActivityPanel activity={activity} />
      </BuildViewProvider>
    )
  );
  const reopen = container.querySelector<HTMLButtonElement>(
    '[aria-label="Reopen Build activity"]'
  )!;
  expect(reopen.closest(".no-drag")).not.toBeNull();
  await act(async () => reopen.click());
  expect(readBuildPanelMode()).toBe("expanded");
  expect(
    container.querySelector('[aria-label="Minimize Build activity"]')
  ).not.toBeNull();
});

it("renders a readable response in Simple and existing file counts in Advanced", async () => {
  await act(async () =>
    root.render(
      <BuildViewProvider>
        <BuildActivityPanel
          initialMode="expanded"
          activity={{
            ...activity,
            events: [
              {
                id: "response",
                kind: "completed",
                state: "completed",
                story: {
                  title:
                    "Agent reports: Created index.html with a Hello world message."
                }
              },
              {
                id: "diff",
                kind: "workspace-observed",
                technical: {
                  status: "Saved changes for this request",
                  files: [
                    {
                      path: "index.html",
                      change: "added",
                      additions: 12,
                      deletions: 2,
                      patch: "@@ -1 +1 @@\n-Old message\n+Hello world",
                      patchTruncated: false
                    }
                  ],
                  diff: { filesChanged: 1, additions: 12, deletions: 2 }
                }
              }
            ]
          }}
        />
      </BuildViewProvider>
    )
  );
  expect(container.textContent).toContain(
    "Created index.html with a Hello world message."
  );
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Advanced")!
      .click()
  );
  expect(container.textContent).toContain(
    "Created index.html with a Hello world message."
  );
  expect(container.textContent).toContain(
    "1 files changed · +12 lines · -2 lines"
  );
  expect(container.textContent).toContain("index.html");
  expect(container.textContent).toContain("added · +12 −2");
  expect(
    container.querySelector('[aria-label="Diff for index.html"]')?.textContent
  ).toContain("+Hello world");
  expect(
    container.querySelector('[aria-label="Diff for index.html"]')?.textContent
  ).toContain("-Old message");
});

it("includes the latest conversation note in Advanced for a named Agent with separate job events", async () => {
  window.localStorage.setItem("memory-layer.build-view", "advanced");
  await act(async () =>
    root.render(
      <BuildViewProvider>
        <BuildActivityPanel
          initialMode="expanded"
          activity={{
            ...activity,
            recentExchanges: [
              {
                id: "command:latest",
                kind: "completed",
                state: "completed",
                story: {
                  title: "Agent reports: Added the green greeting button.",
                  detail:
                    "Request: Add a greeting button.\nReply: Added the green greeting button."
                }
              }
            ]
          }}
        />
      </BuildViewProvider>
    )
  );
  expect(container.textContent).toContain("Recent conversation");
  expect(container.textContent).toContain("Added the green greeting button.");
  expect(container.textContent).toContain("Request: Add a greeting button.");
  expect(container.textContent).toContain("test-model");
});

it.each(["story", "advanced"])(
  "shows newest outputs first in %s and lets each note collapse independently",
  async (view) => {
    window.localStorage.setItem("memory-layer.build-view", view);
    const notes = ["First output", "Second output", "Latest output"].map(
      (title, index) => ({
        id: `exchange:${index}`,
        kind: "message" as const,
        story: { title, detail: `Details for ${title}` }
      })
    );
    await act(async () =>
      root.render(
        <BuildViewProvider>
          <BuildActivityPanel
            initialMode="expanded"
            activity={{ ...activity, recentExchanges: notes }}
          />
        </BuildViewProvider>
      )
    );
    for (const note of notes)
      expect(container.textContent).toContain(note.story.title);
    expect(
      [...container.querySelectorAll("button")]
        .filter((button) =>
          notes.some((note) => note.story.title === button.textContent)
        )
        .map((button) => button.textContent)
    ).toEqual(["Latest output", "Second output", "First output"]);
    expect(notes.map((note) => note.story.title)).toEqual([
      "First output",
      "Second output",
      "Latest output"
    ]);
    expect(container.textContent).not.toContain("Details for First output");
    const noteButton = (title: string) =>
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === title
      )!;
    await act(async () => noteButton("First output").click());
    expect(container.textContent).toContain("Details for First output");
    expect(noteButton("First output").getAttribute("aria-expanded")).toBe(
      "true"
    );
    await act(async () => noteButton("First output").click());
    expect(container.textContent).not.toContain("Details for First output");
    expect(container.textContent).toContain("Details for Latest output");
    await act(async () => noteButton("Latest output").click());
    expect(container.textContent).not.toContain("Details for Latest output");
  }
);
it("makes earlier technical command outputs collapsible while the latest starts expanded", async () => {
  window.localStorage.setItem("memory-layer.build-view", "advanced");
  await act(async () =>
    root.render(
      <BuildViewProvider>
        <BuildActivityPanel
          initialMode="expanded"
          activity={{
            ...activity,
            events: [
              {
                id: "old",
                kind: "command",
                technical: {
                  command: "first command",
                  result: "First command output"
                }
              },
              {
                id: "new",
                kind: "command",
                technical: {
                  command: "latest command",
                  result: "Latest command output"
                }
              }
            ]
          }}
        />
      </BuildViewProvider>
    )
  );
  const [latest, older] = [...container.querySelectorAll("details")];
  expect(latest.querySelector("summary")?.textContent).toContain(
    "latest command"
  );
  expect(older.querySelector("summary")?.textContent).toContain(
    "first command"
  );
  expect(older.open).toBe(false);
  expect(latest.open).toBe(true);
  expect(older.textContent).toContain("First command output");
  await act(async () => {
    older.open = true;
    latest.open = false;
  });
  expect(older.open).toBe(true);
  expect(latest.open).toBe(false);
});

it.each([false, true])(
  "places the latest request's diff directly below its note before older outputs (named Agent: %s)",
  async (namedAgent) => {
    window.localStorage.setItem("memory-layer.build-view", "advanced");
    const latest = {
      ...activity.events[0],
      id: "command:latest",
      story: { title: "Latest request", detail: "Latest reply" }
    };
    const older = {
      id: "exchange:older",
      kind: "message" as const,
      story: { title: "Older request", detail: "Older reply" }
    };
    const diff = {
      id: "turn-diff:latest",
      kind: "workspace-observed" as const,
      technical: {
        files: [
          {
            path: "latest.html",
            change: "modified" as const,
            patch: "@@\n-old\n+new"
          }
        ]
      }
    };
    await act(async () =>
      root.render(
        <BuildViewProvider>
          <BuildActivityPanel
            initialMode="expanded"
            activity={{
              ...activity,
              events: namedAgent ? activity.events : [older, latest, diff],
              ...(namedAgent
                ? { recentExchanges: [older, latest], recentTurnChanges: diff }
                : {})
            }}
          />
        </BuildViewProvider>
      )
    );
    const list = [...container.querySelectorAll("ol")].find((list) =>
      list.textContent?.includes("Latest request")
    )!;
    expect(list.children[0].textContent).toContain("Latest request");
    expect(list.children[1].textContent).toContain("latest.html");
    expect(list.children[2].textContent).toContain("Older request");
    expect(
      container.querySelectorAll('[aria-label="Diff for latest.html"]')
    ).toHaveLength(1);
  }
);

it.each([
  {
    name: "reported totals",
    technical: { diff: { filesChanged: 1, additions: 12, deletions: 2 } },
    expected: "+12 lines added · −2 lines deleted"
  },
  {
    name: "per-file counts",
    technical: {
      files: [
        {
          path: "index.html",
          change: "modified" as const,
          additions: 2,
          deletions: 1
        }
      ]
    },
    expected: "+2 lines added · −1 line deleted"
  },
  {
    name: "reported zero",
    technical: { diff: { additions: 0, deletions: 0 } },
    expected: "+0 lines added · −0 lines deleted"
  },
  {
    name: "missing counts",
    technical: { files: [{ path: "index.html", change: "modified" as const }] },
    expected: "Line counts unavailable"
  }
])(
  "shows line counts instead of a status summary in compact Advanced ($name)",
  async ({ technical, expected }) => {
    window.localStorage.setItem("memory-layer.build-view", "advanced");
    await act(async () =>
      root.render(
        <BuildViewProvider>
          <BuildActivityPanel
            activity={{
              ...activity,
              events: [
                {
                  id: "older",
                  kind: "workspace-observed",
                  technical: { diff: { additions: 99, deletions: 99 } }
                },
                { id: "latest", kind: "workspace-observed", technical },
                ...activity.events
              ]
            }}
          />
        </BuildViewProvider>
      )
    );
    expect(container.textContent).toContain("Technical activity");
    expect(container.textContent).toContain(expected);
    expect(container.textContent).not.toContain("Status observed:");
    expect(container.textContent).not.toContain("+99");
  }
);
