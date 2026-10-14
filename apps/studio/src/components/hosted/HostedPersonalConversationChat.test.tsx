// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { PersonalAgentChatConversation } from "@koed/shared/personal-agent-chat-contract";
import type { DeviceManagedChatRecoveryRecord } from "@/lib/device-managed-chat-recovery";
import type { ChatComposerSelection } from "@/components/ChatComposer";
import type {
  NewChatRuntime,
  NewChatViewProps
} from "@/components/studio/NewChatView";
import { HostedManagedChatError } from "@/lib/hosted-managed-chats";
import { HostedPersonalConversationChat } from "./HostedPersonalConversationChat";

const mocks = vi.hoisted(() => ({
  agentsList: vi.fn(),
  launchOptions: vi.fn(),
  access: vi.fn(),
  managedConversation: vi.fn(),
  managedDiff: vi.fn(),
  control: vi.fn(),
  personalRead: vi.fn(),
  personalSubmit: vi.fn(),
  cancel: vi.fn(),
  continueDelivery: vi.fn(),
  rename: vi.fn(),
  view: vi.fn(),
  records: new Map<string, DeviceManagedChatRecoveryRecord>()
}));
const router = { replace: vi.fn(), push: vi.fn() };

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/personal-agents-client", async (original) => ({
  ...(await original<object>()),
  personalAgentsHttpAdapter: { list: mocks.agentsList }
}));
vi.mock("@/lib/personal-conversations-client", async (original) => ({
  ...(await original<object>()),
  readPersonalConversation: mocks.personalRead,
  submitPersonalConversationMessage: mocks.personalSubmit,
  cancelPersonalConversationMessage: mocks.cancel,
  continuePersonalConversationMessage: mocks.continueDelivery,
  renamePersonalConversation: mocks.rename
}));
vi.mock("@/lib/hosted-managed-chats", async (original) => ({
  ...(await original<object>()),
  loadHostedConversationDiff: mocks.managedDiff,
  loadHostedLaunchOptions: mocks.launchOptions,
  loadHostedManagedConversation: mocks.managedConversation,
  loadHostedManagedConversationAccess: mocks.access,
  requestHostedConversationControl: mocks.control
}));
vi.mock("@/lib/device-managed-chat-recovery", async (original) => ({
  ...(await original<object>()),
  createDeviceManagedChatRecoveryStore: ({
    executionId
  }: {
    executionId?: string | null;
  }) => {
    const key = executionId ?? "new";
    const write = (record: DeviceManagedChatRecoveryRecord) => {
      mocks.records.set(key, structuredClone(record));
    };
    return {
      read: () => mocks.records.get(key) ?? null,
      write,
      writeDurably: async (record: DeviceManagedChatRecoveryRecord) =>
        write(record),
      clear: () => mocks.records.delete(key),
      flush: async () => {}
    };
  }
}));
vi.mock("@/components/studio/NewChatView", async () => {
  const React = await import("react");
  return {
    NewChatView: (props: NewChatViewProps) => {
      mocks.view(props);
      const [editedDraft, setEditedDraft] = useState<string | null>(null);
      const draft =
        editedDraft ?? props.recoveredDraft ?? props.initialDraft ?? "";
      return React.createElement(
        "div",
        null,
        React.createElement(
          "output",
          { "data-testid": "enabled" },
          String(Boolean(props.runtime?.enabled))
        ),
        React.createElement(
          "div",
          { "data-testid": "messages" },
          props.runtime?.messages.map((message) =>
            React.createElement("p", { key: message.id }, message.content)
          )
        ),
        React.createElement("textarea", {
          "aria-label": "test draft",
          value: draft,
          onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => {
            const value = event.currentTarget.value;
            setEditedDraft(value);
            props.onDraftChange?.(value);
          }
        }),
        React.createElement(
          "button",
          {
            type: "button",
            onClick: () => {
              setEditedDraft("newer typed draft");
              props.onDraftChange?.("newer typed draft");
            }
          },
          "type newer draft"
        )
      );
    }
  };
});

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
const conversationId = "12345678-1234-4234-8234-123456789012";
const agent = {
  id: "agent-a",
  ownerId: "owner-a",
  name: "Agent A",
  role: "Reviewer",
  soul: "",
  avatar: undefined,
  lifecycle: "active",
  defaultProvider: null,
  defaultModel: null,
  defaultReasoningEffort: null,
  currentVersion: 2,
  createdAt: 1,
  updatedAt: 1,
  retiredAt: null,
  projects: [],
  runningNow: [],
  jobs: [],
  highlights: [],
  stats: null,
  jobsHasMore: false,
  jobsNextCursor: null,
  activityLoaded: false,
  sourceTemplateId: null,
  sourceTemplateVersion: null
};
const selection: ChatComposerSelection = {
  agentId: agent.id,
  provider: "codex",
  model: "chosen-model",
  effort: "high",
  permissionMode: "full",
  instanceId: "chosen-client"
};
const options = {
  runners: [{ deviceId: "device-1", displayName: "Personal Device" }],
  instances: [
    {
      instanceId: "chosen-client",
      hostedInstanceId: "chosen-client",
      driverId: "codex",
      runnerDeviceId: "device-1",
      models: [
        {
          id: "chosen-model",
          displayName: "Chosen model",
          supportedReasoningEfforts: ["high"]
        }
      ],
      permissionModes: ["full_access"],
      ready: true,
      readiness: "ready"
    }
  ],
  projects: []
};

