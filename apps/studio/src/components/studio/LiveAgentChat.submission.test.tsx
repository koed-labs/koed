// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { LiveAgentChat } from "./LiveAgentChat";
import type { DeviceManagedChatRecoveryRecord } from "@/lib/device-managed-chat-recovery";
import type { ChatComposerSelection } from "../ChatComposer";
import type { NewChatRuntime } from "./NewChatView";
type TestRecipient = {
  agentId: string;
  provider: string;
  targetDeviceId: string;
  [key: string]: unknown;
};
type TestSubmitRequest = {
  requestId: string;
  text: string;
  recipients: TestRecipient[];
  [key: string]: unknown;
};
type TestTimelineMessage = {
  kind?: string;
  requestId?: string;
  turnId?: string;
  text?: string;
  [key: string]: unknown;
};
type TestConversationRoot = {
  conversation: {
    conversationId: string;
    messages: TestTimelineMessage[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
};
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  view: vi.fn(),
  records: new Map<string, DeviceManagedChatRecoveryRecord>(),
  fail: false,
  prompted: false,
  started: vi.fn(),
  personalSubmit: vi.fn(),
  personalRead: vi.fn(),
  personalRequest: null as TestSubmitRequest | null,
  personalRoot: null as TestConversationRoot | null,
  agents: [] as Array<Record<string, unknown>>,
  onReviewSaved: null as
    | ((review: { version: number; privateGoal: string }) => void)
    | null,
  onRequestStatusChange: null as
    | ((request: { status: string; version: number } | null) => void)
    | null,
  runtime: null as Record<string, unknown> | null,
  startFreshTeamPlanning: vi.fn(),
  startGate: null as Promise<unknown> | null,
  launchOptionsGate: null as Promise<unknown> | null,
  rejectAbortedRequests: false
}));
const router = { replace: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/personal-agents-client", async (original) => ({
  ...(await original<object>()),
  personalAgentsHttpAdapter: {
    list: async () =>
      mocks.agents.length
        ? mocks.agents
        : [
            {
              id: "agent-a",
              name: "Agent A",
              currentVersion: 2,
              lifecycle: "active"
            }
          ]
  }
}));
vi.mock("@/lib/personal-conversations-client", async (original) => ({
  ...(await original<object>()),
  readPersonalConversation: mocks.personalRead,
  submitPersonalConversationMessage: mocks.personalSubmit,
  cancelPersonalConversationMessage: vi.fn(),
  continuePersonalConversationMessage: vi.fn(),
  renamePersonalConversation: vi.fn()
}));
vi.mock("@/lib/managed-agent-chat", async (original) => ({
  ...(await original<object>()),
  managedRequest: mocks.request
}));
vi.mock("@/lib/device-managed-chat-recovery", async (original) => ({
  ...(await original<object>()),
  createLocalManagedChatRecoveryStore: ({
    executionId
  }: {
    executionId?: string | null;
  }) => {
    const key = executionId ?? "new";
    return {
      read: () => mocks.records.get(key) ?? null,
      write: (record: DeviceManagedChatRecoveryRecord) =>
        mocks.records.set(key, record),
      clear: () => mocks.records.delete(key),
      flush: async () => {}
    };
  }
}));
vi.mock("@/lib/hosted-managed-chats", async (original) => ({
  ...(await original<object>()),
  loadLatestLocalProjectMove: async () => null,
  loadLocalRetainedWorkspaces: async () => []
}));
vi.mock("@/components/TeamAgentRequestViews", () => ({
  TeamAgentRequestReviewPanel: (props: {
    onReviewSaved: (review: { version: number; privateGoal: string }) => void;
    onRequestStatusChange: (
      request: { status: string; version: number } | null
    ) => void;
  }) => {
    mocks.onReviewSaved = props.onReviewSaved;
    mocks.onRequestStatusChange = props.onRequestStatusChange;
    return null;
  }
}));
vi.mock("./NewChatView", () => ({
  NewChatView: (props: {
    runtime: NewChatRuntime;
    recoveredDraft: string | null;
    onActiveAgentChange?: (agentId: string | null) => void;
  }) => {
    mocks.view(props);
    return (
      <div>
        {props.runtime.messages.map((message) => (
          <p key={message.id}>{message.content}</p>
        ))}
        <textarea value={props.recoveredDraft ?? ""} readOnly />
      </div>
    );
  }
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const id = "12345678-1234-4234-8234-123456789012";
const selection: ChatComposerSelection = {
  agentId: "agent-a",
  provider: "codex",
  model: "chosen-model",
  effort: "high",
  permissionMode: "full",
  instanceId: "chosen-client"
};
const execution = {
  id,
  projectId: null,
  runnerDeviceId: "device-1",
  provider: "codex",
  aiClientInstanceId: "chosen-client",
  executionGeneration: 1,
  stateVersion: 1,
  state: "running",
  lastErrorCode: null,
  model: "chosen-model",
  reasoningEffort: "high",
  permissionMode: "full_access"
};
const stoppedTeamRuntime = (
  commandState = "failed",
  sequence = 1,
  hasIndeterminatePrompt = false
) => ({
  execution: { ...execution, state: "stopped" },
  items: [],
  hasIndeterminatePrompt,
  latestCommand: {
    id: "command-failed",
    sequence,
    executionGeneration: 1,
    commandKind: "prompt",
    clientUserMessageId: "42345678-1234-4234-8234-123456789012",
    state: commandState,
    lastErrorCode: "OWNER_REVIEW_BINDING_UNAVAILABLE"
  }
});
const agentA = "agent-a";
const agentB = "agent-b";
const secondExecutionId = "22345678-1234-4234-8234-123456789012";
const replyRequestId = "32345678-1234-4234-8234-123456789012";
const launchA = {
  kind: "agent",
  agentId: agentA,
  agentVersion: 2,
  provider: "codex",
  aiClientInstanceId: "chosen-client",
  targetDeviceId: "device-1",
  model: "chosen-model",
  reasoningEffort: "high",
  permissionMode: "full_access",
  selectedResourceIds: []
};
const launchB = {
  kind: "agent",
  agentId: agentB,
  agentVersion: 3,
  provider: "claude",
  aiClientInstanceId: "claude-client",
  targetDeviceId: "device-1",
  model: "other-model",
  reasoningEffort: "medium",
  permissionMode: "supervised",
  selectedResourceIds: []
};
function makePersonalConversation(
  conversationId: string,
  requestId: string
): TestConversationRoot {
  const userMessage = {
    id: "42345678-1234-4234-8234-123456789012",
    sequence: 1,
    turnId: "52345678-1234-4234-8234-123456789012",
    requestId,
    kind: "user",
    text: "Home question",
    authorAgentId: null,
    authorAgentVersion: null,
    authorName: null,
    provider: null,
    aiClientInstanceId: null,
    executionId: null,
    sourceExecutionId: null,
    sourceCommandId: null,
    jobId: null,
    truncated: false,
    state: "completed",
    createdAt: "2026-10-07T12:00:00.000Z"
  };
  const replies = [
    {
      ...userMessage,
      id: "62345678-1234-4234-8234-123456789012",
      sequence: 2,
      kind: "agent_reply",
      text: "Reply from Agent A",
      authorAgentId: agentA,
      authorAgentVersion: 2,
      authorName: "Agent A",
      provider: "codex",
      aiClientInstanceId: "chosen-client",
      executionId: secondExecutionId,
      sourceExecutionId: null,
      sourceCommandId: "command-a"
    },
    {
      ...userMessage,
      id: "72345678-1234-4234-8234-123456789012",
      sequence: 3,
      kind: "agent_reply",
      text: "Reply from Agent B",
      authorAgentId: agentB,
      authorAgentVersion: 3,
      authorName: "Agent B",
      provider: "claude",
      aiClientInstanceId: "claude-client",
      executionId: id,
      sourceExecutionId: null,
      sourceCommandId: "command-b"
    }
  ];
  const deliveries = [
    {
      id: "82345678-1234-4234-8234-123456789012",
      turnId: userMessage.turnId,
      messageId: userMessage.id,
      recipientKind: "agent",
      agentId: agentA,
      agentVersion: 2,
      agentName: "Agent A",
      ordinal: 0,
      executionId: secondExecutionId,
      commandId: "command-a",
      jobId: null,
      provider: "codex",
      aiClientInstanceId: "chosen-client",
      model: "chosen-model",
      status: "completed",
      errorCode: null,
      canContinue: false,
      progress: {
        stage: "completed",
        summary: "Done",
        observedAt: "2026-10-07T12:00:02.000Z"
      },
      contextTransfer: null,
      diffAvailable: true,
      startedAt: "2026-10-07T12:00:01.000Z",
      completedAt: "2026-10-07T12:00:02.000Z",
      updatedAt: "2026-10-07T12:00:02.000Z"
    },
    {
      id: "92345678-1234-4234-8234-123456789012",
      turnId: userMessage.turnId,
      messageId: userMessage.id,
      recipientKind: "agent",
      agentId: agentB,
      agentVersion: 3,
      agentName: "Agent B",
      ordinal: 1,
      executionId: id,
      commandId: "command-b",
      jobId: null,
      provider: "claude",
      aiClientInstanceId: "claude-client",
      model: "other-model",
      status: "completed",
      errorCode: null,
      canContinue: false,
      progress: {
        stage: "completed",
        summary: "Done",
        observedAt: "2026-10-07T12:00:04.000Z"
      },
      contextTransfer: null,
      diffAvailable: true,
      startedAt: "2026-10-07T12:00:03.000Z",
      completedAt: "2026-10-07T12:00:04.000Z",
      updatedAt: "2026-10-07T12:00:04.000Z"
    }
  ];
  const conversation = {
    contractVersion: 1,
    conversationId,
    title: "Home question",
    projectId: null,
    contextKind: "independent",
    status: "idle",
    activeAgentId: agentB,
    activeExecutionId: id,
    activeProvider: "claude",
    sourceExecutionIds: [],
    childExecutionIds: [secondExecutionId, id],
    capturedSessionIds: [],
    participants: [
      {
        agentId: agentA,
        agentVersion: 2,
        name: "Agent A",
        avatarReference: null,
        ordinal: 0,
        launch: launchA,
        executionId: secondExecutionId,
        lastContextCursor: 0,
        status: "completed",
        updatedAt: "2026-10-07T12:00:02.000Z"
      },
      {
        agentId: agentB,
        agentVersion: 3,
        name: "Agent B",
        avatarReference: null,
        ordinal: 1,
        launch: launchB,
        executionId: id,
        lastContextCursor: 0,
        status: "completed",
        updatedAt: "2026-10-07T12:00:04.000Z"
      }
    ],
    messages: [userMessage, ...replies],
    deliveries,
    createdAt: "2026-10-07T12:00:00.000Z",
    updatedAt: "2026-10-07T12:00:04.000Z"
  };
  return {
    conversation,
    message: userMessage,
    deliveries
  } as TestConversationRoot;
}
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  mocks.request.mockReset();
  mocks.view.mockClear();
  mocks.started.mockClear();
  mocks.records.clear();
  mocks.fail = false;
  mocks.prompted = false;
  mocks.personalSubmit.mockReset();
  mocks.personalRead.mockReset();
  mocks.personalRequest = null;
  mocks.personalRoot = null;
  mocks.agents = [];
  mocks.onReviewSaved = null;
  mocks.onRequestStatusChange = null;
  mocks.runtime = null;
  mocks.startFreshTeamPlanning.mockReset();
  mocks.startGate = null;
  mocks.launchOptionsGate = null;
  mocks.rejectAbortedRequests = false;
  router.replace.mockClear();
  window.history.replaceState({}, "", "/");
});
async function mount(
  turnSelection = selection,
  options: {
    personalConversationId?: string;
    submit?: boolean;
    skipInitialSelection?: boolean;
    initialDraft?: string;
    teamRequest?: boolean;
    teamReviewVersion?: number;
    executionId?: boolean;
    latestCommandState?: string;
    latestCommandSequence?: number;
    requestStatus?: string;
    requestVersion?: number;
  } = {}
) {
  mocks.records.set("new", { schemaVersion: 1, draft: "" });
  mocks.request.mockImplementation(
    async (
      path: string,
      body?: Record<string, unknown>,
      signal?: AbortSignal
    ) => {
      if (mocks.rejectAbortedRequests && signal?.aborted)
        throw new DOMException("The request was aborted.", "AbortError");
      if (path === "/access") return { user: { id: "owner" } };
      if (path === "/launch-options") {
        if (mocks.launchOptionsGate) return mocks.launchOptionsGate;
        return {
          runners: [
            {
              kind: "local_device",
              deviceId: "device-1",
              deploymentId: "deployment-1",
              displayName: "This device"
            }
          ],
          instances: [
            {
              ready: true,
              instanceId: "chosen-client",
              driverId: "codex",
              models: [
                { id: "chosen-model", supportedReasoningEfforts: ["high"] }
              ],
              capabilities: {
                permissionModes: [{ mode: "full_access", support: "supported" }]
              }
            },
            {
              ready: true,
              instanceId: "claude-client",
              driverId: "claude",
              models: [
                { id: "other-model", supportedReasoningEfforts: ["medium"] }
              ],
              capabilities: {
                permissionModes: [{ mode: "supervised", support: "supported" }]
              }
            }
          ]
        };
      }
      if (path === "") {
        if (mocks.fail) throw new Error("Start failed");
        if (mocks.startGate) return mocks.startGate;
        return { execution };
      }
      if (path.endsWith("/runtime"))
        return mocks.runtime ?? { execution, items: [], latestCommand: null };
      if (path.endsWith("/prompts")) {
        mocks.prompted = true;
        return { command: { id: "command", state: "completed" }, body };
      }
      if (path.endsWith("/agent-state"))
        return {
          executionGeneration: 1,
          activeAgentId: turnSelection.agentId,
          jobs: [],
          messages: mocks.prompted
            ? [
                {
                  id: "user",
                  role: "user",
                  content: "Home question",
                  createdAt: 1
                },
                {
                  id: "assistant",
                  role: "assistant",
                  content: "Agent response",
                  createdAt: 2
                }
              ]
            : []
        };
      if (path.endsWith("/diff")) return { events: [] };
      return {};
    }
  );
  if (options.personalConversationId) {
    const existing =
      mocks.personalRoot ??
      makePersonalConversation(options.personalConversationId, replyRequestId);
    mocks.records.set(options.personalConversationId, {
      schemaVersion: 1,
      personalConversationId: options.personalConversationId,
      draft: ""
    });
    mocks.personalRead.mockResolvedValue({
      conversation: existing.conversation,
      timelinePage: { hasMore: false, nextCursor: null }
    });
  }
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <StrictMode>
        <LiveAgentChat
          onConversationStarted={mocks.started}
          onStartFreshTeamPlanning={mocks.startFreshTeamPlanning}
          initialDraft={options.initialDraft ?? "Home question"}
          {...(options.skipInitialSelection
            ? {}
            : { initialSelection: turnSelection })}
          {...(options.personalConversationId
            ? { personalConversationId: options.personalConversationId }
            : {})}
          {...(options.teamRequest
            ? {
                teamRequestId: "agent-request",
                teamRequestTeamId: "team",
                teamRequestExpectedRequestVersion: 4,
                teamRequestExpectedReviewVersion: options.teamReviewVersion ?? 1
              }
            : {})}
          {...(options.executionId
            ? {
                executionId: id,
                teamRequestId: "agent-request",
                teamRequestTeamId: "team",
                teamRequestExpectedRequestVersion: 4,
                teamRequestExpectedReviewVersion: options.teamReviewVersion ?? 1
              }
            : {})}
          {...(options.submit === false
            ? {}
            : {
                initialSubmission: {
                  id: "home-send",
                  text: "Home question",
                  selection: turnSelection
                }
              })}
        />
      </StrictMode>
    )
  );
}
async function flushReact() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
}
it("explains that the private brief must be saved before a Team planning chat can start", async () => {
  await mount(selection, { submit: false, teamRequest: true });
  await flushReact();

  const runtime = mocks.view.mock.lastCall?.[0].runtime as NewChatRuntime;
  expect(runtime.enabled).toBe(false);
  expect(runtime.status).toBe(
    "Save the private brief above before starting the private planning chat."
  );
  expect(
    mocks.request.mock.calls.filter((call) => call[0] === "")
  ).toHaveLength(0);
  expect(
    mocks.request.mock.calls.filter((call) =>
      String(call[0]).endsWith("/prompts")
    )
  ).toHaveLength(0);
});
it("offers a fresh blank Team planning chat for a stopped owner review without replaying a prompt", async () => {
  const stoppedRuntime = stoppedTeamRuntime();
  mocks.runtime = {
    ...stoppedRuntime,
    latestCommand: {
      ...stoppedRuntime.latestCommand,
      commandKind: "stop",
      sequence: 2,
      state: "completed"
    }
  };
  await mount(selection, {
    submit: false,
    executionId: true,
    teamReviewVersion: 1
  });
  await flushReact();
  await act(async () => {
    mocks.onRequestStatusChange?.({ status: "awaiting_owner", version: 4 });
  });
  await flushReact();

  expect(container.textContent).toContain(
    "The earlier private planning prompt’s outcome is unconfirmed."
  );
  expect(container.textContent).toContain(
    "A fresh chat starts blank and will not resend it."
  );
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) =>
      candidate.textContent === "Start a fresh private planning chat"
  );
  expect(button).toBeDefined();
  await act(async () => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

  expect(mocks.startFreshTeamPlanning).toHaveBeenCalledTimes(1);
  expect(mocks.startFreshTeamPlanning).toHaveBeenCalledWith({
    selection: {
      agentId: "agent-a",
      expectedAgentVersion: 2,
      provider: "codex",
      model: "chosen-model",
      effort: "high",
      permissionMode: "full",
      instanceId: "chosen-client"
    },
    projectId: null,
    requestVersion: 4,
    reviewVersion: 1
  });
  expect(
    mocks.request.mock.calls.filter((call) => call[0] === "")
  ).toHaveLength(0);
  expect(
    mocks.request.mock.calls.filter((call) =>
      String(call[0]).endsWith("/prompts")
    )
  ).toHaveLength(0);
});
it("does not offer fresh planning when the active Agent differs from the request Agent", async () => {
  mocks.agents = [
    {
      id: "agent-a",
      name: "Agent A",
      currentVersion: 2,
      lifecycle: "active"
    },
    {
      id: "agent-b",
      name: "Agent B",
      currentVersion: 3,
      lifecycle: "active"
    }
  ];
  mocks.runtime = stoppedTeamRuntime();
  await mount(selection, {
    submit: false,
    executionId: true,
    teamReviewVersion: 1
  });
  await flushReact();
  await act(async () => {
    mocks.onRequestStatusChange?.({ status: "awaiting_owner", version: 4 });
  });
  await act(async () => {
    mocks.view.mock.lastCall?.[0].onActiveAgentChange?.("agent-b");
  });
  await flushReact();

  expect(container.textContent).not.toContain(
    "Start a fresh private planning chat"
  );
  expect(mocks.startFreshTeamPlanning).not.toHaveBeenCalled();
});
it.each([
  {
    name: "accepted Team requests",
    commandState: "failed",
    sequence: 1,
    hasIndeterminatePrompt: false,
    requestStatus: "accepted",
    requestVersion: 4,
    reviewVersion: 1
  },
  {
    name: "indeterminate prompt outcomes",
    commandState: "indeterminate",
    sequence: 1,
    hasIndeterminatePrompt: true,
    requestStatus: "awaiting_owner",
    requestVersion: 4,
    reviewVersion: 1
  },
  {
    name: "stale request versions",
    commandState: "failed",
    sequence: 1,
    hasIndeterminatePrompt: false,
    requestStatus: "awaiting_owner",
    requestVersion: 5,
    reviewVersion: 1
  },
  {
    name: "stale review versions",
    commandState: "failed",
    sequence: 1,
    hasIndeterminatePrompt: false,
    requestStatus: "awaiting_owner",
    requestVersion: 4,
    reviewVersion: 2
  }
])("does not offer fresh planning for $name", async (scenario) => {
  mocks.runtime = stoppedTeamRuntime(
    scenario.commandState,
    scenario.sequence,
    scenario.hasIndeterminatePrompt
  );
  await mount(selection, {
    submit: false,
    executionId: true,
    teamReviewVersion: 1
  });
  await flushReact();
  if (scenario.reviewVersion !== 1)
    await act(async () => {
      mocks.onReviewSaved?.({
        version: scenario.reviewVersion,
        privateGoal: "Saved private brief"
      });
    });
  await act(async () => {
    mocks.onRequestStatusChange?.({
      status: scenario.requestStatus,
      version: scenario.requestVersion
    });
  });
  await flushReact();

  expect(container.textContent).not.toContain(
    "Start a fresh private planning chat"
  );
  expect(mocks.startFreshTeamPlanning).not.toHaveBeenCalled();
});
it("keeps an in-flight Team first send alive when the saved review version advances", async () => {
  let resolveStart!: (value: unknown) => void;
  mocks.startGate = new Promise((resolve) => {
    resolveStart = resolve;
  });
  mocks.rejectAbortedRequests = true;
  window.history.replaceState(
    {},
    "",
    "/?chat=1&teamRequest=agent-request&teamRequestTeam=team&teamRequestVersion=4&teamReviewVersion=1"
  );

  await mount(selection, {
    submit: false,
    teamRequest: true,
    teamReviewVersion: 1
  });
  await flushReact();

  expect(mocks.onReviewSaved).not.toBeNull();
  await act(async () => {
    mocks.onReviewSaved?.({ version: 2, privateGoal: "Saved private brief" });
  });
  window.history.replaceState(
    {},
    "",
    "/?chat=1&teamRequest=agent-request&teamRequestTeam=team&teamRequestVersion=4&teamReviewVersion=2"
  );
  await act(async () =>
    root.render(
      <StrictMode>
        <LiveAgentChat
          onConversationStarted={mocks.started}
          onStartFreshTeamPlanning={mocks.startFreshTeamPlanning}
          initialDraft="Home question"
          initialSelection={selection}
          teamRequestId="agent-request"
          teamRequestTeamId="team"
          teamRequestExpectedRequestVersion={4}
          teamRequestExpectedReviewVersion={2}
        />
      </StrictMode>
    )
  );
  await flushReact();
  await act(async () => {
    mocks.onRequestStatusChange?.({ status: "awaiting_owner", version: 4 });
  });
  const runtime = mocks.view.mock.lastCall?.[0].runtime as NewChatRuntime;
  expect(runtime.enabled).toBe(true);

  let sendOutcome!: Promise<{ accepted: true } | { error: unknown }>;
  await act(async () => {
    sendOutcome = runtime
      .onSend("Home question", selection)
      .then(() => ({ accepted: true as const }))
      .catch((error: unknown) => ({ error }));
    await vi.waitFor(() => {
      expect(
        mocks.request.mock.calls.filter((call) => call[0] === "")
      ).toHaveLength(1);
    });
  });

  const startBody = mocks.request.mock.calls.find(
    (call) => call[0] === ""
  )?.[1];
  expect(startBody).toMatchObject({
    model: "chosen-model",
    reasoningEffort: "high",
    aiClientInstanceId: "chosen-client",
    teamAgentRequest: {
      requestId: "agent-request",
      expectedRequestVersion: 4,
      expectedReviewVersion: 2
    }
  });
  const initialLaunchLoads = mocks.request.mock.calls.filter(
    (call) => call[0] === "/launch-options"
  ).length;

  window.history.replaceState(
    {},
    "",
    "/?chat=1&teamRequest=agent-request&teamRequestTeam=team&teamRequestVersion=4&teamReviewVersion=2"
  );
  await act(async () =>
    root.render(
      <StrictMode>
        <LiveAgentChat
          onConversationStarted={mocks.started}
          initialDraft="Home question"
          initialSelection={selection}
          teamRequestId="agent-request"
          teamRequestTeamId="team"
          teamRequestExpectedRequestVersion={4}
          teamRequestExpectedReviewVersion={2}
        />
      </StrictMode>
    )
  );
  await flushReact();

  expect(
    mocks.request.mock.calls.filter((call) => call[0] === "/launch-options")
  ).toHaveLength(initialLaunchLoads);
  expect(container.querySelector("textarea")?.value).toBe("Home question");
  expect(mocks.view.mock.lastCall?.[0].initialSelection).toMatchObject({
    model: "chosen-model",
    effort: "high",
    instanceId: "chosen-client"
  });
  expect(mocks.records.get("new")?.pendingOperation?.prompt).toBe(
    "Home question"
  );
  expect(
    mocks.request.mock.calls.filter((call) =>
      String(call[0]).endsWith("/prompts")
    )
  ).toHaveLength(0);

  await act(async () => {
    resolveStart({ execution });
    await sendOutcome;
  });

  expect(await sendOutcome).toEqual({ accepted: true });
  const prompts = mocks.request.mock.calls.filter((call) =>
    String(call[0]).endsWith("/prompts")
  );
  expect(prompts).toHaveLength(1);
  expect(prompts[0]?.[1]).toMatchObject({ prompt: "Home question" });
});
it("keeps a review version saved during launch loading through start and URL handoff", async () => {
  window.history.replaceState(
    {},
    "",
    "/?chat=1&teamRequest=agent-request&teamRequestTeam=team&teamRequestVersion=4&teamReviewVersion=1"
  );
  await mount(selection, {
    submit: false,
    teamRequest: true,
    teamReviewVersion: 1
  });
  await flushReact();

  await act(async () => {
    mocks.onReviewSaved?.({ version: 1, privateGoal: "Saved private brief" });
    mocks.onRequestStatusChange?.({ status: "awaiting_owner", version: 4 });
  });
  router.replace.mockClear();
  const initialRuntime = mocks.view.mock.lastCall?.[0]
    .runtime as NewChatRuntime;
  expect(initialRuntime.enabled).toBe(true);

  let resolveLaunchOptions!: (value: unknown) => void;
  mocks.launchOptionsGate = new Promise((resolve) => {
    resolveLaunchOptions = resolve;
  });
  const launchOptionsCallsBeforeSend = mocks.request.mock.calls.filter(
    (call) => call[0] === "/launch-options"
  ).length;
  let sendOutcome!: Promise<{ accepted: true } | { error: unknown }>;
  await act(async () => {
    sendOutcome = initialRuntime
      .onSend("Home question", selection)
      .then(() => ({ accepted: true as const }))
      .catch((error: unknown) => ({ error }));
    await vi.waitFor(() => {
      expect(
        mocks.request.mock.calls.filter((call) => call[0] === "/launch-options")
      ).toHaveLength(launchOptionsCallsBeforeSend + 1);
    });
  });

  await act(async () => {
    mocks.onReviewSaved?.({ version: 2, privateGoal: "Updated private brief" });
    mocks.onReviewSaved?.({ version: 1, privateGoal: "Older private brief" });
    window.history.replaceState(
      {},
      "",
      "/?chat=1&teamRequest=agent-request&teamRequestTeam=team&teamRequestVersion=4&teamReviewVersion=2"
    );
    root.render(
      <StrictMode>
        <LiveAgentChat
          onConversationStarted={mocks.started}
          onStartFreshTeamPlanning={mocks.startFreshTeamPlanning}
          initialDraft="Home question"
          initialSelection={selection}
          teamRequestId="agent-request"
          teamRequestTeamId="team"
          teamRequestExpectedRequestVersion={4}
          teamRequestExpectedReviewVersion={2}
        />
      </StrictMode>
    );
  });
  await flushReact();
  expect(
    (mocks.view.mock.lastCall?.[0].runtime as NewChatRuntime).enabled
  ).toBe(true);

  mocks.launchOptionsGate = null;
  await act(async () => {
    resolveLaunchOptions({
      runners: [
        {
          kind: "local_device",
          deviceId: "device-1",
          deploymentId: "deployment-1",
          displayName: "This device"
        }
      ],
      instances: [
        {
          ready: true,
          instanceId: "chosen-client",
          driverId: "codex",
          models: [{ id: "chosen-model", supportedReasoningEfforts: ["high"] }],
          capabilities: {
            permissionModes: [{ mode: "full_access", support: "supported" }]
          }
        }
      ]
    });
    await sendOutcome;
  });

  expect(await sendOutcome).toEqual({ accepted: true });
  expect(
    mocks.request.mock.calls.find((call) => call[0] === "")?.[1]
  ).toMatchObject({
    teamAgentRequest: {
      requestId: "agent-request",
      expectedRequestVersion: 4,
      expectedReviewVersion: 2
    }
  });
  const executionHandoffs = router.replace.mock.calls.filter((call) =>
    String(call[0]).includes("execution=")
  );
  expect(executionHandoffs.at(-1)?.[0]).toContain("teamReviewVersion=2");
  expect(executionHandoffs.at(-1)?.[0]).toContain("agent=agent-a");
  expect(
    router.replace.mock.calls.every((call) =>
      String(call[0]).includes("teamReviewVersion=2")
    )
  ).toBe(true);
});
it("submits the Home question once, displays the conversation, and continues the same execution", async () => {
  await mount();
  const calls = mocks.request.mock.calls;
  expect(calls.filter((call) => call[0] === "")).toHaveLength(1);
  expect(calls.find((call) => call[0] === "")?.[1]).toMatchObject({
    model: "chosen-model",
    reasoningEffort: "high",
    aiClientInstanceId: "chosen-client",
    projectId: null,
    contextKind: "independent"
  });
  expect(
    calls.filter((call) => String(call[0]).endsWith("/prompts"))
  ).toHaveLength(1);
  expect(
    calls.find((call) => String(call[0]).endsWith("/prompts"))?.[1]
  ).toMatchObject({
    prompt: "Home question",
    agentId: "agent-a",
    expectedAgentVersion: 2
  });
  expect(mocks.started).toHaveBeenCalledTimes(1);
  expect(mocks.started).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Home question", projectId: null })
  );
  expect(container.textContent).toContain("Home question");
  expect(container.textContent).toContain("Agent response");
  expect(container.querySelector("textarea")?.value).toBe("");
  const runtime = mocks.view.mock.lastCall?.[0].runtime as NewChatRuntime;
  expect(runtime.restoreSelection).toMatchObject({
    model: "chosen-model",
    effort: "high",
    instanceId: "chosen-client"
  });
  await act(async () => {
    await runtime.onSend("Follow-up question", selection);
  });
  expect(
    mocks.request.mock.calls.filter((call) => call[0] === "")
  ).toHaveLength(1);
  expect(
    mocks.request.mock.calls.filter((call) =>
      String(call[0]).endsWith("/prompts")
    )
  ).toHaveLength(2);
  expect(
    mocks.request.mock.calls
      .filter((call) => String(call[0]).endsWith("/prompts"))
      .at(-1)?.[1]
  ).toMatchObject({ prompt: "Follow-up question" });
});
it("retains the incoming question and exposes a failed send instead of losing it to the old saved draft", async () => {
  mocks.fail = true;
  await mount();
  await flushReact();
  await vi.waitFor(() => {
    expect(mocks.view.mock.lastCall?.[0].runtime.error).toBe("Start failed");
  });
  expect(container.querySelector("textarea")?.value).toBe("Home question");
  expect(
    mocks.request.mock.calls.filter((call) => call[0] === "")
  ).toHaveLength(1);
  expect(
    mocks.request.mock.calls.filter((call) =>
      String(call[0]).endsWith("/prompts")
    )
  ).toHaveLength(0);
});

