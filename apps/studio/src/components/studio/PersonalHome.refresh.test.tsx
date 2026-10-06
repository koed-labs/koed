// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HomeFeedController } from "@/lib/use-home-feed";
import { PersonalHome } from "./PersonalHome";
const agentMocks = vi.hoisted(() => ({ multiple: false }));
vi.mock("@/lib/personal-agents-client", () => ({
  personalAgentsHttpAdapter: {
    list: async () => [
      {
        id: "home-agent",
        name: "Home Agent",
        lifecycle: "active",
        currentVersion: 1,
        defaultProvider: "codex",
        defaultModel: "test-model",
        defaultReasoningEffort: "medium"
      },
      ...(agentMocks.multiple
        ? [
            {
              id: "second-agent",
              name: "Second Agent",
              lifecycle: "active",
              currentVersion: 2
            }
          ]
        : [])
    ]
  }
}));
vi.mock("./StudioSidebar", () => ({
  StudioSidebar: ({
    managedConversations,
    onProjectSelect
  }: {
    managedConversations: Array<{ title: string }>;
    onProjectSelect: (id: string) => void;
  }) => (
    <aside>
      <button onClick={() => onProjectSelect("selected-project")}>
        Filter Home Project
      </button>
      {managedConversations.map((item) => (
        <span key={item.title}>{item.title}</span>
      ))}
    </aside>
  )
}));
vi.mock("./OwnedConversationShareDialog", () => ({
  OwnedConversationShareDialog: () => null
}));
vi.mock("./useVerifiedPersonalScope", () => ({
  useVerifiedPersonalScope: () => null
}));
vi.mock("./usePersonalRemovals", () => ({
  usePersonalRemovals: () => ({ removals: [], ready: true, loading: false })
}));
vi.mock("@/lib/studio-collaboration-client", () => ({
  StudioCollaborationClient: class {
    async loadSession() {
      throw new Error("unavailable");
    }
  }
}));
vi.mock("../SharedChatUI", () => ({
  SharedChatUI: ({ composer }: { composer: ReactNode }) => composer
}));
vi.mock("../ChatComposer", () => ({
  ChatComposer: ({
    value,
    onChange,
    projectSelector,
    onSend,
    sendEnabled,
    activeAgentId,
    onActiveAgentChange
  }: {
    value: string;
    sendEnabled: boolean;
    activeAgentId: string | null;
    onActiveAgentChange: (id: string | null) => void;
    onChange: (value: string) => void;
    projectSelector?: ReactNode;
    onSend: (
      value: string,
      selection: {
        agentId: string | null;
        provider: string;
        model: string;
        effort: string;
        permissionMode: "full";
        instanceId: string;
      }
    ) => void;
  }) => (
    <div>
      {projectSelector}
      <button onClick={() => onActiveAgentChange("home-agent")}>
        Mention Home Agent
      </button>
      <textarea value={value} onChange={(e) => onChange(e.target.value)} />
      <button
        disabled={!sendEnabled || !value.trim()}
        onClick={() =>
          onSend(value, {
            agentId: activeAgentId,
            provider: "codex",
            model: "test-model",
            effort: "high",
            permissionMode: "full",
            instanceId: "chosen-client"
          })
        }
      >
        Send draft
      </button>
    </div>
  )
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let fail: boolean;
let feedRefresh: ReturnType<typeof vi.fn>;
const metadata = {
  state: "ready",
  fetchedAt: "2026-10-04T10:00:00Z",
  scopeKey: "http://127.0.0.1:43300|owner",
  message: null,
  warnings: [],
  coverage: { executions: true, requests: false, recents: true },
  executions: [],
  requests: [],
  recents: []
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  fail = false;
  agentMocks.multiple = false;
  feedRefresh = vi.fn().mockResolvedValue(true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input) => {
      if (fail) return new Response("offline", { status: 503 });
      if (String(input).includes("launch-options"))
        return Response.json({
          instances: [
            {
              ready: true,
              instanceId: "local",
              driverId: "codex",
              models: [{ id: "test-model" }]
            }
          ]
        });
      return Response.json(metadata);
    })
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function mount(onStartChat = vi.fn()) {
  const homeFeed = {
    snapshot: null,
    state: "ready",
    refreshing: false,
    mutationError: null,
    pendingItemIds: new Set(),
    loadingSources: new Set(),
    canMutate: true,
    refresh: feedRefresh,
    loadMore: vi.fn(),
    setCleared: vi.fn()
  } as HomeFeedController;
  await act(async () =>
    root.render(
      <PersonalHome
        canCreateLocalProject={false}
        onStartChat={onStartChat}
        registeredProjects={[
          { id: "selected-project", name: "Project folder" }
        ]}
        onResumeChat={vi.fn()}
        homeFeed={homeFeed}
        onOpenHomeItem={vi.fn()}
      />
    )
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}
const refreshButton = () =>
  [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Refresh"
  );
it("hides Refresh when healthy, exposes it on automatic failure, and recovers manually without losing the draft", async () => {
  await mount();
  expect(refreshButton()).toBeUndefined();
  const textarea = container.querySelector("textarea")!;
  await act(async () => {
    const prompt = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "What should I work on next?"
    )!;
    prompt.click();
  });
  expect(textarea.value).toBe("What should I work on next?");
  fail = true;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(refreshButton()).toBeDefined();
  expect(container.querySelector("textarea")).toBe(textarea);
  expect(textarea.value).toBe("What should I work on next?");
  fail = false;
  await act(async () => refreshButton()!.click());
  expect(refreshButton()).toBeUndefined();
  expect(textarea.value).toBe("What should I work on next?");
});
it("also exposes Refresh when only the activity refresh fails", async () => {
  await mount();
  feedRefresh.mockResolvedValue(false);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(refreshButton()).toBeDefined();
});

it("keeps the draft and chosen model while changing folders, and explicitly sends No folder", async () => {
  const start = vi.fn();
  await mount(start);
  const button = (text: string) =>
    [...container.querySelectorAll("button")].find(
      (item) => item.textContent?.trim() === text
    )!;
  await act(async () => button("What should I work on next?").click());
  await act(async () => button("Personal").click());
  await act(async () => button("Project folder").click());
  expect(container.querySelector("textarea")?.value).toBe(
    "What should I work on next?"
  );
  expect(start).not.toHaveBeenCalled();
  await act(async () => button("Project folder").click());
  await act(async () => button("No folder").click());
  await act(async () => button("Send draft").click());
  expect(start).toHaveBeenCalledWith(
    "What should I work on next?",
    null,
    expect.objectContaining({ provider: "codex", model: "test-model" })
  );
});

it.each([false, true])(
  "opens New Chat without an Agent choice, whether one or multiple Agents exist (multiple=%s)",
  async (multiple) => {
    agentMocks.multiple = multiple;
    const start = vi.fn();
    await mount(start);
    const button = (text: string) =>
      [...container.querySelectorAll("button")].find(
        (item) => item.textContent?.trim() === text
      )!;
    expect(
      container.querySelector<HTMLSelectElement>(
        'select[aria-label="Personal Agent"]'
      )
    ).toBeNull();
    await act(async () => button("What should I work on next?").click());
    expect(button("Send draft").disabled).toBe(false);
    await act(async () => button("Send draft").click());
    expect(container.querySelector("dialog")).toBeNull();
    expect(start).toHaveBeenCalledExactlyOnceWith(
      "What should I work on next?",
      null,
      {
        agentId: null,
        provider: "codex",
        model: "test-model",
        effort: "high",
        permissionMode: "full",
        instanceId: "chosen-client"
      }
    );
  }
);

it("still lets the user explicitly select an optional Agent", async () => {
  const start = vi.fn();
  await mount(start);
  const button = (text: string) =>
    [...container.querySelectorAll("button")].find(
      (item) => item.textContent?.trim() === text
    )!;
  await act(async () => button("Mention Home Agent").click());
  await act(async () => button("What should I work on next?").click());
  await act(async () => button("Send draft").click());
  expect(start).toHaveBeenCalledWith(
    "What should I work on next?",
    null,
    expect.objectContaining({ agentId: "home-agent" })
  );
});

it("keeps other Projects' conversations in the sidebar when Home is filtered", async () => {
  const executions = ["selected-project", "other-project"].map(
    (projectId, index) => ({
      id: `execution-${index}`,
      sessionId: null,
      projectId,
      title: `Conversation ${index}`,
      provider: "codex",
      state: "ready",
      updatedAt: "2026-10-04T10:00:00Z",
      error: null
    })
  );
  const originalFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) =>
      String(input).includes("/studio-api/home")
        ? Response.json({ ...metadata, executions })
        : originalFetch(input, init)
    )
  );
  await mount();
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Filter Home Project")!
      .click()
  );
  expect(container.querySelector("aside")?.textContent).toContain(
    "Conversation 0"
  );
  expect(container.querySelector("aside")?.textContent).toContain(
    "Conversation 1"
  );
});
