// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { LiveAgentChat } from "./LiveAgentChat";
import type { RuntimeSnapshot } from "@/lib/managed-agent-chat";

const mocks = vi.hoisted(() => ({
  request: vi.fn(async (path: string) => {
    void path;
    return {};
  }),
  view: vi.fn(),
  snapshot: null as RuntimeSnapshot | null
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const router = { replace: vi.fn(), push: vi.fn() };
vi.mock("@/lib/personal-agents-client", async (original) => ({
  ...(await original<object>()),
  personalAgentsHttpAdapter: { list: async () => [] }
}));
vi.mock("@/lib/managed-agent-chat", async (original) => ({
  ...(await original<object>()),
  managedRequest: mocks.request,
  parseLaunchInstances: () => [],
  parseRuntime: () => mocks.snapshot
}));
vi.mock("@/lib/hosted-managed-chats", async (original) => ({
  ...(await original<object>()),
  loadLatestLocalProjectMove: async () => null,
  loadLocalRetainedWorkspaces: async () => []
}));
vi.mock("./NewChatView", () => ({
  NewChatView: (props: {
    projectSelector: ReactNode;
    initialDraft: string;
  }) => {
    mocks.view(props);
    return (
      <div>
        {props.projectSelector}
        <textarea defaultValue={props.initialDraft} />
      </div>
    );
  }
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const project = { id: `lp_${"a".repeat(32)}`, name: "Selected project" };
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  vi.clearAllMocks();
  mocks.snapshot = null;
});
async function mount(
  choose?: () => Promise<typeof project | null>,
  executionId?: string,
  projects = [project]
) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <LiveAgentChat
        executionId={executionId}
        initialDraft="Retained prompt"
        projectId={project.id}
        projectName={project.name}
        registeredProjects={projects}
        onChooseChatFolder={choose}
      />
    )
  );
}
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === text
  )!;
  await act(async () => button.click());
}
const scope = () => mocks.view.mock.lastCall?.[0].clientResourceScope.projectId;
it("changes the new chat context to No folder and back without remounting the draft or starting an execution", async () => {
  await mount();
  const draft = container.querySelector("textarea")!;
  draft.value = "Edited prompt";
  await click(project.name);
  expect(container.querySelector('[role="menu"]')?.className).toContain(
    "bottom-full"
  );
  await click("No folder");
  expect(scope()).toBeNull();
  expect(container.querySelector("textarea")).toBe(draft);
  expect(draft.value).toBe("Edited prompt");
  await click("Personal");
  await click(project.name);
  expect(scope()).toBe(project.id);
  expect(mocks.request.mock.calls.map((call) => call[0])).toEqual([
    "/launch-options",
    "/access"
  ]);
});
it("uses a folder returned by the native picker and retains the draft", async () => {
  const selected = { id: `lp_${"b".repeat(32)}`, name: "Native folder" };
  const choose = vi.fn(async () => selected);
  await mount(choose);
  await click(project.name);
  await click("Choose folder…");
  expect(choose).toHaveBeenCalledOnce();
  expect(scope()).toBe(selected.id);
  expect(container.querySelector("textarea")?.value).toBe("Retained prompt");
  expect(container.textContent).toContain("Native folder");
});

it("shows the running chat's actual folder and reviews a move without changing context or sending", async () => {
  const actual = { id: `lp_${"c".repeat(32)}`, name: "Actual runtime folder" };
  const id = "12345678-1234-4234-8234-123456789012";
  mocks.snapshot = {
    execution: {
      id,
      projectId: actual.id,
      provider: "codex",
      aiClientInstanceId: "instance",
      executionGeneration: 1,
      stateVersion: 1,
      state: "running",
      lastErrorCode: null,
      model: "model-a",
      reasoningEffort: "medium",
      permissionMode: "full_access"
    },
    items: [],
    latestCommand: null
  };
  await mount(undefined, id, [project, actual]);
  expect(scope()).toBe(actual.id);
  expect(container.textContent).not.toContain("Current Project:");
  expect(
    [...container.querySelectorAll("button")].some(
      (button) => button.textContent?.trim() === "Move to Project"
    )
  ).toBe(false);
  expect(mocks.view.mock.lastCall?.[0].conversationProjectName).toBe(
    actual.name
  );
  await click(actual.name);
  const noFolder = [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === "No folder"
  )!;
  expect(noFolder.disabled).toBe(true);
  await click(project.name);
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
    "Move to Project?"
  );
  expect(scope()).toBe(actual.id);
  expect(
    mocks.request.mock.calls.every((call) => !call[0].includes("/start"))
  ).toBe(true);
});