it("an explicit retry of a failed Home send reuses its durable start identity", async () => {
  mocks.fail = true;
  await mount();
  const first = mocks.request.mock.calls.find((call) => call[0] === "")?.[1];
  mocks.fail = false;
  const runtime = mocks.view.mock.lastCall?.[0].runtime as NewChatRuntime;
  await act(async () => {
    await runtime.onSend("Home question", selection);
  });
  const starts = mocks.request.mock.calls.filter((call) => call[0] === "");
  expect(starts).toHaveLength(2);
  expect(starts[1][1].idempotencyKey).toBe(first.idempotencyKey);
  expect(
    mocks.request.mock.calls.filter((call) =>
      String(call[0]).endsWith("/prompts")
    )
  ).toHaveLength(1);
});

it("submits a Home question without a saved Agent and continues that direct conversation", async () => {
  const directSelection = { ...selection, agentId: null };
  await mount(directSelection);
  expect(
    mocks.request.mock.calls.filter((call) => call[0] === "")
  ).toHaveLength(1);
  const firstPrompt = mocks.request.mock.calls.find((call) =>
    String(call[0]).endsWith("/prompts")
  )?.[1];
  expect(firstPrompt).toMatchObject({ prompt: "Home question" });
  expect(firstPrompt).not.toHaveProperty("agentId");
  expect(firstPrompt).not.toHaveProperty("expectedAgentVersion");
  expect(container.textContent).toContain("Home question");
  expect(container.textContent).toContain("Agent response");
  expect(container.querySelector("textarea")?.value).toBe("");
  const runtime = mocks.view.mock.lastCall?.[0].runtime as NewChatRuntime;
  expect(runtime.enabled).toBe(true);
  await act(async () => {
    await runtime.onSend("Follow-up question", directSelection);
  });
  expect(
    mocks.request.mock.calls.filter((call) => call[0] === "")
  ).toHaveLength(1);
  const prompts = mocks.request.mock.calls.filter((call) =>
    String(call[0]).endsWith("/prompts")
  );
  expect(prompts).toHaveLength(2);
  expect(prompts[1][1]).toMatchObject({ prompt: "Follow-up question" });
  expect(prompts[1][1]).not.toHaveProperty("agentId");
});

