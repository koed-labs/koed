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
import type { ManagedConversationDesktopApi } from "../../../ipc/managed-conversation-protocol.js";
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

const managedApi = (
  overrides: Partial<ManagedConversationDesktopApi> = {}
): ManagedConversationDesktopApi => ({
  start: vi.fn<ManagedConversationDesktopApi["start"]>(async (projectId) => ({
    operation: "start",
    status: "ready",
    executionId: "execution-1",
    conversation: {
      executionId: "execution-1",
      projectId,
      capturedSessionId: sessionId,
      threadId: "managed-thread"
    }
  })),
  inspect: vi.fn<ManagedConversationDesktopApi["inspect"]>(
    async (executionId) => ({
      operation: "inspect",
      status: "starting",
      executionId
    })
  ),
  resume: vi.fn<ManagedConversationDesktopApi["resume"]>(
    async (conversation) => ({
      operation: "resume",
      status: "ready",
      conversation: {
        ...conversation,
        executionId: null
      }
    })
  ),
  send: vi.fn<ManagedConversationDesktopApi["send"]>(async (input) => ({
    operation: "send",
    status: "queued",
    conversation: {
      executionId: null,
      projectId: "project-1",
      capturedSessionId: input.capturedSessionId,
      threadId: input.threadId
    },
    idempotencyKey: input.idempotencyKey,
    turnId: "turn-1"
  })),
  targets: vi.fn<ManagedConversationDesktopApi["targets"]>(async () => ({
    operation: "targets",
    devices: []
  })),
  transferStatus: vi.fn<ManagedConversationDesktopApi["transferStatus"]>(
    async (executionId) => ({
      operation: "transfer_status",
      executionId,
      handoff: null,
      fork: null
    })
  ),
  handoff: vi.fn<ManagedConversationDesktopApi["handoff"]>(async (input) => ({
    operation: "handoff",
    status: "queued",
    ...input
  })),
  fork: vi.fn<ManagedConversationDesktopApi["fork"]>(async (input) => ({
    operation: "fork",
    status: "queued",
    executionId: input.executionId,
    operationId: input.operationId,
    targetDeviceId: input.targetDeviceId
  })),
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

const changeTextarea = (textarea: HTMLTextAreaElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value"
  )?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
};

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

  it("starts a managed Codex Conversation and keeps the multiline composer below the timeline", async () => {
    let finishSend:
      | ((
          value: Awaited<ReturnType<ManagedConversationDesktopApi["send"]>>
        ) => void)
      | undefined;
    const send = vi.fn(
      (input: Parameters<ManagedConversationDesktopApi["send"]>[0]) =>
        new Promise<Awaited<ReturnType<ManagedConversationDesktopApi["send"]>>>(
          (resolve) => {
            finishSend = resolve;
            void input;
          }
        )
    );
    const managed = managedApi({ send });
    const source = project([thread(2, { sessionId: null })]);
    const store = new PersonalMemoryStore(
      api({ listProjects: vi.fn(async () => [source]) })
    );

    await act(async () => {
      root.render(
        <Harness initialRoute={{ kind: "project", projectId: "project-1" }}>
          {({ onNavigate, route }) => (
            <PersonalMemoryWorkspace
              managedConversations={managed}
              onNavigate={onNavigate}
              route={route}
              store={store}
            />
          )}
        </Harness>
      );
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("New Conversation")
    );
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "New Conversation")
        ?.click();
    });
    await vi.waitFor(() =>
      expect(container.querySelector("textarea")?.disabled).toBe(false)
    );
    expect(managed.start).toHaveBeenCalledWith(
      "project-1",
      expect.stringMatching(/^desktop-conversation:/)
    );
    expect(managed.resume).toHaveBeenCalledWith({
      projectId: "project-1",
      capturedSessionId: sessionId,
      threadId: "managed-thread"
    });
    const shell = container.querySelector(".personal-conversation-shell");
    expect(shell?.lastElementChild?.classList).toContain(
      "personal-managed-composer"
    );

    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      changeTextarea(textarea, "First line\nSecond line");
    });
    expect(textarea.value).toBe("First line\nSecond line");
    const sendButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Send prompt"]'
    )!;
    await act(async () => {
      sendButton.click();
      sendButton.click();
    });
    expect(send).toHaveBeenCalledOnce();
    expect(sendButton.disabled).toBe(true);
    expect(container.textContent).toContain("Sending prompt to Codex");

    await act(async () =>
      finishSend?.({
        operation: "send",
        status: "queued",
        conversation: {
          executionId: null,
          projectId: "project-1",
          capturedSessionId: sessionId,
          threadId: "managed-thread"
        },
        idempotencyKey: send.mock.calls[0]![0].idempotencyKey,
        turnId: "turn-1"
      })
    );
    expect(textarea.value).toBe("");
  });

  it("preserves an ambiguous prompt and disables the composer while reconciling", async () => {
    const managed = managedApi({
      send: vi.fn<ManagedConversationDesktopApi["send"]>(async (input) => ({
        operation: "send",
        status: "reconciling",
        conversation: {
          executionId: null,
          projectId: "project-1",
          capturedSessionId: input.capturedSessionId,
          threadId: input.threadId
        },
        idempotencyKey: input.idempotencyKey,
        message: "Acceptance is indeterminate."
      }))
    });
    const source = project([thread(1)]);
    const store = new PersonalMemoryStore(
      api({
        listProjects: vi.fn(async () => [source]),
        loadEventPage: vi.fn(async () => [event(1)])
      })
    );
    await act(async () => {
      root.render(
        <PersonalMemoryWorkspace
          managedConversations={managed}
          onNavigate={vi.fn()}
          route={{
            kind: "session",
            projectId: "project-1",
            sessionId
          }}
          store={store}
        />
      );
    });
    await vi.waitFor(() =>
      expect(container.querySelector("textarea")?.disabled).toBe(false)
    );
    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      changeTextarea(textarea, "Do not duplicate this");
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Send prompt"]')
        ?.click();
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Acceptance is indeterminate.")
    );
    expect(textarea.value).toBe("Do not duplicate this");
    expect(textarea.disabled).toBe(true);
    expect(
      container.querySelector(".personal-managed-composer")?.className
    ).toContain("state-reconciling");
  });
});
