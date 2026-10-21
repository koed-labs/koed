// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { Project } from "@koed/shared/project-contract";
import type { WorkItem } from "@koed/shared/work-item-contract";
import type { ProjectsDesktopApi } from "../../../ipc/projects-protocol.js";
import type { DeckDesktopApi } from "../../../ipc/deck-protocol.js";
import type { CuratedMemoryDesktopApi } from "../../../ipc/curated-memory-protocol.js";
import { HqProjectView } from "./HqProjectView.js";

const projectId = "00000000-0000-4000-8000-000000008301";
const deckId = "00000000-0000-4000-8000-000000008302";
const stamp = "2026-10-21T10:00:00.000Z";
const project = {
  id: projectId,
  name: "Econ 101",
  lifecycle: "active"
} as Project;
const workItem: WorkItem = {
  id: "00000000-0000-4000-8000-000000008304",
  projectId,
  kind: "ticket",
  key: null,
  title: "Review Chapter 7",
  goal: "Review the source material",
  origin: "me",
  originRef: null,
  idempotencyKey: null,
  status: "doing",
  blockedReason: null,
  assigneeAgentId: null,
  executionId: null,
  dispatchKey: null,
  prProvider: null,
  prNumber: null,
  prUrl: null,
  prState: null,
  doneAt: null,
  doneBy: null,
  createdBy: "00000000-0000-4000-8000-000000008305",
  version: 1,
  dueOn: null,
  createdAt: stamp,
  updatedAt: stamp
};
const deck = {
  id: deckId,
  projectId,
  title: "Chapter 7 flashcards",
  scope: "Chapter 7",
  madeFrom: "Course pack",
  createdByAgentId: null,
  uses: 0,
  version: 1,
  createdAt: stamp,
  updatedAt: stamp,
  cards: [
    {
      id: "00000000-0000-4000-8000-000000008303",
      deckId,
      question: "What shifts supply?",
      answer: "Input costs.",
      sourceRef: "Chapter 7",
      topicLabel: null,
      version: 1,
      createdAt: stamp,
      updatedAt: stamp
    }
  ]
};
const projectsApi = {
  hq: vi.fn(async () => ({ project, activity: null })),
  workItemList: vi.fn(async () => [workItem]),
  sourceList: vi.fn(async () => [])
} as unknown as ProjectsDesktopApi;
const memoryApi = {
  page: vi.fn(async () => ({ assertions: [], nextCursor: null }))
} as unknown as CuratedMemoryDesktopApi;

describe("Project HQ right-panel exclusivity", () => {
  const mount = async (decksApi: DeckDesktopApi) => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const node = document.createElement("div");
    const panelHost = document.createElement("div");
    document.body.append(node, panelHost);
    const root = createRoot(node);
    const onPanel = vi.fn();
    const onContext = vi.fn();
    const onDismiss = vi.fn();
    await act(async () =>
      root.render(
        <HqProjectView
          project={project}
          personalProjects={[project]}
          graphProjects={[]}
          projectsApi={projectsApi}
          decksApi={decksApi}
          curatedMemoryApi={memoryApi}
          ownerId="owner"
          profileKey="profile"
          panelHost={panelHost}
          onSourcesOpenChange={onPanel}
          onContextChange={onContext}
          onDeckDismissed={onDismiss}
          onSelectConversation={() => undefined}
        />
      )
    );
    return {
      node,
      panelHost,
      onPanel,
      onContext,
      onDismiss,
      async unmount() {
        await act(async () => root.unmount());
        node.remove();
        panelHost.remove();
      }
    };
  };
  const decksApi = {
    list: vi.fn(async () => ({ decks: [deck] })),
    open: vi.fn(async () => deck),
    progress: vi.fn(async () => ({ progress: [] }))
  } as unknown as DeckDesktopApi;

  it("silently dismisses Deck when Sources, Memory, or a Work Item takes the panel", async () => {
    const view = await mount(decksApi);
    const openDeck = async () => {
      await act(async () =>
        view.node.querySelector<HTMLButtonElement>(".hq-decks__chip")!.click()
      );
      expect(view.panelHost.querySelectorAll(".hq-decks__panel")).toHaveLength(
        1
      );
    };
    try {
      await openDeck();
      await act(async () =>
        view.node
          .querySelector<HTMLButtonElement>(".hq-project-sources__count")!
          .click()
      );
      expect(view.panelHost.querySelector(".hq-decks__panel")).toBeNull();
      expect(
        view.panelHost.querySelector(".hq-project-sources__panel")
      ).not.toBeNull();
      expect(view.onPanel.mock.lastCall).toEqual([true]);

      await openDeck();
      await act(async () =>
        view.node
          .querySelector<HTMLButtonElement>("[aria-label='What Koed knows']")!
          .click()
      );
      expect(view.panelHost.querySelector(".hq-decks__panel")).toBeNull();
      expect(view.panelHost.querySelector(".hq-knows")).not.toBeNull();
      expect(view.onPanel.mock.lastCall).toEqual([true]);

      await openDeck();
      await act(async () =>
        view.node
          .querySelector<HTMLButtonElement>(".hq-project-view__brief-trigger")!
          .click()
      );
      expect(view.panelHost.querySelector(".hq-decks__panel")).toBeNull();
      expect(
        view.panelHost.querySelector(".hq-project-view__brief")
      ).not.toBeNull();
      expect(view.onPanel.mock.lastCall).toEqual([true]);
      expect(view.onDismiss).toHaveBeenCalledTimes(3);
    } finally {
      await view.unmount();
    }
  });

  it("ignores a late Deck read after Sources opened", async () => {
    let resolveOpen!: (value: typeof deck) => void;
    const pendingApi = {
      list: async () => ({ decks: [deck] }),
      open: () =>
        new Promise<typeof deck>((resolve) => {
          resolveOpen = resolve;
        }),
      progress: async () => ({ progress: [] })
    } as unknown as DeckDesktopApi;
    const view = await mount(pendingApi);
    try {
      await act(async () =>
        view.node.querySelector<HTMLButtonElement>(".hq-decks__chip")!.click()
      );
      await act(async () =>
        view.node
          .querySelector<HTMLButtonElement>(".hq-project-sources__count")!
          .click()
      );
      await act(async () => resolveOpen(deck));
      expect(view.panelHost.querySelector(".hq-decks__panel")).toBeNull();
      expect(
        view.panelHost.querySelector(".hq-project-sources__panel")
      ).not.toBeNull();
      expect(view.onPanel.mock.lastCall).toEqual([true]);
      expect(view.onContext.mock.lastCall?.[0]).not.toBe(deck.title);
    } finally {
      await view.unmount();
    }
  });
});