const batchSelection: ChatComposerSelection = {
  ...selection,
  agentId: agentB,
  recipients: [
    {
      agentId: agentB,
      expectedAgentVersion: 3,
      provider: "claude",
      model: "other-model",
      effort: "medium",
      permissionMode: "ask",
      instanceId: "claude-client",
      targetDeviceId: "device-1"
    },
    {
      agentId: agentA,
      expectedAgentVersion: 2,
      provider: "codex",
      model: "chosen-model",
      effort: "high",
      permissionMode: "full",
      instanceId: "chosen-client",
      targetDeviceId: "device-1"
    }
  ]
};

function installPersonalRead() {
  mocks.personalRead.mockImplementation(async (conversationId: string) => {
    if (!conversationId) throw new Error("A conversation id is required");
    if (!mocks.personalRoot)
      throw new Error("The conversation is not available yet");
    return {
      conversation: mocks.personalRoot.conversation,
      timelinePage: { hasMore: false, nextCursor: null }
    };
  });
}

it("waits for Personal send admission and clears its saved draft before navigating", async () => {
  mocks.agents = [
    { id: agentA, name: "Agent A", currentVersion: 2, lifecycle: "active" },
    { id: agentB, name: "Agent B", currentVersion: 3, lifecycle: "active" }
  ];
  installPersonalRead();
  let admit!: () => void;
  const admission = new Promise<void>((resolve) => {
    admit = resolve;
  });
  mocks.personalSubmit.mockImplementation(
    async (conversationId: string, request: TestSubmitRequest) => {
      await admission;
      mocks.personalRoot = makePersonalConversation(
        conversationId,
        request.requestId
      );
      return mocks.personalRoot;
    }
  );
  await mount(batchSelection);
  await flushReact();
  expect(mocks.personalSubmit).toHaveBeenCalledTimes(1);
  expect(router.replace).not.toHaveBeenCalled();
  expect(mocks.personalRead).not.toHaveBeenCalled();
  await act(async () => {
    admit();
  });
  await flushReact();
  const conversationId = mocks.personalSubmit.mock.calls[0]![0] as string;
  expect(router.replace).toHaveBeenCalledWith(
    `/?chat=1&conversation=${conversationId}`
  );
  expect(mocks.records.get(conversationId)?.draft).toBe("");
  expect(mocks.records.get(conversationId)?.pendingOperation).toBeUndefined();
});

