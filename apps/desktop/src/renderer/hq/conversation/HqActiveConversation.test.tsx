// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopProject } from "../../../project-memory-ui.js";
import type {
  ManagedConversationDesktopApi,
  ManagedConversationLaunchOptions,
  ManagedConversationRuntimeItem
} from "../../../ipc/managed-conversation-protocol.js";
import type { ManagedProjectDesktopApi } from "../../../ipc/managed-project-protocol.js";
import type { PersonalMemoryStore } from "../../state/personal-memory.js";
import type { PersonalDesktopConversationEvent } from "@koed/shared/personal-desktop";
import type { ManagedConversationDraft } from "../../state/use-managed-conversation-lifecycle.js";
import { HqActiveConversation } from "./HqConversation.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const options: ManagedConversationLaunchOptions = {
  runners: [],
  instances: [
    {
      instanceId: "codex.default",
      driverId: "codex",
      displayName: "Codex",
      ready: true,
      readiness: "ready",
      models: [
        {
          id: "model-a",
          isDefault: true,
          supportedReasoningEfforts: ["low", "high"]
        },
        { id: "model-b", supportedReasoningEfforts: ["low", "high"] }
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
};
const project = {
  id: "project-1",
  name: "Project",
  path: "/project",
  contextKind: "project",
  threads: []
} as unknown as DesktopProject;
const identity = {
  executionId: "execution-1",
  projectId: "project-1",
  capturedSessionId: "execution-1",
  threadId: "execution-1",
  executionOwner: { driverId: "codex" as const, instanceId: "codex.default" }
};
const thread = {
  id: "execution-1",
  sessionId: "execution-1",
  projectId: "project-1",
  name: "Conversation",
  projectName: "Project",
  projectPath: "/project",
  sourceAiClient: "codex",
  projectAssignmentSource: "user_override",
  eventCount: 0,
  invalidatedCount: 0,
  latestAt: "2026-10-19T00:00:00Z",
  sample: "",
  presentation: null
} as const;
const draft = {
  conversation: identity,
  thread,
  status: "ready",
  message: "",
  launchInput: {
    projectId: "project-1",
    contextKind: "project",
    aiClientDriverId: "codex",
    aiClientInstanceId: "codex.default",
    model: "model-a",
    reasoningEffort: "low",
    permissionMode: "supervised",
    runnerKind: "local_device",
    idempotencyKey: "desktop-conversation:key"
  }
} as ManagedConversationDraft;
const store = {
  subscribe: () => () => undefined,
  detail: () => null,
  loadInitial: vi.fn(async () => null),
  refreshFromDurableEvent: vi.fn()
} as unknown as PersonalMemoryStore;

describe("HQ active Conversation", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });
  function fixture(
    resumeStatus: "ready" | "read_only" = "ready",
    sendResult: "queued" | "uncertain" = "queued",
    initialDraft = draft,
    events: PersonalDesktopConversationEvent[] = [],
    runtimeItems: ManagedConversationRuntimeItem[] = [],
    managedProject: ManagedProjectDesktopApi | null = null
  ) {
    let latestCommand: {
      id: string;
      sequence: number;
      executionGeneration: number;
      commandKind: string;
      clientUserMessageId: string | null;
      state: string;
      lastErrorCode: string | null;
      updatedAt: string;
    } | null = null;
    const send = vi.fn<ManagedConversationDesktopApi["send"]>(async (input) => {
      if (sendResult === "uncertain") throw new Error("response lost");
      return {
        operation: "send",
        status: "queued",
        conversation: identity,
        idempotencyKey: input.idempotencyKey,
        clientUserMessageId: input.clientUserMessageId
      };
    });
    const api = {
      resume: vi.fn(async () => ({
        operation: "resume",
        status: resumeStatus,
        conversation:
          resumeStatus === "read_only"
            ? { ...identity, executionId: null }
            : identity
      })),
      runtime: vi.fn(async () => ({
        operation: "runtime",
        executionId: "execution-1",
        executionGeneration: 1,
        executionStateVersion: 1,
        executionState: "running",
        executionLastErrorCode: null,
        latestCommand,
        items: runtimeItems
      })),
      usage: vi.fn(async () => ({
        operation: "usage",
        executionId: "execution-1",
        provider: "codex",
        model: "model-a",
        reasoningEffort: "low",
        permissionMode: "supervised",
        usage: null
      })),
      launchOptions: vi.fn(async () => ({
        operation: "launch_options",
        options
      })),
      readDraft: vi.fn(async () => ({ operation: "draft_read", value: "" })),
      writeDraft: vi.fn(async () => ({ operation: "draft_write", ok: true })),
      deleteDraft: vi.fn(async () => ({ operation: "draft_delete", ok: true })),
      discoverCommands: vi.fn(async () => ({
        operation: "command_discovery",
        status: "ok",
        commands: []
      })),
      respond: vi.fn(async (input) => ({
        operation: "runtime_respond",
        accepted: true,
        itemId: input.itemId
      })),
      stop: vi.fn(),
      interrupt: vi.fn(),
      send
    } as unknown as ManagedConversationDesktopApi;
    const render = async (
      currentDraft = initialDraft,
      currentThread = currentDraft.thread
    ) =>
      act(async () =>
        root.render(
          <HqActiveConversation
            api={api}
            managedProject={managedProject}
            store={
              events.length
                ? ({
                    ...store,
                    detail: () => ({
                      events,
                      error: null,
                      hasOlder: false,
                      lastAccessedAt: 0,
                      loadedAt: 0,
                      status: "ready",
                      thread
                    })
                  } as unknown as PersonalMemoryStore)
                : store
            }
            project={project}
            thread={currentThread}
            draft={currentDraft}
            onRetryStart={vi.fn()}
            markdownAdapters={{
              openExternal: vi.fn(),
              writeClipboard: vi.fn()
            }}
          />
        )
      );
    const enter = async (message: string) =>
      act(async () => {
        const textarea = container.querySelector("textarea")!;
        Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value"
        )!.set!.call(textarea, message);
        textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
      });
    return {
      api,
      send,
      render,
      enter,
      setLatestCommand: (value: NonNullable<typeof latestCommand>) => {
        latestCommand = value;
      }
    };
  }

  it("blocks a captured-only read-only Conversation", async () => {
    const f = fixture("read_only");
    await f.render();
    await f.enter("Cannot send");
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')
        ?.disabled
    ).toBe(true);
    expect(container.textContent).toContain("read-only");
    expect(f.send).not.toHaveBeenCalled();
  });

  it("does not revive a draft execution after an authoritative read-only resume", async () => {
    const command = vi.fn();
    const f = fixture("read_only", "queued", draft, [], [], {
      command
    } as unknown as ManagedProjectDesktopApi);
    await f.render();
    await f.enter("Cannot mutate old execution");
    expect(vi.mocked(f.api.runtime)).not.toHaveBeenCalled();
    expect(vi.mocked(f.api.usage)).not.toHaveBeenCalled();
    expect(
      container.querySelector('[aria-label="Attach project file"]')
    ).toBeNull();
    expect(container.querySelector(".hq-file-picker")).toBeNull();
    expect(vi.mocked(f.api.respond)).not.toHaveBeenCalled();
    expect(vi.mocked(f.api.stop)).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("follows a replacement execution and canonical detail under the same route", async () => {
    const f = fixture();
    let releaseOld!: () => void;
    const oldResumePending = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const replacementIdentity = {
      ...identity,
      executionId: "execution-2",
      capturedSessionId: "session-2",
      threadId: "thread-2"
    };
    const replacementDraft = {
      ...draft,
      conversation: replacementIdentity,
      thread: { ...thread, id: "thread-2", sessionId: "session-2" }
    } as ManagedConversationDraft;
    vi.mocked(f.api.resume).mockImplementation(async (input) => {
      if (input.threadId !== "thread-2") {
        await oldResumePending;
        return {
          operation: "resume",
          status: "read_only",
          conversation: { ...identity, executionId: null }
        };
      }
      return {
        operation: "resume",
        status: "ready",
        conversation: replacementIdentity
      };
    });
    await f.render();
    await f.render(replacementDraft, thread);
    await act(async () => {
      releaseOld();
      await oldResumePending;
    });
    expect(vi.mocked(f.api.resume)).toHaveBeenCalledWith({
      projectId: "project-1",
      capturedSessionId: "session-2",
      threadId: "thread-2"
    });
    expect(vi.mocked(store.loadInitial)).toHaveBeenCalledWith(
      expect.objectContaining({ id: "thread-2", sessionId: "session-2" })
    );
    expect(vi.mocked(f.api.runtime)).toHaveBeenCalledWith("execution-2");
    await f.enter("Use replacement execution");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Send message"]')!
        .click()
    );
    expect(f.send).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: "execution-2",
        capturedSessionId: "session-2",
        threadId: "thread-2"
      })
    );
  });

  it("preserves a staged model change through runtime refresh and sends exact settingsChange", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.render();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label^="Model and reasoning"]'
        )!
        .click()
    );
    await act(async () =>
      document.body
        .querySelector<HTMLButtonElement>(
          '[aria-label="Choose AI Client and model"]'
        )!
        .click()
    );
    await act(async () =>
      [...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
        .find((item) => item.textContent?.includes("model-b"))!
        .click()
    );
    const initialRefreshes = vi.mocked(f.api.runtime).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_001);
    });
    vi.useRealTimers();
    expect(vi.mocked(f.api.runtime).mock.calls.length).toBeGreaterThan(
      initialRefreshes
    );
    await f.enter("Keep whitespace  ");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Send message"]')!
        .click()
    );
    expect(f.send).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Keep whitespace  ",
        settingsChange: {
          expected: {
            model: "model-a",
            reasoningEffort: "low",
            permissionMode: "supervised"
          },
          next: {
            model: "model-b",
            reasoningEffort: "low",
            permissionMode: "supervised"
          }
        }
      })
    );
  });

  it("offers supported reasoning levels and resets to the advertised default", async () => {
    const f = fixture();
    await f.render();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label^="Model and reasoning"]'
        )!
        .click()
    );
    await act(async () =>
      document.body
        .querySelector<HTMLButtonElement>(
          '[aria-label="Reasoning effort: High"]'
        )!
        .click()
    );
    expect(
      container
        .querySelector<HTMLButtonElement>('[aria-label^="Model and reasoning"]')
        ?.getAttribute("aria-label")
    ).toContain("High");
    await act(async () => {
      const high = document.body.querySelector<HTMLButtonElement>(
        '[aria-label="Reasoning effort: High"]'
      )!;
      high.focus();
      high.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })
      );
    });
    expect(
      document.body
        .querySelector('[aria-label="Reasoning effort: Low"]')
        ?.getAttribute("aria-checked")
    ).toBe("true");
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Reasoning effort: Low"
    );
    await act(async () =>
      document.body
        .querySelector<HTMLButtonElement>(
          '[aria-label="Reasoning effort: High"]'
        )!
        .click()
    );
    await act(async () =>
      document.body
        .querySelector<HTMLButtonElement>(
          '[aria-label="Reset reasoning effort"]'
        )!
        .click()
    );
    expect(
      container
        .querySelector<HTMLButtonElement>('[aria-label^="Model and reasoning"]')
        ?.getAttribute("aria-label")
    ).toContain("Low");
  });

  it("locks an uncertain send and allows only an explicit same-identity retry", async () => {
    const f = fixture("ready", "uncertain");
    await f.render();
    await f.enter("Uncertain prompt");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Send message"]')!
        .click()
    );
    expect(container.querySelector("textarea")?.disabled).toBe(true);
    expect(f.send).toHaveBeenCalledOnce();
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Retry the same prompt")!
        .click()
    );
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send.mock.calls[1]![0]).toEqual(f.send.mock.calls[0]![0]);
  });

  it("serializes draft autosaves, dispatch save, and delete in typing order", async () => {
    const f = fixture();
    const writes: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    vi.mocked(f.api.writeDraft).mockImplementation(async (input) => {
      writes.push(`write:${input.value}`);
      if (writes.length === 1) await blocked;
      return { operation: "draft_write", ok: true };
    });
    vi.mocked(f.api.deleteDraft).mockImplementation(async () => {
      writes.push("delete");
      return { operation: "draft_delete", ok: true };
    });
    await f.render();
    await f.enter("A");
    await f.enter("AB");
    expect(writes).toEqual(["write:A"]);
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Send message"]')!
        .click();
      releaseFirst?.();
      await blocked;
    });
    expect(f.send).toHaveBeenCalledOnce();
    expect(writes).toEqual(["write:A", "write:AB", "write:AB", "delete"]);
  });

  it("reloads a saved second-turn draft after a queued initial prompt", async () => {
    const f = fixture("ready", "queued", {
      ...draft,
      initialPrompt: {
        clientUserMessageId: "first-1",
        prompt: "Already sent",
        status: "queued" as const,
        message: ""
      }
    });
    vi.mocked(f.api.readDraft).mockResolvedValue({
      operation: "draft_read",
      value: "Unsent second turn"
    });
    await f.render();
    expect(container.querySelector("textarea")?.value).toBe(
      "Unsent second turn"
    );
    expect(f.send).not.toHaveBeenCalled();
  });

  it("restores the accepted prompt if its asynchronous settings command fails", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.render();
    await f.enter("Restore this prompt");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Send message"]')!
        .click()
    );
    const sentId = f.send.mock.calls[0]![0].clientUserMessageId;
    f.setLatestCommand({
      id: "command-1",
      sequence: 1,
      executionGeneration: 1,
      commandKind: "prompt",
      clientUserMessageId: sentId,
      state: "failed",
      lastErrorCode: "ManagedConversationSettingsUnavailableError",
      updatedAt: "2026-10-19T00:00:00Z"
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_001);
    });
    vi.useRealTimers();
    expect(container.querySelector("textarea")?.value).toBe(
      "Restore this prompt"
    );
    expect(container.textContent).toContain(
      "selected settings became unavailable"
    );
  });

  it("restores an uncertain first prompt without sending automatically", async () => {
    const uncertainDraft = {
      ...draft,
      initialPrompt: {
        clientUserMessageId: "first-1",
        prompt: "First prompt",
        status: "reconciling" as const,
        message: "Unknown outcome"
      }
    };
    const f = fixture("ready", "queued", uncertainDraft);
    await f.render();
    expect(container.querySelector("textarea")?.value).toBe("First prompt");
    expect(container.querySelector("textarea")?.disabled).toBe(true);
    expect(f.send).not.toHaveBeenCalled();
  });

  it("refreshes captured detail once when the prompt command completes", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.render();
    f.setLatestCommand({
      id: "terminal-command",
      sequence: 1,
      executionGeneration: 1,
      commandKind: "prompt",
      clientUserMessageId: "message-1",
      state: "completed",
      lastErrorCode: null,
      updatedAt: "2026-10-19T00:00:00Z"
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_001);
    });
    expect(vi.mocked(store.loadInitial)).toHaveBeenCalledWith(
      expect.objectContaining({ id: "execution-1" }),
      { refresh: true }
    );
    expect(
      vi.mocked(store.loadInitial).mock.calls.filter((call) => call[1]?.refresh)
    ).toHaveLength(1);
  });

  it("restores the accepted prompt after authentication failure", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.render();
    await f.enter("Retain after auth failure");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Send message"]')!
        .click()
    );
    const sentId = f.send.mock.calls[0]![0].clientUserMessageId;
    f.setLatestCommand({
      id: "auth-failed",
      sequence: 1,
      executionGeneration: 1,
      commandKind: "prompt",
      clientUserMessageId: sentId,
      state: "failed",
      lastErrorCode: "ManagedConversationAuthenticationError",
      updatedAt: "2026-10-19T00:00:00Z"
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_001);
    });
    expect(container.querySelector("textarea")?.value).toBe(
      "Retain after auth failure"
    );
    expect(container.textContent).toContain("rejected authentication");
  });

  it("binds inline approval response to item, kind, and execution generation", async () => {
    const item = {
      id: "approval-1",
      providerTurnId: null,
      providerItemId: null,
      itemKind: "command_approval",
      executionGeneration: 7,
      state: "pending",
      answered: false,
      presentation: {
        mode: "expanded",
        renderer: "approval",
        policyKey: "approval",
        policyRevision: 1,
        reason: "Fixture"
      },
      revision: 1,
      createdAt: "2026-10-19T00:00:00Z",
      updatedAt: "2026-10-19T00:00:00Z",
      payload: { command: ["pnpm", "test"], supportsSessionApproval: true }
    } satisfies ManagedConversationRuntimeItem;
    const f = fixture("ready", "queued", draft, [], [item]);
    await f.render();
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Always allow this session")!
        .click()
    );
    expect(f.api.respond).toHaveBeenCalledWith({
      executionId: "execution-1",
      itemId: "approval-1",
      itemKind: "command_approval",
      executionGeneration: 7,
      decision: "acceptForSession"
    });
  });

  it("renders verified transcript segments and suppresses approval status rows", async () => {
    const base = {
      timestamp: "2026-10-19T00:00:00Z",
      sourceEventTime: null,
      sourceSequence: 1,
      invalidatedAt: null,
      metadata: {}
    };
    const events = [
      {
        ...base,
        id: "transcript",
        actor: "user",
        eventType: "approval_review",
        content: "RAW ENVELOPE",
        transcriptDisplay: {
          kind: "approval_review",
          version: 1,
          truncated: false,
          segments: [
            {
              kind: "message",
              sequence: 1,
              actor: "user",
              content: "Verified request"
            },
            {
              kind: "message",
              sequence: 2,
              actor: "assistant",
              content: "Verified reply"
            }
          ]
        }
      },
      {
        ...base,
        id: "approval-status",
        actor: "assistant",
        eventType: "approval_activity",
        content: "HIDDEN APPROVAL STATUS"
      }
    ] as unknown as PersonalDesktopConversationEvent[];
    const capturedDraft = {
      ...draft,
      conversation: { ...identity, capturedSessionId: "captured-1" }
    } as ManagedConversationDraft;
    const f = fixture("ready", "queued", capturedDraft, events);
    await f.render();
    expect(container.textContent).toContain("Verified request");
    expect(container.textContent).toContain("Verified reply");
    expect(container.textContent).not.toContain("RAW ENVELOPE");
    expect(container.textContent).not.toContain("HIDDEN APPROVAL STATUS");
  });
});
