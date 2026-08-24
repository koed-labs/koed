// @vitest-environment happy-dom

import type {
  PersonalDesktopApi,
  PersonalDesktopChange,
  PersonalDesktopConversationEvent,
  PersonalDesktopProject,
  PersonalDesktopProjectMetadata,
  PersonalDesktopProjectThread
} from "@koed/shared/personal-desktop";
import { PERSONAL_DESKTOP_CONTRACT_VERSION } from "@koed/shared/personal-desktop";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PersonalMemoryStore } from "../../state/personal-memory.js";
import type { ManagedConversationRealtimeUpdate } from "../../state/managed-conversation-runtime.js";
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
const threadLatestAt = new Date(
  Date.now() - 24 * 60 * 60 * 1_000
).toISOString();

const thread = (
  index: number,
  overrides: Partial<PersonalDesktopProjectThread> = {}
): PersonalDesktopProjectThread => ({
  eventCount: 1_000,
  id: `thread-${index}`,
  invalidatedCount: index === 1 ? 2 : 0,
  latestAt: threadLatestAt,
  name: `Captured Session ${index}`,
  projectAssignmentSource: "detected",
  projectId: "project-1",
  projectName: "Very long Project name",
  projectPath: "/tmp/project",
  sample: `Useful session preview ${index}`,
  presentation: null,
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
  updateSessionPresentation: vi.fn(async () => {
    throw new Error("not used");
  }),
  listProjects: vi.fn(async () => []),
  loadEventPage: vi.fn(async () => []),
  updateSessionTitle: vi.fn(async ({ title }) => ({ title })),
  subscribe: vi.fn(() => () => undefined),
  ...overrides
});