it("submits one durable user turn to ordered mixed-provider Agents and keeps attributed replies and child history", async () => {
  mocks.agents = [
    { id: agentA, name: "Agent A", currentVersion: 2, lifecycle: "active" },
    { id: agentB, name: "Agent B", currentVersion: 3, lifecycle: "active" }
  ];
  installPersonalRead();
  mocks.personalSubmit.mockImplementation(
    async (conversationId: string, request: TestSubmitRequest) => {
      mocks.personalRequest = request;
      mocks.personalRoot = makePersonalConversation(
        conversationId,
        request.requestId
      );
      return mocks.personalRoot;
    }
  );
  await mount(batchSelection);
  await flushReact();

  const [conversationId, request] = mocks.personalSubmit.mock.calls[0]! as [
    string,
    TestSubmitRequest
  ];
  const personalRoot = mocks.personalRoot!;
  expect(request.text).toBe("Home question");
  expect(request.recipients.map((recipient) => recipient.agentId)).toEqual([
    agentB,
    agentA
  ]);
  expect(request.recipients.map((recipient) => recipient.provider)).toEqual([
    "claude",
    "codex"
  ]);
  expect(
    request.recipients.every(
      (recipient) => recipient.targetDeviceId === "device-1"
    )
  ).toBe(true);
  expect(
    personalRoot.conversation.messages.filter(
      (message) => message.kind === "user"
    )
  ).toHaveLength(1);

  const runtime = mocks.view.mock.lastCall?.[0].runtime as NewChatRuntime;
  expect(
    runtime.messages.filter((message) => message.role === "user")
  ).toHaveLength(1);
  expect(
    runtime.messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.author?.name)
  ).toEqual(["Agent A", "Agent B"]);
  expect(runtime.messages.map((message) => message.content)).toEqual([
    "Home question",
    "Reply from Agent A",
    "Reply from Agent B"
  ]);
  expect(
    runtime.personalConversation?.deliveries.map((delivery) => delivery.name)
  ).toEqual(["Agent A", "Agent B"]);
  expect(
    runtime.personalConversation?.deliveries.every(
      (delivery) => delivery.diffAvailable
    )
  ).toBe(true);
  expect(conversationId).toBe(personalRoot.conversation.conversationId);
});

