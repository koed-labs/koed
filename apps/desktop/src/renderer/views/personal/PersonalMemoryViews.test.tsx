// @vitest-environment happy-dom

import type {
  PersonalDesktopApi,
  PersonalDesktopConversationEvent,
  PersonalDesktopProject,
  PersonalDesktopProjectThread
} from "@koed/shared/personal-desktop";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PersonalMemoryStore } from "../../state/personal-memory.js";
import {
  PersonalMemoryWorkspace,
  type PersonalMemoryRoute
} from "./PersonalMemoryViews.js";

vi.mock("../../../NativeConversationSurface.js", () => ({
  NativeConversationSurface: ({
    model,
    onInspectEvent,
    onLoadOlder
  }: {
    model: {
      events: PersonalDesktopConversationEvent[];
      hasOlderEvents: boolean;
      status: string;
    };
    onInspectEvent?: (event: PersonalDesktopConversationEvent) => void;
    onLoadOlder: () => Promise<void>;
    thread: PersonalDesktopProjectThread;
  }) => (
    <div data-testid="conversation" data-status={model.status}>
      <span>{model.events.length} rendered events</span>
      {model.events.map((event) => (
        <button
          key={event.id}
          onClick={() => onInspectEvent?.(event)}
          type="button"
        >
          {event.contentPreview}
        </button>
      ))}
      {model.hasOlderEvents ? (
        <button onClick={() => void onLoadOlder()} type="button">
          Load older
        </button>
      ) : null}
    </div>
  )
}));

const sessionId = "00000000-0000-4000-8000-000000000001";

const thread = (
  index: number,
  overrides: Partial<PersonalDesktopProjectThread> = {}
): PersonalDesktopProjectThread => ({
  eventCount: 1_000,
  id: `thread-${index}`,
  invalidatedCount: index === 1 ? 2 : 0,
  latestAt: "2026-07-23T00:00:00.000Z",
  name: `Captured Session ${index}`,
  projectAssignmentSource: "detected",
  projectId: "project-1",
  projectName: "Very long Project name",
  projectPath: "/tmp/project",
  sample: `Useful session preview ${index}`,
  sessionId: index === 1 ? sessionId : null,
  sourceAiClient: "codex",
  ...overrides
});

const event = (index: number): PersonalDesktopConversationEvent => ({
  actor: index % 2 ? "assistant" : "user",
  content: `Event ${index}`,
  contentPreview: `Event ${index}`,
  eventType: "message",
  id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  invalidatedAt: null,
  metadata: {},
  sourceEventTime: null,
  sourceSequence: index,
  timestamp: new Date(Date.UTC(2026, 6, 23, 0, 0, index)).toISOString()
});

const project = (
  threads: PersonalDesktopProjectThread[]
): PersonalDesktopProject => ({
  eventCount: threads.reduce((count, item) => count + item.eventCount, 0),
  id: "project-1",
  name: `Project-${"unbroken".repeat(30)}`,
  path: `/tmp/${"long-path-segment".repeat(20)}`,
  threads
});

const api = (
  overrides: Partial<PersonalDesktopApi> = {}
): PersonalDesktopApi => ({
  assignSessionProject: vi.fn(async () => ({ projectId: null })),
  listProjects: vi.fn(async () => []),
  loadEventPage: vi.fn(async () => []),
  subscribe: vi.fn(() => () => undefined),
  ...overrides
});

function Harness({
  children,
  initialRoute
}: {
  children: (input: {
    onNavigate: (route: PersonalMemoryRoute) => void;
    route: PersonalMemoryRoute;
  }) => ReactNode;
  initialRoute: PersonalMemoryRoute;
}) {
  const [route, setRoute] = useState(initialRoute);
  return children({ onNavigate: setRoute, route });
}