const managedApi = (
  overrides: Partial<ManagedConversationDesktopApi> = {}
): ManagedConversationDesktopApi => ({
  launchOptions: vi.fn<ManagedConversationDesktopApi["launchOptions"]>(
    async () => ({
      operation: "launch_options",
      options: {
        runners: [
          {
            kind: "local_device",
            deploymentId: "deployment-1",
            deviceId: "device-1",
            displayName: "This device"
          }
        ],
        instances: [
          {
            instanceId: "codex.default",
            driverId: "codex",
            displayName: "Codex",
            ready: true,
            readiness: "ready",
            models: [
              {
                id: "gpt-test",
                displayName: "GPT Test",
                isDefault: true,
                supportedReasoningEfforts: ["low", "high"],
                defaultReasoningEffort: "low"
              }
            ],
            capabilities: {
              defaultPermissionMode: "full_access",
              permissionModes: [
                { mode: "supervised", support: "supported" },
                { mode: "full_access", support: "supported" }
              ]
            }
          }
        ]
      }
    })
  ),
  start: vi.fn<ManagedConversationDesktopApi["start"]>(async (input) => ({
    operation: "start",
    status: "ready",
    executionId: "execution-1",
    conversation: {
      executionId: "execution-1",
      projectId: input.projectId,
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
        executionId: "execution-1"
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
    clientUserMessageId: input.clientUserMessageId,
    turnId: "turn-1"
  })),
  readDraft: vi.fn<ManagedConversationDesktopApi["readDraft"]>(async () => ({
    operation: "draft_read",
    value: ""
  })),
  writeDraft: vi.fn<ManagedConversationDesktopApi["writeDraft"]>(async () => ({
    operation: "draft_write",
    ok: true
  })),
  deleteDraft: vi.fn<ManagedConversationDesktopApi["deleteDraft"]>(
    async () => ({
      operation: "draft_delete",
      ok: true
    })
  ),
  targets: vi.fn<ManagedConversationDesktopApi["targets"]>(async () => ({
    operation: "targets",
    devices: []
  })),
  usage: vi.fn<ManagedConversationDesktopApi["usage"]>(async (executionId) => ({
    operation: "usage",
    executionId,
    provider: "codex",
    usage: null
  })),
  runtime: vi.fn<ManagedConversationDesktopApi["runtime"]>(
    async (executionId) => ({
      operation: "runtime",
      executionId,
      executionGeneration: 1,
      executionStateVersion: 1,
      executionState: "running",
      executionLastErrorCode: null,
      latestCommand: null,
      items: []
    })
  ),
  respond: vi.fn<ManagedConversationDesktopApi["respond"]>(async (input) => ({
    operation: "runtime_respond",
    accepted: true,
    itemId: input.itemId
  })),
  interrupt: vi.fn<ManagedConversationDesktopApi["interrupt"]>(
    async (input) => ({
      operation: "interrupt",
      status: "queued",
      executionId: input.executionId,
      commandId: "interrupt-command"
    })
  ),
  stop: vi.fn<ManagedConversationDesktopApi["stop"]>(async (input) => ({
    operation: "stop",
    status: "queued",
    executionId: input.executionId,
    commandId: "stop-command"
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

const changeInput = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
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
    const source = project([thread(1, { sourceAiClient: "pi" })]);
    const metadata: PersonalDesktopProjectMetadata = {
      schemaVersion: 1,
      discoveredAt: "2026-07-23T00:00:00.000Z",
      lastSeenAt: "2026-07-24T00:00:00.000Z",
      localProjectId: "local-project-1",
      displayName: source.name,
      path: { cwd: source.path!, projectRoot: source.path },
      git: {
        branch: "main",
        isWorktree: false,
        remotes: [{ display: "github.com/koed-labs/koed" }]
      }
    };
    const store = new PersonalMemoryStore(
      api({
        listProjects: vi.fn(async () => [source]),
        listProjectMetadata: vi.fn(async () => [metadata])
      })
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
    const activeProjects = container.querySelector(
      '[aria-label="Active Projects"]'
    );
    expect(activeProjects).not.toBeNull();
    expect(activeProjects?.textContent).not.toContain("Active");
    expect(container.textContent).toContain("koed-labs/koed");
    const overview = container.querySelector(
      '[data-project-id="project-1"] .personal-project-overview'
    );
    expect(overview?.getAttribute("aria-label")).toBe(
      "1 Captured Session · 1000 Memory Events"
    );
    expect(overview?.querySelector(".lucide-brain")).not.toBeNull();
    expect(overview?.querySelector(".lucide-book-text")).not.toBeNull();

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
    expect(
      container.querySelector(".personal-session-row .lucide-brain")
    ).not.toBeNull();
    const sourceMark = container.querySelector(
      '.personal-ai-client-mark[data-client="pi"]'
    );
    expect(sourceMark?.getAttribute("aria-label")).toBe("Captured with Pi");
    expect(sourceMark?.getAttribute("title")).toBe("Pi");
    expect(sourceMark?.querySelector("svg path")).not.toBeNull();
    expect(container.querySelector(".personal-sessions > header")).toBeNull();
  });

  it("separates pinned, active, settled, and snoozed Conversations without lifecycle mutation", async () => {
    const currentTime = Date.now();
    const today = new Date(currentTime).toISOString();
    const tomorrow = new Date(currentTime + 24 * 60 * 60 * 1_000).toISOString();
    const presentation = (
      displayMode: "automatic" | "active" | "settled",
      overrides: Partial<
        NonNullable<PersonalDesktopProjectThread["presentation"]>
      > = {}
    ) => ({
      pinnedAt: null,
      displayMode,
      snoozedAt: null,
      snoozedUntil: null,
      version: 4,
      updatedAt: "2026-07-24T00:00:00.000Z",
      ...overrides
    });
    const pinned = thread(1, {
      presentation: presentation("automatic", {
        pinnedAt: "2026-07-24T00:00:00.000Z"
      })
    });
    const settled = thread(2, {
      latestAt: "2026-07-01T00:00:00.000Z",
      name: "Automatically settled",
      presentation: presentation("automatic"),
      sessionId: "00000000-0000-4000-8000-000000000002"
    });
    const snoozed = thread(3, {
      name: "Temporarily snoozed",
      presentation: presentation("automatic", {
        snoozedAt: today,
        snoozedUntil: tomorrow
      }),
      sessionId: "00000000-0000-4000-8000-000000000003"
    });
    const keptActive = thread(4, {
      latestAt: "2026-06-01T00:00:00.000Z",
      name: "Manually active",
      presentation: presentation("active"),
      sessionId: "00000000-0000-4000-8000-000000000004"
    });
    const source = project([pinned, settled, snoozed, keptActive]);
    const listProjects = vi.fn(async () => [source]);
    const updateSessionPresentation = vi.fn<
      PersonalDesktopApi["updateSessionPresentation"]
    >(async () => ({ presentation: presentation("settled", { version: 5 }) }));
    const store = new PersonalMemoryStore(api({ listProjects }));

    await act(async () => {
      root.render(
        <PersonalMemoryWorkspace
          onNavigate={vi.fn()}
          route={{ kind: "project", projectId: source.id }}
          store={store}
          updateSessionPresentation={updateSessionPresentation}
        />
      );
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Manually active")
    );
    expect(
      container.querySelector('[aria-label="Pinned Conversations"]')
        ?.textContent
    ).toContain(pinned.name);
    expect(container.textContent).toContain("Settled & snoozed2");
    expect(
      container.querySelector(".personal-settled-sessions")?.textContent
    ).toContain("Automatically settled");
    expect(
      container.querySelector(".personal-settled-sessions")?.textContent
    ).toContain("Temporarily snoozed");

    await act(async () => {
      container
        .querySelector<HTMLElement>(
          '[aria-label="Conversation actions for Manually active"]'
        )
        ?.click();
    });
    const activeShell = container
      .querySelector('[data-session-id="00000000-0000-4000-8000-000000000004"]')
      ?.closest(".personal-session-row");
    await act(async () => {
      [...(activeShell?.querySelectorAll("button") ?? [])]
        .find((button) => button.textContent?.trim() === "Settle")
        ?.click();
    });
    await vi.waitFor(() =>
      expect(updateSessionPresentation).toHaveBeenCalledWith({
        sessionId: "00000000-0000-4000-8000-000000000004",
        expectedVersion: 4,
        displayMode: "settled"
      })
    );
  });

  it("renders nested child Agents once beneath their parent Conversation", async () => {
    const parent = thread(1, {
      threadKind: "conversation",
      parentThreadId: null
    });
    const child = thread(2, {
      name: "Research Agent",
      sessionId: "00000000-0000-4000-8000-000000000002",
      threadKind: "subagent",
      parentThreadId: parent.id
    });
    const grandchild = thread(3, {
      name: "Verification Agent",
      sessionId: "00000000-0000-4000-8000-000000000003",
      threadKind: "subagent",
      parentThreadId: child.id
    });
    const source = project([parent, child, grandchild]);
    const store = new PersonalMemoryStore(
      api({ listProjects: vi.fn(async () => [source]) })
    );

    await act(async () => {
      root.render(
        <PersonalMemoryWorkspace
          onNavigate={vi.fn()}
          route={{ kind: "project", projectId: source.id }}
          store={store}
        />
      );
    });

    await vi.waitFor(() =>
      expect(container.textContent).toContain("Verification Agent")
    );
    expect(
      container.querySelectorAll('[aria-label="Child Agents"]')
    ).toHaveLength(2);
    expect(container.textContent?.match(/Research Agent/g)).toHaveLength(1);
    expect(container.textContent?.match(/Verification Agent/g)).toHaveLength(1);
  });

  it("provides initial Project loading states for wide and narrow layouts", async () => {
    const store = new PersonalMemoryStore(
      api({
        listProjects: vi.fn(
          () => new Promise<PersonalDesktopProject[]>(() => undefined)
        )
      })
    );

    await act(async () => {
      root.render(
        <PersonalMemoryWorkspace
          onNavigate={vi.fn()}
          route={{ kind: "projects" }}
          store={store}
        />
      );
    });

    expect(
      container
        .querySelector('.personal-memory-detail-pane [role="status"]')
        ?.getAttribute("aria-label")
    ).toBe("Loading Projects");
    expect(
      container.querySelector(
        ".personal-memory-detail-pane .personal-loading-icon"
      )
    ).not.toBeNull();
    expect(
      container
        .querySelector('.personal-projects-narrow-state[role="status"]')
        ?.getAttribute("aria-label")
    ).toBe("Loading Projects");
    expect(
      container.querySelector(
        ".personal-projects-narrow-state .personal-loading-icon"
      )
    ).not.toBeNull();
    expect(
      container.querySelector(".personal-projects-narrow-state")?.textContent
    ).toBe("");
  });

  it("waits for local API readiness before loading Projects", async () => {
    const listProjects = vi.fn(async () => []);
    const store = new PersonalMemoryStore(api({ listProjects }));

    await act(async () => {
      root.render(
        <PersonalMemoryWorkspace
          onNavigate={vi.fn()}
          ready={false}
          route={{ kind: "projects" }}
          store={store}
        />
      );
    });
    expect(listProjects).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Projects unavailable");
    expect(
      container
        .querySelector('.personal-memory-detail-pane [role="status"]')
        ?.getAttribute("aria-label")
    ).toBe("Loading Projects");

    await act(async () => {
      root.render(
        <PersonalMemoryWorkspace
          onNavigate={vi.fn()}
          ready
          route={{ kind: "projects" }}
          store={store}
        />
      );
    });
    await vi.waitFor(() => expect(listProjects).toHaveBeenCalledTimes(1));
  });

  it("places the empty Projects guidance in the detail pane", async () => {
    const store = new PersonalMemoryStore(api());

    await act(async () => {
      root.render(
        <PersonalMemoryWorkspace
          onNavigate={vi.fn()}
          route={{ kind: "projects" }}
          store={store}
        />
      );
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("No Projects yet")
    );
    const detail = container.querySelector(".personal-memory-detail-pane");
    const list = container.querySelector(".personal-project-list");
    expect(detail?.textContent).toContain(
      "Projects appear after the Supported Capture Hook records a Captured Session."
    );
    expect(list?.textContent).not.toContain("No Projects yet");
    expect(
      container.querySelector(".personal-memory-empty-detail .lucide-book-text")
    ).not.toBeNull();
  });

  it("provides actionable Project loading failures for wide and narrow layouts", async () => {
    const listProjects = vi.fn(async () => {
      throw new Error("internal transport detail");
    });
    const store = new PersonalMemoryStore(api({ listProjects }));

    await act(async () => {
      root.render(
        <PersonalMemoryWorkspace
          onNavigate={vi.fn()}
          route={{ kind: "projects" }}
          store={store}
        />
      );
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Projects unavailable")
    );
    expect(
      container.querySelector(".personal-projects-narrow-state")?.textContent
    ).toContain("Projects unavailable");
    expect(
      container.querySelector(".personal-memory-detail-pane")?.textContent
    ).toContain("Projects unavailable");
    expect(container.textContent).not.toContain("No Projects yet");
    expect(container.textContent).not.toContain("internal transport detail");
    expect(
      container.querySelector(
        ".personal-memory-detail-pane .lucide-circle-alert"
      )
    ).not.toBeNull();
    expect(
      container.querySelector(
        ".personal-projects-narrow-state .lucide-circle-alert"
      )
    ).not.toBeNull();
    const retry = container.querySelector<HTMLButtonElement>(
      ".personal-projects-narrow-state .personal-retry-button"
    );
    expect(retry?.classList).toContain("personal-retry-button");
    await act(async () => retry?.click());
    expect(listProjects).toHaveBeenCalledTimes(2);
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
    expect(
      container.querySelector(".personal-session-detail > header small")
        ?.textContent
    ).toBe(`${source.name} · Private to you`);
    expect(
      container
        .querySelector(".personal-session-detail .personal-memory-event-count")
        ?.getAttribute("aria-label")
    ).toBe("1000 Memory Events");
    expect(
      container.querySelector(
        ".personal-session-detail .personal-memory-event-count .lucide-brain"
      )
    ).not.toBeNull();
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

  it("keeps the composer in the final Conversation row after a load failure", async () => {
    const selected = thread(1);
    const source = project([selected]);
    const store = new PersonalMemoryStore(
      api({
        listProjects: vi.fn(async () => [source]),
        loadEventPage: vi.fn(async () => {
          throw new Error(
            "Local Personal Memory returned an invalid response."
          );
        })
      })
    );

    await act(async () => {
      root.render(
        <PersonalMemoryWorkspace
          managedConversations={managedApi()}
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
      expect(
        container
          .querySelector('[data-testid="conversation"]')
          ?.getAttribute("data-status")
      ).toBe("error")
    );

    const shell = container.querySelector(".personal-conversation-shell");
    expect(
      shell?.firstElementChild?.querySelector(".personal-conversation-timeline")
    ).not.toBeNull();
    expect(shell?.lastElementChild?.classList).toContain(
      "personal-managed-composer"
    );
  });

  it("renames a Captured Session from the preview header", async () => {
    const selected = thread(1);
    const source = project([selected]);
    const renamed = project([{ ...selected, name: "Release planning" }]);
    const listProjects = vi
      .fn<PersonalDesktopApi["listProjects"]>()
      .mockResolvedValueOnce([source])
      .mockResolvedValue([renamed]);
    const updateSessionTitle = vi.fn<PersonalDesktopApi["updateSessionTitle"]>(
      async ({ title }) => ({ title })
    );
    const store = new PersonalMemoryStore(
      api({
        listProjects,
        loadEventPage: vi.fn(async () => [event(1)]),
        updateSessionTitle
      })
    );

    await act(async () => {
      root.render(
        <PersonalMemoryWorkspace
          onNavigate={vi.fn()}
          route={{ kind: "session", projectId: source.id, sessionId }}
          store={store}
        />
      );
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Captured Session 1")
    );

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Rename Captured Session"]'
        )
        ?.click();
    });
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-labelledby="personal-session-title-label"], #personal-session-title'
    )!;
    await act(async () => changeInput(input, "Release planning"));
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Save Captured Session name"]'
        )
        ?.click();
    });

    await vi.waitFor(() =>
      expect(updateSessionTitle).toHaveBeenCalledWith({
        sessionId,
        title: "Release planning"
      })
    );
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Release planning")
    );
    expect(
      container.querySelector('button[aria-label="Rename Captured Session"]')
    ).not.toBeNull();
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
    const manage = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Manage Captured Session"]'
    );
    expect(manage?.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    expect(container.textContent).not.toContain("Move to Project:");
    expect(container.textContent).not.toContain("Move to another Project");

    await act(async () => manage?.click());
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Move to Project:")
    );
    expect(
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent === "Move")
        ?.classList.contains("personal-move-button")
    ).toBe(true);

    const form = document.querySelector(
      ".personal-session-assignment-dialog form"
    );
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
    await vi.waitFor(() => expect(container.textContent).toContain("Share"));
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
        localEntry: {
          id: sessionId,
          logicalMemoryId: null,
          title: "Captured Session 1",
          projectName: "Very long Project name",
          updatedAt: threadLatestAt,
          preview: "Useful session preview 1",
          eventCount: 1_000,
          hasSynchronizedRevision: false,
          syncState: "not_started"
        },
        logicalMemoryId: null,
        sessionId,
        syncState: "not_started"
      },
      suggestedWorkspaceId: null
    });
  });

  it("starts a managed Codex Conversation and keeps the chat-style composer below the timeline", async () => {
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
    const managed = managedApi({
      send,
      readDraft: vi.fn<ManagedConversationDesktopApi["readDraft"]>(
        async () => ({ operation: "draft_read", value: "Recovered draft" })
      )
    });
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
    await vi.waitFor(() => expect(container.textContent).toContain("New"));
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "New")
        ?.click();
    });
    await vi.waitFor(() =>
      expect(container.querySelector("textarea")?.value).toBe("Recovered draft")
    );
    expect(managed.start).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        aiClientDriverId: "codex",
        aiClientInstanceId: "codex.default",
        model: "gpt-test",
        reasoningEffort: "low",
        permissionMode: "full_access",
        runnerKind: "local_device",
        idempotencyKey: expect.stringMatching(/^desktop-conversation:/)
      })
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
    expect(container.textContent).not.toContain("Execution owner:");
    expect(
      shell?.querySelector(".personal-managed-composer-field")
    ).not.toBeNull();

    const textarea = container.querySelector("textarea")!;
    expect(textarea.getAttribute("rows")).toBe("1");
    expect(textarea.value).toBe("Recovered draft");
    expect(managed.readDraft).toHaveBeenCalledWith({
      projectId: "project-1",
      capturedSessionId: "execution-1",
      threadId: "execution-1"
    });
    await act(async () => {
      changeTextarea(textarea, "First line\nSecond line");
    });
    expect(textarea.value).toBe("First line\nSecond line");
    await vi.waitFor(() =>
      expect(managed.writeDraft).toHaveBeenCalledWith({
        projectId: "project-1",
        capturedSessionId: "execution-1",
        threadId: "execution-1",
        value: "First line\nSecond line"
      })
    );
    const sendButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Send prompt"]'
    )!;
    await act(async () => {
      sendButton.click();
      sendButton.click();
    });
    expect(send).toHaveBeenCalledOnce();
    expect(sendButton.disabled).toBe(true);
    expect(container.textContent).not.toContain("Sending prompt to Codex");
    expect(container.textContent).toContain("First line\nSecond line");
    expect(textarea.value).toBe("");
    expect(textarea.disabled).toBe(false);

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
        clientUserMessageId: send.mock.calls[0]![0].clientUserMessageId,
        turnId: "turn-1"
      })
    );
    expect(textarea.value).toBe("");
    expect(managed.deleteDraft).toHaveBeenCalledWith({
      projectId: "project-1",
      capturedSessionId: "execution-1",
      threadId: "execution-1"
    });
  });

  it.each(["canonical", "completed_command"])(
    "reconciles an optimistic prompt using exact %s identity",
    async (correlation) => {
      let emitChange: (change: PersonalDesktopChange) => void = () => undefined;
      let events = [event(1)];
      const managed = managedApi();
      vi.mocked(managed.send).mockImplementation(async (input) => ({
        operation: "send",
        status: "queued",
        conversation: {
          executionId: input.executionId,
          projectId: "project-1",
          capturedSessionId: input.capturedSessionId,
          threadId: input.threadId
        },
        idempotencyKey: input.idempotencyKey,
        clientUserMessageId: input.clientUserMessageId
      }));
      const source = project([thread(1)]);
      const loadEventPage = vi.fn(async () => events);
      const store = new PersonalMemoryStore(
        api({
          listProjects: vi.fn(async () => [source]),
          loadEventPage,
          subscribe: vi.fn((listener) => {
            emitChange = listener;
            return () => undefined;
          })
        }),
        0
      );
      await act(async () => {
        root.render(
          <PersonalMemoryWorkspace
            managedConversations={managed}
            onNavigate={vi.fn()}
            route={{ kind: "session", projectId: "project-1", sessionId }}
            store={store}
          />
        );
      });
      await vi.waitFor(() =>
        expect(container.querySelector("textarea")?.disabled).toBe(false)
      );
      const textarea = container.querySelector("textarea")!;
      await act(async () => changeTextarea(textarea, "Exact pending prompt"));
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('button[aria-label="Send prompt"]')
          ?.click();
      });
      await vi.waitFor(() => expect(managed.send).toHaveBeenCalledOnce());
      expect(
        [...container.querySelectorAll("button")].filter(
          (button) => button.textContent === "Exact pending prompt"
        )
      ).toHaveLength(1);

      const clientUserMessageId = vi.mocked(managed.send).mock.calls[0]![0]
        .clientUserMessageId;
      const canonical = {
        ...event(99),
        actor: "user",
        content: "Exact pending prompt",
        contentPreview: "Exact pending prompt",
        metadata: correlation === "canonical" ? { clientUserMessageId } : {}
      } satisfies PersonalDesktopConversationEvent;
      events = [event(1), canonical];
      await act(async () => {
        emitChange({
          contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
          type: "conversation_events_changed",
          eventRefs: [
            {
              id: canonical.id,
              projectId: "project-1",
              sourceTable: "messages",
              threadId: "thread-1"
            }
          ]
        });
      });
      await vi.waitFor(() => expect(loadEventPage).toHaveBeenCalledTimes(2));
      if (correlation === "completed_command") {
        const previous = await managed.runtime("execution-1");
        vi.mocked(managed.runtime).mockResolvedValue({
          ...previous,
          latestCommand: {
            id: "00000000-0000-4000-8000-000000000010",
            sequence: 1,
            executionGeneration: 1,
            commandKind: "prompt",
            clientUserMessageId,
            state: "completed",
            lastErrorCode: null,
            updatedAt: new Date().toISOString()
          }
        });
        await act(async () =>
          root.render(
            <PersonalMemoryWorkspace
              managedConversations={managed}
              managedConversationRecoveryRevision={1}
              onNavigate={vi.fn()}
              route={{ kind: "session", projectId: "project-1", sessionId }}
              store={store}
            />
          )
        );
      }

      expect(
        [...container.querySelectorAll("button")].filter(
          (button) => button.textContent === "Exact pending prompt"
        )
      ).toHaveLength(1);
    }
  );

  it.each(["item-1", null])(
    "streams output with provider item identity %s without reattaching or stealing focus",
    async (providerItemId) => {
      const managed = managedApi();
      const source = project([thread(1)]);
      const store = new PersonalMemoryStore(
        api({
          listProjects: vi.fn(async () => [source]),
          loadEventPage: vi.fn(async () => [event(1)])
        })
      );
      const render = (
        revision: number,
        realtimeUpdate: ManagedConversationRealtimeUpdate | null = null,
        recoveryRevision = 0
      ) => (
        <PersonalMemoryWorkspace
          managedConversationRevision={revision}
          managedConversationRecoveryRevision={recoveryRevision}
          managedConversationUpdate={
            realtimeUpdate ? { revision, update: realtimeUpdate } : null
          }
          managedConversations={managed}
          onNavigate={vi.fn()}
          route={{ kind: "session", projectId: "project-1", sessionId }}
          store={store}
        />
      );
      await act(async () => root.render(render(0)));
      await vi.waitFor(() =>
        expect(container.querySelector("textarea")?.disabled).toBe(false)
      );
      const textarea = container.querySelector("textarea")!;
      textarea.focus();
      const resumeCalls = vi.mocked(managed.resume).mock.calls.length;
      const usageCalls = vi.mocked(managed.usage).mock.calls.length;
      const runtimeCalls = vi.mocked(managed.runtime).mock.calls.length;
      await act(async () =>
        root.render(
          render(1, {
            type: "managed_conversation_upserted",
            execution: {
              id: "execution-1",
              projectId: "project-1",
              provider: "codex",
              state: "running",
              stateVersion: 2,
              executionGeneration: 1,
              logicalSessionId: null,
              sessionId,
              providerThreadId: "thread-1",
              providerCliVersion: "test",
              lastErrorCode: null,
              createdAt: threadLatestAt,
              updatedAt: threadLatestAt,
              startedAt: threadLatestAt,
              quiescedAt: null,
              stoppedAt: null
            },
            latestCommand: {
              clientUserMessageId: null,
              id: "00000000-0000-4000-8000-000000000010",
              sequence: 1,
              executionGeneration: 1,
              commandKind: "prompt",
              state: "dispatching",
              lastErrorCode: null,
              updatedAt: threadLatestAt
            },
            runtimeItemChange: {
              kind: "upsert",
              item: {
                id: "00000000-0000-4000-8000-000000000011",
                executionGeneration: 1,
                providerTurnId: "turn-1",
                providerItemId,
                itemKind: "transient_output",
                presentation: {
                  mode: "expanded",
                  renderer: "message",
                  policyKey: "agent_message",
                  policyRevision: 1,
                  reason: "presentation-policy:agent_message"
                },
                state: "pending",
                payload: { text: "Incremental provider output" },
                revision: 1,
                createdAt: threadLatestAt,
                updatedAt: threadLatestAt,
                answered: false
              }
            }
          })
        )
      );
      await vi.waitFor(() =>
        expect(container.textContent).toContain("Incremental provider output")
      );
      expect(managed.resume).toHaveBeenCalledTimes(resumeCalls);
      expect(managed.runtime).toHaveBeenCalledTimes(runtimeCalls);
      expect(managed.usage).toHaveBeenCalledTimes(usageCalls + 1);
      expect(document.activeElement).toBe(textarea);
      await act(async () => root.render(render(1, null, 1)));
      await vi.waitFor(() =>
        expect(vi.mocked(managed.runtime).mock.calls.length).toBeGreaterThan(
          runtimeCalls
        )
      );
      expect(document.activeElement).toBe(textarea);
      if (!providerItemId)
        expect(container.textContent).not.toContain(
          "Incremental provider output"
        );
    }
  );

  it("opens an accepted Conversation and queues its first prompt while Codex starts", async () => {
    const executionId = "00000000-0000-4000-8000-000000000099";
    const managed = managedApi({
      start: vi.fn<ManagedConversationDesktopApi["start"]>(async () => ({
        operation: "start",
        status: "starting",
        executionId
      })),
      inspect: vi.fn<ManagedConversationDesktopApi["inspect"]>(async () => ({
        operation: "inspect",
        status: "starting",
        executionId
      })),
      readDraft: vi.fn<ManagedConversationDesktopApi["readDraft"]>(
        () => new Promise(() => undefined)
      )
    });
    const store = new PersonalMemoryStore(
      api({ listProjects: vi.fn(async () => [project([])]) })
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
    await vi.waitFor(() => expect(container.textContent).toContain("New"));
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "New")
        ?.click();
    });

    await vi.waitFor(() =>
      expect(container.querySelector("textarea")?.disabled).toBe(false)
    );
    expect(container.textContent).toContain(
      "Starting the AI Client in this Project"
    );
    expect(managed.resume).not.toHaveBeenCalled();

    const textarea = container.querySelector("textarea")!;
    await act(async () => changeTextarea(textarea, "Begin immediately"));
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Send prompt"]')
        ?.click();
    });
    await vi.waitFor(() => expect(managed.send).toHaveBeenCalledOnce());
    expect(managed.send).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId,
        capturedSessionId: executionId,
        threadId: executionId,
        prompt: "Begin immediately"
      })
    );
  });

  it("keeps launch selections stable after the browser change event completes", async () => {
    const managed = managedApi({
      launchOptions: vi.fn<ManagedConversationDesktopApi["launchOptions"]>(
        async () => ({
          operation: "launch_options",
          options: {
            runners: [
              {
                kind: "local_device",
                deploymentId: "deployment-1",
                deviceId: "device-1",
                displayName: "This device"
              }
            ],
            instances: [
              {
                instanceId: "codex.default",
                driverId: "codex",
                displayName: "Codex",
                ready: true,
                readiness: "ready",
                models: [
                  {
                    id: "gpt-default",
                    displayName: "GPT Default",
                    isDefault: true,
                    supportedReasoningEfforts: ["low", "high"],
                    defaultReasoningEffort: "low"
                  },
                  {
                    id: "gpt-selected",
                    displayName: "GPT Selected",
                    isDefault: false,
                    supportedReasoningEfforts: ["medium", "high"],
                    defaultReasoningEffort: "medium"
                  }
                ],
                capabilities: {
                  defaultPermissionMode: "full_access",
                  permissionModes: [
                    { mode: "supervised", support: "supported" },
                    { mode: "full_access", support: "supported" }
                  ]
                }
              }
            ]
          }
        })
      )
    });
    const store = new PersonalMemoryStore(
      api({ listProjects: vi.fn(async () => [project([])]) })
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
    await vi.waitFor(() => expect(container.textContent).toContain("New"));
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find(
          (button) =>
            button.getAttribute("aria-label") === "Conversation launch settings"
        )
        ?.click();
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Start Conversation")
    );
    const select = (label: string) =>
      [...container.querySelectorAll<HTMLLabelElement>("label")]
        .find((candidate) =>
          candidate.querySelector("span")?.textContent?.includes(label)
        )
        ?.querySelector("select");
    await act(async () => {
      const model = select("Model")!;
      model.value = "gpt-selected";
      model.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      const reasoning = select("Reasoning")!;
      reasoning.value = "high";
      reasoning.dispatchEvent(new Event("change", { bubbles: true }));
      const permissions = select("Permissions")!;
      permissions.value = "supervised";
      permissions.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.includes("Start Conversation"))
        ?.click();
    });

    expect(managed.start).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-selected",
        reasoningEffort: "high",
        permissionMode: "supervised"
      })
    );
    expect(
      store.current().projectsById.get("project-1")?.threads
    ).toContainEqual(
      expect.objectContaining({ id: "managed-thread", sessionId })
    );
    expect(container.childElementCount).toBeGreaterThan(0);
  });

  it("keeps optimistic conversation content visible during its canonical load", async () => {
    let finishLoad!: (events: PersonalDesktopConversationEvent[]) => void;
    const selected = thread(1);
    const store = new PersonalMemoryStore(
      api({
        listProjects: vi.fn(async () => [project([selected])]),
        loadEventPage: vi.fn(
          () =>
            new Promise<PersonalDesktopConversationEvent[]>((resolve) => {
              finishLoad = resolve;
            })
        )
      })
    );

    await act(async () => {
      root.render(
        <PersonalMemoryWorkspace
          managedConversations={managedApi()}
          onNavigate={vi.fn()}
          route={{ kind: "session", projectId: "project-1", sessionId }}
          store={store}
        />
      );
    });
    await vi.waitFor(() =>
      expect(container.querySelector("textarea")).not.toBeNull()
    );
    const textarea = container.querySelector("textarea")!;
    await act(async () => changeTextarea(textarea, "Visible immediately"));
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Send prompt"]')
        ?.click();
    });

    expect(
      container
        .querySelector('[data-testid="conversation"]')
        ?.getAttribute("data-status")
    ).toBe("ready");
    expect(container.textContent).not.toContain("Loading conversation");
    await act(async () => finishLoad([event(1)]));
  });

  it("labels estimated managed Conversation context usage and preserves provider attribution", async () => {
    const managed = managedApi({
      resume: vi.fn<ManagedConversationDesktopApi["resume"]>(
        async (conversation) => ({
          operation: "resume",
          status: "ready",
          conversation: { ...conversation, executionId: "execution-usage" }
        })
      ),
      usage: vi.fn<ManagedConversationDesktopApi["usage"]>(
        async (executionId) => ({
          operation: "usage",
          executionId,
          provider: "codex",
          usage: {
            model: "gpt-5.6",
            modelContextWindow: 258_000,
            usedTokens: 42_000,
            totalProcessedTokens: 125_000,
            inputTokens: 40_000,
            cachedInputTokens: 30_000,
            outputTokens: 2_000,
            reasoningOutputTokens: 500,
            usageAccuracy: "local_estimate",
            observedAt: "2026-08-18T04:00:00.000Z"
          }
        })
      )
    });
    const store = new PersonalMemoryStore(
      api({
        listProjects: vi.fn(async () => [project([thread(1)])]),
        loadEventPage: vi.fn(async () => [event(1)])
      })
    );

    await act(async () => {
      root.render(
        <PersonalMemoryWorkspace
          managedConversations={managed}
          onNavigate={vi.fn()}
          route={{ kind: "session", projectId: "project-1", sessionId }}
          store={store}
        />
      );
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("42k / 258k context")
    );

    expect(container.textContent).toContain("Codex");
    expect(container.textContent).toContain("gpt-5.6");
    expect(container.textContent).toContain("Estimated");
    expect(container.textContent).toContain("125k processed");
    expect(
      container
        .querySelector('[role="progressbar"]')
        ?.getAttribute("aria-valuenow")
    ).toBe("16");
  });

  it("reports unavailable context honestly when the provider has no snapshot", async () => {
    const managed = managedApi({
      resume: vi.fn<ManagedConversationDesktopApi["resume"]>(
        async (conversation) => ({
          operation: "resume",
          status: "ready",
          conversation: { ...conversation, executionId: "execution-usage" }
        })
      )
    });
    const store = new PersonalMemoryStore(
      api({
        listProjects: vi.fn(async () => [project([thread(1)])]),
        loadEventPage: vi.fn(async () => [event(1)])
      })
    );

    await act(async () => {
      root.render(
        <PersonalMemoryWorkspace
          managedConversations={managed}
          onNavigate={vi.fn()}
          route={{ kind: "session", projectId: "project-1", sessionId }}
          store={store}
        />
      );
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Context usage unavailable")
    );
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
  });

  it("presents transient output, durable input, controls, and indeterminate dispatch", async () => {
    const now = "2026-08-18T05:00:00.000Z";
    const respond = vi.fn<ManagedConversationDesktopApi["respond"]>(
      async (input) => ({
        operation: "runtime_respond",
        accepted: true,
        itemId: input.itemId
      })
    );
    const interrupt = vi.fn<ManagedConversationDesktopApi["interrupt"]>(
      async (input) => ({
        operation: "interrupt",
        status: "queued",
        executionId: input.executionId,
        commandId: "interrupt-command"
      })
    );
    const managed = managedApi({
      resume: vi.fn<ManagedConversationDesktopApi["resume"]>(
        async (conversation) => ({
          operation: "resume",
          status: "ready",
          conversation: { ...conversation, executionId: "execution-runtime" }
        })
      ),
      runtime: vi.fn<ManagedConversationDesktopApi["runtime"]>(
        async (executionId) => ({
          operation: "runtime",
          executionId,
          executionGeneration: 2,
          executionStateVersion: 3,
          executionState: "running",
          executionLastErrorCode: null,
          latestCommand: {
            clientUserMessageId: null,
            id: "77777777-7777-4777-8777-777777777777",
            sequence: 2,
            executionGeneration: 2,
            commandKind: "prompt",
            state: "indeterminate",
            lastErrorCode: "ManagedConversationRunnerInterruptedError",
            updatedAt: now
          },
          items: [
            {
              id: "runtime-transient",
              executionGeneration: 2,
              providerTurnId: "turn-1",
              providerItemId: "message-1",
              itemKind: "transient_output",
              presentation: {
                mode: "status",
                renderer: "message",
                policyKey: "transient_output",
                policyRevision: 1,
                reason: "presentation-policy:transient_output"
              },
              state: "pending",
              payload: { text: "Inspecting the repository" },
              revision: 2,
              createdAt: now,
              updatedAt: now,
              answered: false
            },
            {
              id: "runtime-input",
              executionGeneration: 2,
              providerTurnId: "turn-1",
              providerItemId: "call-1",
              itemKind: "user_input",
              presentation: {
                mode: "expanded",
                renderer: "user_input",
                policyKey: "user_input",
                policyRevision: 1,
                reason: "presentation-policy:user_input"
              },
              state: "pending",
              payload: {
                questions: [
                  {
                    id: "target",
                    header: "Target",
                    question: "Which target?",
                    options: [
                      { label: "Core", description: "Inspect core" },
                      { label: "TUI", description: "Inspect TUI" }
                    ]
                  }
                ]
              },
              revision: 1,
              createdAt: now,
              updatedAt: now,
              answered: false
            },
            {
              id: "runtime-permission",
              executionGeneration: 2,
              providerTurnId: "turn-1",
              providerItemId: "call-2",
              itemKind: "permissions_approval",
              presentation: {
                mode: "expanded",
                renderer: "approval",
                policyKey: "permissions_approval",
                policyRevision: 1,
                reason: "presentation-policy:permissions_approval"
              },
              state: "pending",
              payload: {
                cwd: "/workspace/project",
                grantRoot: "/workspace",
                permissions: { network: false, fileSystem: "workspace-write" }
              },
              revision: 1,
              createdAt: now,
              updatedAt: now,
              answered: false
            }
          ]
        })
      ),
      respond,
      interrupt
    });
    const store = new PersonalMemoryStore(
      api({
        listProjects: vi.fn(async () => [project([thread(1)])]),
        loadEventPage: vi.fn(async () => [event(1)])
      })
    );

    await act(async () => {
      root.render(
        <PersonalMemoryWorkspace
          managedConversations={managed}
          onNavigate={vi.fn()}
          route={{ kind: "session", projectId: "project-1", sessionId }}
          store={store}
        />
      );
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Inspecting the repository")
    );
    expect(container.textContent).toContain("The AI Client needs input");
    expect(container.textContent).toContain(
      "Working directory: /workspace/project"
    );
    expect(container.textContent).toContain("Grant root: /workspace");
    expect(container.textContent).toContain('"fileSystem": "workspace-write"');
    expect(container.textContent).toContain(
      "Koed cannot prove whether the last prompt reached the AI Client"
    );

    const interaction = container.querySelector(
      ".personal-managed-interaction form"
    );
    const select = interaction?.querySelector<HTMLSelectElement>("select");
    if (!select || !interaction)
      throw new Error("Runtime input was not rendered");
    select.value = "Core";
    await act(async () => {
      interaction.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      );
    });
    await vi.waitFor(() =>
      expect(respond).toHaveBeenCalledWith({
        executionId: "execution-runtime",
        itemId: "runtime-input",
        itemKind: "user_input",
        executionGeneration: 2,
        answers: { target: ["Core"] }
      })
    );

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Interrupt active turn"]'
        )
        ?.click();
    });
    expect(interrupt).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: "execution-runtime",
        executionGeneration: 2
      })
    );
  });

  it("keeps an ambiguous prompt visible and disables further submission while reconciling", async () => {
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
        clientUserMessageId: input.clientUserMessageId,
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
    await vi.waitFor(() => expect(textarea.disabled).toBe(true));
    expect(container.textContent).not.toContain("Acceptance is indeterminate.");
    expect(container.textContent).toContain("Do not duplicate this");
    expect(textarea.value).toBe("");
    expect(textarea.disabled).toBe(true);
    expect(managed.writeDraft).toHaveBeenCalledWith(
      expect.objectContaining({ value: "Do not duplicate this" })
    );
    expect(managed.deleteDraft).not.toHaveBeenCalled();
    expect(
      container.querySelector(".personal-managed-composer")?.className
    ).toContain("state-reconciling");
  });

  it("restores a definitively rejected prompt instead of presenting it as sent", async () => {
    const managed = managedApi({
      send: vi.fn<ManagedConversationDesktopApi["send"]>(async (input) => ({
        operation: "send",
        status: "rejected",
        conversation: {
          executionId: null,
          projectId: "project-1",
          capturedSessionId: input.capturedSessionId,
          threadId: input.threadId
        },
        idempotencyKey: input.idempotencyKey,
        clientUserMessageId: input.clientUserMessageId,
        message: "The prompt was not sent."
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
          route={{ kind: "session", projectId: "project-1", sessionId }}
          store={store}
        />
      );
    });
    await vi.waitFor(() =>
      expect(container.querySelector("textarea")?.disabled).toBe(false)
    );
    const textarea = container.querySelector("textarea")!;
    await act(async () => changeTextarea(textarea, "Restore this prompt"));
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Send prompt"]')
        ?.click();
    });
    await vi.waitFor(() => expect(textarea.value).toBe("Restore this prompt"));
    expect(
      [...container.querySelectorAll("button")].filter(
        (button) => button.textContent === "Restore this prompt"
      )
    ).toHaveLength(0);
    expect(textarea.disabled).toBe(true);
    expect(
      container.querySelector(".personal-managed-composer")?.className
    ).toContain("state-reconciling");
  });

  it("surfaces provider-aware Git links and keeps Session actions outside the row selection button", async () => {
    const source = project([thread(1)]);
    const metadata: PersonalDesktopProjectMetadata = {
      schemaVersion: 1,
      discoveredAt: "2026-07-23T00:00:00.000Z",
      lastSeenAt: "2026-07-24T00:00:00.000Z",
      localProjectId: `lp_${"1".repeat(32)}`,
      displayName: source.name,
      path: { cwd: source.path!, projectRoot: source.path },
      git: {
        branch: "main",
        isWorktree: false,
        remotes: [{ display: "github.com/koed-labs/koed" }]
      }
    };
    const store = new PersonalMemoryStore(
      api({
        listProjects: vi.fn(async () => [source]),
        listProjectMetadata: vi.fn(async () => [metadata])
      })
    );
    const openExternal = vi.fn(async () => undefined);
    const revealLocalProject = vi.fn(async () => undefined);

    await act(async () => {
      root.render(
        <Harness initialRoute={{ kind: "projects" }}>
          {({ onNavigate, route }) => (
            <PersonalMemoryWorkspace
              onNavigate={onNavigate}
              openExternal={openExternal}
              revealLocalProject={revealLocalProject}
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

    const rowRepo = container.querySelector(
      '[data-project-id="project-1"] .personal-project-repo'
    );
    expect(rowRepo?.classList.contains("personal-project-repo-static")).toBe(
      true
    );
    expect(rowRepo?.getAttribute("role")).toBeNull();
    await act(async () => {
      (rowRepo as HTMLElement)?.click();
    });
    expect(openExternal).not.toHaveBeenCalled();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-project-id="project-1"]')
        ?.click();
    });

    const headerRepo = container.querySelector(
      ".personal-project-detail-heading .personal-project-repo"
    );
    expect(headerRepo?.tagName).toBe("BUTTON");
    await act(async () => {
      (headerRepo as HTMLElement)?.click();
    });
    expect(openExternal).toHaveBeenCalledWith(
      "https://github.com/koed-labs/koed"
    );

    const sessionRow = container.querySelector(".personal-session-row");
    const sessionSelect = sessionRow?.querySelector(
      ".personal-session-row-select"
    );
    expect(sessionRow?.tagName).toBe("DIV");
    expect(sessionSelect?.tagName).toBe("BUTTON");
    expect(sessionSelect?.querySelector(".personal-session-link")).toBeNull();
    const sessionLinks = Array.from(
      sessionRow?.querySelectorAll(".personal-session-link") ?? []
    );
    expect(sessionLinks).toHaveLength(2);
    expect(sessionLinks[0]?.getAttribute("title")).toBeNull();
    expect(sessionLinks[0]?.getAttribute("data-tooltip")).toBe(
      `Reveal ${source.name} in file browser`
    );
    expect(sessionLinks[1]?.getAttribute("title")).toBeNull();
    expect(sessionLinks[1]?.getAttribute("data-tooltip")).toBe(
      "Open koed-labs/koed on GitHub"
    );
    await act(async () => {
      (sessionLinks[0] as HTMLElement).click();
    });
    expect(revealLocalProject).toHaveBeenCalledWith(metadata.localProjectId);
    await act(async () => {
      (sessionLinks[1] as HTMLElement).click();
    });
    expect(openExternal).toHaveBeenCalledWith(
      "https://github.com/koed-labs/koed"
    );

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(".personal-session-row-select")
        ?.click();
    });
    const sessionHeaderRepo = container.querySelector(
      ".personal-session-header-copy .personal-project-repo"
    );
    expect(sessionHeaderRepo?.textContent).toContain("koed-labs/koed");
    expect(sessionHeaderRepo?.textContent).not.toContain("github.com/");
    await act(async () => {
      (sessionHeaderRepo as HTMLElement)?.click();
    });
    expect(openExternal).toHaveBeenLastCalledWith(
      "https://github.com/koed-labs/koed"
    );
  });

  it("uses generic repository semantics for non-GitHub remotes", async () => {
    const source = project([thread(1)]);
    const metadata: PersonalDesktopProjectMetadata = {
      schemaVersion: 1,
      discoveredAt: "2026-07-23T00:00:00.000Z",
      lastSeenAt: "2026-07-24T00:00:00.000Z",
      localProjectId: `lp_${"2".repeat(32)}`,
      displayName: source.name,
      path: { cwd: source.path!, projectRoot: source.path },
      git: {
        branch: "main",
        isWorktree: false,
        remotes: [{ display: "gitlab.example/koed-labs/koed" }]
      }
    };
    const store = new PersonalMemoryStore(
      api({
        listProjects: vi.fn(async () => [source]),
        listProjectMetadata: vi.fn(async () => [metadata])
      })
    );
    const openExternal = vi.fn(async () => undefined);

    await act(async () => {
      root.render(
        <PersonalMemoryWorkspace
          onNavigate={vi.fn()}
          openExternal={openExternal}
          route={{ kind: "project", projectId: source.id }}
          store={store}
        />
      );
    });
    await vi.waitFor(() =>
      expect(
        container.querySelector(
          ".personal-project-detail-heading .personal-project-repo"
        )
      ).not.toBeNull()
    );

    const repository = container.querySelector<HTMLButtonElement>(
      ".personal-project-detail-heading .personal-project-repo"
    );
    expect(repository?.dataset.repositoryProvider).toBe("git");
    expect(repository?.getAttribute("aria-label")).toBe(
      "Open repository gitlab.example/koed-labs/koed"
    );
    expect(repository?.querySelector(".lucide-git-fork")).not.toBeNull();
    expect(repository?.querySelector(".lucide-github")).toBeNull();
    await act(async () => repository?.click());
    expect(openExternal).toHaveBeenCalledWith(
      "https://gitlab.example/koed-labs/koed"
    );
  });

  it("shows catalogue activity for a Project without Captured Sessions", async () => {
    const metadata: PersonalDesktopProjectMetadata = {
      schemaVersion: 1,
      discoveredAt: "2026-07-23T00:00:00.000Z",
      lastSeenAt: threadLatestAt,
      localProjectId: `lp_${"3".repeat(32)}`,
      displayName: "Catalogue only",
      path: { cwd: "/tmp/catalogue-only", projectRoot: null }
    };
    const store = new PersonalMemoryStore(
      api({
        listProjects: vi.fn(async () => []),
        listProjectMetadata: vi.fn(async () => [metadata])
      })
    );

    await act(async () => {
      root.render(
        <PersonalMemoryWorkspace
          onNavigate={vi.fn()}
          route={{ kind: "projects" }}
          store={store}
        />
      );
    });
    await vi.waitFor(() =>
      expect(
        container.querySelector(
          `[data-project-id="${metadata.localProjectId}"]`
        )
      ).not.toBeNull()
    );

    const projectRow = container.querySelector(
      `[data-project-id="${metadata.localProjectId}"]`
    );
    const activity = projectRow?.querySelector("time");
    expect(activity?.dateTime).toBe(metadata.lastSeenAt);
    expect(activity?.textContent).not.toBe("No activity");
  });
});