it("clears a saved multi-Agent send when readback matches requestId even though turnId differs", async () => {
  mocks.agents = [
    { id: agentA, name: "Agent A", currentVersion: 2, lifecycle: "active" },
    { id: agentB, name: "Agent B", currentVersion: 3, lifecycle: "active" }
  ];
  installPersonalRead();
  mocks.personalSubmit.mockImplementation(
    async (conversationId: string, request: TestSubmitRequest) => {
      mocks.personalRequest = request;
      mocks.personalRoot = makePersonalConversation(
        conversationId,
        request.requestId
      );
      throw new Error("Response lost after admission");
    }
  );
  await mount(batchSelection);
  await flushReact();

  const [conversationId, request] = mocks.personalSubmit.mock.calls[0]! as [
    string,
    TestSubmitRequest
  ];
  const personalRoot = mocks.personalRoot!;
  const recoveredRecord = mocks.records.get(conversationId);
  expect(personalRoot.conversation.messages[0].requestId).toBe(
    request.requestId
  );
  expect(personalRoot.conversation.messages[0].turnId).not.toBe(
    request.requestId
  );
  expect(recoveredRecord?.pendingOperation).toBeUndefined();
  const runtime = mocks.view.mock.lastCall?.[0].runtime as NewChatRuntime;
  expect(runtime.personalConversation?.retryAvailable).toBe(false);
  expect(runtime.messages.map((message) => message.content)).toContain(
    "Reply from Agent B"
  );
  expect(mocks.personalSubmit).toHaveBeenCalledTimes(1);
});