describe("PersonalMemoryWorkspace", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("loads the normalized Project index and restores focus through drilldown", async () => {
    const source = project([thread(1)]);
    const store = new PersonalMemoryStore(
      api({ listProjects: vi.fn(async () => [source]) })
    );

    await act(async () => {
      root.render(
        <Harness initialRoute={{ kind: "projects" }}>
          {({ onNavigate, route }) => (
            <PersonalMemoryWorkspace
              onNavigate={onNavigate}
              route={route}
              store={store}
            />
          )}
        </Harness>
      );
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain(source.name)
    );

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-project-id="project-1"]')
        ?.click();
    });
    const heading = container.querySelector<HTMLElement>(
      '[data-personal-route-focus="project"]'
    );
    expect(
      container.querySelector(".personal-memory-workspace")?.className
    ).toContain("route-project");
    expect(document.activeElement).toBe(heading);
    expect(container.textContent).toContain("2 invalidated");
  });

  it("uses one warm cache authority for long-session load and paging", async () => {
    const selected = thread(1);
    const source = project([selected, thread(2), thread(3)]);
    const loadEventPage = vi
      .fn<PersonalDesktopApi["loadEventPage"]>()
      .mockImplementation(async (input) =>
        input.cursor
          ? [event(0), event(1)]
          : Array.from({ length: 50 }, (_, index) => event(index + 1))
      );
    const store = new PersonalMemoryStore(
      api({
        listProjects: vi.fn(async () => [source]),
        loadEventPage
      })
    );

    await act(async () => {
      root.render(
        <PersonalMemoryWorkspace
          onNavigate={vi.fn()}
          route={{
            kind: "session",
            projectId: source.id,
            sessionId
          }}
          store={store}
        />
      );
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("50 rendered events")
    );
    const selectedLoads = () =>
      loadEventPage.mock.calls.filter(
        ([input]) => input.threadId === selected.id
      );
    expect(selectedLoads()).toHaveLength(1);

    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Load older")
        ?.click();
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("51 rendered events")
    );
    expect(selectedLoads()).toHaveLength(2);
    expect(selectedLoads()[1]?.[0]).toMatchObject({
      limit: 500,
      cursor: { sourceSequence: 1 }
    });
  });

  it("fences a stale Project move response after the selected session changes", async () => {
    let resolveMove:
      | ((value: { projectId: string | null }) => void)
      | undefined;
    const assignSessionProject = vi.fn(
      () =>
        new Promise<{ projectId: string | null }>((resolve) => {
          resolveMove = resolve;
        })
    );
    const source = project([thread(1)]);
    const target = {
      ...project([]),
      id: "project-2",
      name: "Destination Project"
    };
    const store = new PersonalMemoryStore(
      api({
        listProjects: vi.fn(async () => [source, target]),
        loadEventPage: vi.fn(async () => [event(1)])
      })
    );
    const onAssigned = vi.fn();

    await act(async () => {
      root.render(
        <Harness
          initialRoute={{
            kind: "session",
            projectId: source.id,
            sessionId
          }}
        >
          {({ onNavigate, route }) => (
            <PersonalMemoryWorkspace
              assignSessionProject={assignSessionProject}
              onNavigate={onNavigate}
              onSessionProjectAssigned={onAssigned}
              route={route}
              store={store}
            />
          )}
        </Harness>
      );
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Project assignment")
    );

    const form = container.querySelector("form");
    await act(async () => {
      const select = form?.querySelector<HTMLSelectElement>("select");
      if (select) select.value = target.id;
      form?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      );
    });
    await act(async () => {
      root.render(
        <PersonalMemoryWorkspace
          onNavigate={vi.fn()}
          route={{ kind: "projects" }}
          store={store}
        />
      );
    });
    await act(async () => resolveMove?.({ projectId: "project-2" }));
    expect(onAssigned).not.toHaveBeenCalled();
  });

  it("passes only authorized destinations to sharing and keeps mapping advisory", async () => {
    const source = project([thread(1)]);
    const store = new PersonalMemoryStore(
      api({
        listProjects: vi.fn(async () => [source]),
        loadEventPage: vi.fn(async () => [event(1)])
      })
    );
    const onShare = vi.fn();

    await act(async () => {
      root.render(
        <PersonalMemoryWorkspace
          onNavigate={vi.fn()}
          onShareToWorkspace={onShare}
          projectWorkspaceSuggestions={[
            { projectId: source.id, workspaceId: "revoked" }
          ]}
          route={{
            kind: "session",
            projectId: source.id,
            sessionId
          }}
          sharingRecords={[]}
          store={store}
          workspaceCandidates={[
            {
              access: "write",
              authorized: true,
              lifecycle: "active",
              name: "Engineering",
              teamId: "team-1",
              teamLifecycle: "active",
              teamName: "Koed",
              workspaceId: "engineering"
            },
            {
              access: "write",
              authorized: false,
              lifecycle: "active",
              name: "Revoked",
              teamId: "team-1",
              teamLifecycle: "active",
              teamName: "Koed",
              workspaceId: "revoked"
            }
          ]}
        />
      );
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Share to Workspace…")
    );
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(".personal-share-button")
        ?.click();
    });

    expect(onShare).toHaveBeenCalledWith({
      destinations: [
        {
          name: "Engineering",
          teamId: "team-1",
          teamName: "Koed",
          workspaceId: "engineering"
        }
      ],
      source: {
        entryId: sessionId,
        logicalMemoryId: null,
        sessionId,
        syncState: "not_started"
      },
      suggestedWorkspaceId: null
    });
  });
});
