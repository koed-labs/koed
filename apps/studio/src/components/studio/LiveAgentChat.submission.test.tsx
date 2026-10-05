// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { LiveAgentChat } from "./LiveAgentChat";
import type { DeviceManagedChatRecoveryRecord } from "@/lib/device-managed-chat-recovery";
import type { ChatComposerSelection } from "../ChatComposer";
import type { NewChatRuntime } from "./NewChatView";
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  view: vi.fn(),
  records: new Map<string, DeviceManagedChatRecoveryRecord>(),
  fail: false,
  prompted: false
}));
const router = { replace: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/personal-agents-client", async (original) => ({
  ...(await original<object>()),
  personalAgentsHttpAdapter: {
    list: async () => [
      { id: "agent-a", name: "Agent A", currentVersion: 2, lifecycle: "active" }
    ]
  }
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
vi.mock("./NewChatView", () => ({
  NewChatView: (props: {
    runtime: NewChatRuntime;
    recoveredDraft: string | null;
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
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  mocks.request.mockReset();
  mocks.view.mockClear();
  mocks.records.clear();
  mocks.fail = false;
  mocks.prompted = false;
  router.replace.mockClear();
});
async function mount(turnSelection = selection) {
  mocks.records.set("new", { schemaVersion: 1, draft: "" });
  mocks.request.mockImplementation(
    async (path: string, body?: Record<string, unknown>) => {
      if (path === "/access") return { user: { id: "owner" } };
      if (path === "/launch-options")
        return {
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
            }
          ]
        };
      if (path === "") {
        if (mocks.fail) throw new Error("Start failed");
        return { execution };
      }
      if (path.endsWith("/runtime"))
        return { execution, items: [], latestCommand: null };
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
      return {};
    }
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <StrictMode>
        <LiveAgentChat
          initialDraft="Home question"
          initialSelection={turnSelection}
          initialSubmission={{
            id: "home-send",
            text: "Home question",
            selection: turnSelection
          }}
        />
      </StrictMode>
    )
  );
}
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
  expect(container.textContent).toContain("Home question");
  expect(container.textContent).toContain("Agent response");
  expect(container.querySelector("textarea")?.value).toBe("");
  const runtime = mocks.view.mock.lastCall?.[0].runtime as NewChatRuntime;
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
  expect(mocks.view.mock.lastCall?.[0].runtime.error).toBe("Start failed");
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