it("reopens a Personal conversation with each participant's persisted launch settings", async () => {
  mocks.agents = [
    { id: agentA, name: "Agent A", currentVersion: 2, lifecycle: "active" },
    { id: agentB, name: "Agent B", currentVersion: 3, lifecycle: "active" }
  ];
  mocks.personalRoot = makePersonalConversation(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    replyRequestId
  );
  const marker = "<!-- koed-memory-attribution:v1:quoted user text -->";
  mocks.personalRoot.conversation.messages[0]!.text = `A quoted token: ${marker}`;
  mocks.personalRoot.conversation.messages[1]!.text = `Reply from Agent A\n${marker}`;
  installPersonalRead();
  await mount(batchSelection, {
    personalConversationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    submit: false,
    skipInitialSelection: true,
    initialDraft: ""
  });
  await flushReact();

  const runtime = mocks.view.mock.lastCall?.[0].runtime as NewChatRuntime;
  expect(runtime.messages[0]?.content).toBe(`A quoted token: ${marker}`);
  expect(runtime.messages[1]?.content).toBe("Reply from Agent A");
  expect(runtime.restoreSelection).toMatchObject({
    provider: "claude",
    model: "other-model",
    effort: "medium",
    permissionMode: "ask",
    instanceId: "claude-client"
  });
  expect(runtime.restoreAgentSelections?.[agentA]).toMatchObject({
    provider: "codex",
    model: "chosen-model",
    effort: "high",
    permissionMode: "full",
    instanceId: "chosen-client"
  });
  expect(runtime.restoreAgentSelections?.[agentB]).toMatchObject({
    provider: "claude",
    model: "other-model",
    effort: "medium",
    permissionMode: "ask",
    instanceId: "claude-client"
  });
});
