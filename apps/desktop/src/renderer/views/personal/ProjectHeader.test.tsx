// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mergeProjectSources } from "../../../project-memory-ui.js";
import { ProjectHeader } from "./ProjectHeader.js";

const repository = {
  kind: "portable_repository" as const,
  key: "repository",
  root: "/work/first",
  branch: "main",
  reason: "origin" as const,
  checkoutId: "checkout-first",
  originatingDeviceId: "device",
  selectedRemote: "origin",
  anchorDisplay: "github.com/team/koed"
};
const project = mergeProjectSources(
  [],
  ["first", "second"].map((name) => ({
    schemaVersion: 1 as const,
    discoveredAt: "2026-10-16T00:00:00.000Z",
    lastSeenAt: "2026-10-16T00:00:00.000Z",
    localProjectId: name,
    displayName: "Koed",
    git: {
      branch: "main",
      isWorktree: false,
      remotes: [
        {
          name: name === "second" ? "upstream" : "origin",
          display: "github.com/team/koed"
        }
      ]
    },
    path: { cwd: `/work/${name}`, projectRoot: `/work/${name}` },
    repository: {
      ...repository,
      root: `/work/${name}`,
      checkoutId: `checkout-${name}`,
      selectedRemote: name === "second" ? "upstream" : "origin"
    }
  }))
)[0]!;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("keeps checkout paths and anchor edits in the card and preserves checkout-specific actions", async () => {
  const reveal = vi.fn();
  const review = vi.fn(async () => ({ events: [] }));
  const association = vi.fn(async () => ({
    checkoutId: "checkout-second",
    groupId: null,
    remotes: [],
    defaultRemote: null,
    deviceLabels: {},
    accepted: null,
    associations: []
  }));
  const setAnchor = vi.fn(async () => undefined);
  await act(async () =>
    root.render(
      <ProjectHeader
        project={project}
        onRevealLocalProject={reveal}
        onSetAnchor={setAnchor}
        onReview={review}
        onAssociation={association}
      >
        <button>New</button>
      </ProjectHeader>
    )
  );
  expect(container.textContent).not.toContain("/work/");
  expect(container.textContent).toContain("team/koed");
  expect(document.querySelector(".personal-project-details-card")).toBeNull();
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(".personal-project-details-trigger")!
      .click()
  );
  const card = document.querySelector(".personal-project-details-card")!;
  expect(card.textContent).toContain("/work/first");
  expect(card.textContent).toContain("/work/second");
  await act(async () =>
    card
      .querySelector<HTMLButtonElement>(
        '[aria-label="Open /work/second details"]'
      )!
      .click()
  );
  expect(card.textContent).toContain("Advanced");
  expect(card.textContent).not.toContain("/work/first");
  expect(card.querySelector('[aria-label="Repository checkout"]')).toBeNull();
  await act(async () =>
    card
      .querySelector<HTMLButtonElement>(
        '[aria-label="Reveal /work/second in file browser"]'
      )!
      .click()
  );
  expect(reveal).toHaveBeenCalledWith("second");
  const action = (text: string) =>
    [
      ...card.querySelectorAll<HTMLButtonElement>(
        ".personal-project-folder-action"
      )
    ].find((entry) => entry.textContent?.startsWith(text))!;
  await act(async () => action("Repository anchor").click());
  expect(document.activeElement?.textContent).toBe("Repository anchor");
  await act(async () =>
    card.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]!.click()
  );
  const remote = card.querySelector<HTMLInputElement>(
    '[aria-label="Selected repository remote"]'
  )!;
  expect(remote.value).toBe("upstream");
  expect(
    [...card.querySelectorAll("datalist option")].map((entry) =>
      entry.getAttribute("value")
    )
  ).toEqual(["upstream"]);
  await act(async () =>
    card
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  );
  expect(setAnchor).toHaveBeenCalledWith({
    localProjectId: "second",
    expectedCheckoutId: "checkout-second",
    remoteName: "upstream"
  });
  await act(async () =>
    card
      .querySelector<HTMLButtonElement>(
        '[aria-label="Back to folder details"]'
      )!
      .click()
  );
  await act(async () => action("Review previous assignments").click());
  expect(review).toHaveBeenCalledWith({
    operation: "list",
    localProjectId: "second"
  });
  await act(async () =>
    card
      .querySelector<HTMLButtonElement>(
        '[aria-label="Back to folder details"]'
      )!
      .click()
  );
  await act(async () => action("Share anchor across devices").click());
  expect(association).toHaveBeenCalledWith({
    operation: "inspect",
    localProjectId: "second"
  });
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>('[aria-label="Close Project details"]')!
      .click()
  );
  await vi.waitFor(() =>
    expect(document.querySelector(".personal-project-details-card")).toBeNull()
  );
});

it("supports Escape dismissal and restores focus to the opening trigger", async () => {
  await act(async () =>
    root.render(
      <ProjectHeader project={project}>
        <button>New</button>
      </ProjectHeader>
    )
  );
  const trigger = container.querySelector<HTMLButtonElement>(
    ".personal-project-repository-trigger"
  )!;
  await act(async () => {
    trigger.focus();
    trigger.click();
  });
  const card = document.querySelector(".personal-project-details-card")!;
  await act(async () =>
    card.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    )
  );
  await vi.waitFor(() =>
    expect(document.querySelector(".personal-project-details-card")).toBeNull()
  );
  await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
});

it("distinguishes same-path history and keeps its filter and checkout actions separate", async () => {
  const automatic = {
    ...repository,
    root: null,
    checkoutId: null,
    originatingDeviceId: "historical_unknown_device"
  };
  const source = {
    ...project,
    threads: [
      {
        id: "historical",
        sessionId: null,
        name: "Historical Conversation",
        sourceAiClient: "codex" as const,
        projectId: project.id,
        projectName: project.name,
        projectPath: "/work/first",
        capturedCwd: "/work/first",
        projectAssignmentSource: "detected" as const,
        eventCount: 1,
        invalidatedCount: 0,
        latestAt: "2026-10-16T00:00:00.000Z",
        sample: "",
        presentation: null,
        repositoryAssignment: {
          state: "recorded" as const,
          version: 1,
          automatic,
          override: null,
          effective: automatic
        }
      }
    ]
  };
  await act(async () =>
    root.render(
      <ProjectHeader project={source} onRevealLocalProject={vi.fn()}>
        <button>New</button>
      </ProjectHeader>
    )
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(".personal-project-details-trigger")!
      .click()
  );
  const card = document.querySelector(".personal-project-details-card")!;
  const history = card.querySelector<HTMLButtonElement>(
    '[aria-label="Open /work/first historical details"]'
  )!;
  const current = card.querySelector<HTMLButtonElement>(
    '[aria-label="Open /work/first details"]'
  )!;
  expect(history.textContent).toContain("first · Historical");
  expect(current.textContent).not.toContain("Historical");
  await act(async () => history.click());
  expect(
    card.querySelector('[aria-label="Reveal /work/first in file browser"]')
  ).toBeNull();
  expect(card.textContent).toContain("Historical");
  await act(async () =>
    card
      .querySelector<HTMLButtonElement>(
        '[aria-label="Back to Project details"]'
      )!
      .click()
  );
  await act(async () =>
    card
      .querySelector<HTMLButtonElement>(
        '[aria-label="Open /work/first details"]'
      )!
      .click()
  );
  expect(
    card.querySelector('[aria-label="Reveal /work/first in file browser"]')
  ).not.toBeNull();
});