function makeConversation(
  id: string,
  text = "Protected timeline message",
  activeExecutionId: string | null = null
): PersonalAgentChatConversation {
  return {
    contractVersion: 1,
    conversationId: id,
    title: "Protected chat",
    projectId: null,
    contextKind: "independent",
    status: "idle",
    activeAgentId: agent.id,
    activeExecutionId,
    activeProvider: "codex",
    sourceExecutionIds: [],
    childExecutionIds: [],
    capturedSessionIds: [],
    participants: [
      {
        agentId: agent.id,
        agentVersion: 2,
        name: agent.name,
        avatarReference: null,
        ordinal: 0,
        launch: {
          kind: "agent",
          agentId: agent.id,
          agentVersion: 2,
          provider: "codex",
          aiClientInstanceId: "chosen-client",
          targetDeviceId: "device-1",
          model: "chosen-model",
          reasoningEffort: "high",
          permissionMode: "full_access",
          selectedResourceIds: []
        },
        executionId: null,
        lastContextCursor: 0,
        status: "completed",
        updatedAt: "2026-10-14T12:00:00.000Z"
      }
    ],
    messages: [
      {
        id: "22345678-1234-4234-8234-123456789012",
        sequence: 1,
        turnId: "32345678-1234-4234-8234-123456789012",
        requestId: "42345678-1234-4234-8234-123456789012",
        kind: "user",
        text,
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
        createdAt: "2026-10-14T12:00:00.000Z"
      }
    ],
    deliveries: [],
    createdAt: "2026-10-14T12:00:00.000Z",
    updatedAt: "2026-10-14T12:00:00.000Z"
  } as PersonalAgentChatConversation & { hasOlderMessages?: boolean };
}

function installDefaults() {
  mocks.agentsList.mockImplementation(async () => [{ ...agent }]);
  mocks.launchOptions.mockResolvedValue(options);
  mocks.access.mockResolvedValue({
    ownerId: "owner-a",
    backendId: "backend-a"
  });
  mocks.managedConversation.mockResolvedValue({ runtime: {}, state: {} });
  mocks.managedDiff.mockResolvedValue({ events: [] });
  mocks.personalRead.mockImplementation(async (id: string) => ({
    conversation: makeConversation(id),
    timelinePage: { hasMore: false, nextCursor: null }
  }));
  mocks.personalSubmit.mockImplementation(
    async (id: string, request: { text: string }) => ({
      conversation: makeConversation(id, request.text),
      message: {},
      deliveries: []
    })
  );
}

async function mount(
  props: {
    conversationId?: string;
    initialDraft?: string;
  } = {}
) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <HostedPersonalConversationChat {...props} onBack={() => {}} />
    );
  });
  await flushReact();
}

async function flushReact() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  for (const mock of [
    mocks.agentsList,
    mocks.launchOptions,
    mocks.access,
    mocks.managedConversation,
    mocks.managedDiff,
    mocks.control,
    mocks.personalRead,
    mocks.personalSubmit,
    mocks.cancel,
    mocks.continueDelivery,
    mocks.rename
  ])
    mock.mockReset();
  mocks.view.mockClear();
  mocks.records.clear();
  router.replace.mockClear();
  router.push.mockClear();
});

it("bootstraps once when parsing returns a fresh Agent list", async () => {
  installDefaults();
  await mount();

  expect(mocks.agentsList).toHaveBeenCalledTimes(1);
  expect(mocks.launchOptions).toHaveBeenCalledTimes(1);
  expect(mocks.access).toHaveBeenCalledTimes(1);
});

it("waits for admission and preserves newer typing after the submitted text is accepted", async () => {
  installDefaults();
  let admit!: (value: {
    conversation: PersonalAgentChatConversation;
    message: Record<string, unknown>;
    deliveries: unknown[];
  }) => void;
  const admission = new Promise<{
    conversation: PersonalAgentChatConversation;
    message: Record<string, unknown>;
    deliveries: unknown[];
  }>((resolve) => {
    admit = resolve;
  });
  mocks.personalSubmit.mockReturnValue(admission);
  await mount();

  const runtime = mocks.view.mock.lastCall?.[0].runtime as NewChatRuntime;
  let send!: Promise<unknown>;
  await act(async () => {
    send = runtime.onSend("submitted prompt", selection);
    await vi.waitFor(() =>
      expect(mocks.personalSubmit).toHaveBeenCalledTimes(1)
    );
  });
  expect(router.replace).not.toHaveBeenCalled();

  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "type newer draft")
      ?.click();
  });
  const submittedId = mocks.personalSubmit.mock.calls[0]?.[0] as string;
  await act(async () => {
    admit({
      conversation: makeConversation(submittedId, "submitted prompt"),
      message: {},
      deliveries: []
    });
    await send;
  });
  await flushReact();

  expect(router.replace).toHaveBeenCalledWith(
    `/?chat=1&conversation=${encodeURIComponent(submittedId)}`
  );
  expect(mocks.records.get(submittedId)?.draft).toBe("newer typed draft");
  expect(container.querySelector("textarea")?.value).toBe("newer typed draft");
});

it.each([401, 403])(
  "clears protected timeline and launch controls after confirmed HTTP %i while preserving the durable draft",
  async (status) => {
    installDefaults();
    const id = conversationId;
    mocks.records.set(id, {
      schemaVersion: 1,
      personalConversationId: id,
      draft: "keep this unsent draft"
    });
    mocks.personalRead.mockResolvedValue({
      conversation: makeConversation(
        id,
        "Private message",
        "managed-execution"
      ),
      timelinePage: { hasMore: false, nextCursor: null }
    });
    mocks.managedConversation.mockRejectedValue(
      new HostedManagedChatError("Access denied", status)
    );
    await mount({ conversationId: id });

    expect(mocks.personalRead).toHaveBeenCalledTimes(1);
    expect(mocks.managedConversation).toHaveBeenCalledWith(
      "managed-execution",
      expect.any(AbortSignal)
    );

    const after = mocks.view.mock.lastCall?.[0] as NewChatViewProps;
    expect(after.runtime?.messages).toEqual([]);
    expect(after.runtime?.enabled).toBe(false);
    expect(after.modelOptions).toEqual([]);
    expect(container.textContent).not.toContain("Private message");
    expect(mocks.records.get(id)?.draft).toBe("keep this unsent draft");
  }
);
