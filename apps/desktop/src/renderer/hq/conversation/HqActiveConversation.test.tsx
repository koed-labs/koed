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
import type { ManagedConversationPendingSend } from "../../state/use-managed-conversation-lifecycle.js";
import type { CollaborationRendererClient } from "../../../collaboration/renderer-client.js";
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
    managedProject: ManagedProjectDesktopApi | null = null,
    recovered: ManagedConversationPendingSend | null = null,
    recoveryStatus: "ready" | "unavailable" = "ready",
    visibilityClient?: CollaborationRendererClient
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
    const persistPendingSend = vi.fn(async () => undefined);
    const recoveredSends = recovered
      ? new Map([[recovered.request.executionId, recovered]])
      : new Map();
    const render = async (
      currentDraft = initialDraft,
      currentThread = currentDraft.thread
    ) =>
      act(async () =>
        root.render(
          <HqActiveConversation
            visibilityClient={visibilityClient}
            visibilityOwnerId={visibilityClient ? "owner-1" : null}
            visibilityRevision="revision-1"
            visibilityConnected={Boolean(visibilityClient)}
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
            lifecycle={
              {
                recoveryStatus,
                pendingSends: recoveredSends,
                persistPendingSend
              } as never
            }
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
      persistPendingSend,
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
    expect(container.querySelector("textarea")?.disabled).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>(
        '[aria-label^="Model and reasoning"]'
      )?.disabled
    ).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>(
        '[aria-label="Attach a Project file"]'
      )?.disabled
    ).toBe(true);
    expect(f.api.writeDraft).not.toHaveBeenCalled();
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
    const initialThread = {
      ...thread,
      logicalMemoryId: "00000000-0000-4000-8000-000000000105"
    };
    const initialDraft = {
      ...draft,
      thread: initialThread
    } as ManagedConversationDraft;
    let releaseVisibility!: (value: []) => void;
    const visibilityRead = new Promise<[]>(
      (resolve) => (releaseVisibility = resolve)
    );
    const visibilityClient = {
      listOwnedSharedMemoryGrants: vi.fn(() => visibilityRead),
      listOwnedShares: vi.fn(async () => ({ shares: [], nextCursor: null }))
    } as unknown as CollaborationRendererClient;
    const f = fixture(
      "ready",
      "queued",
      initialDraft,
      [],
      [],
      null,
      null,
      "ready",
      visibilityClient
    );
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
      ...initialDraft,
      conversation: replacementIdentity,
      thread: {
        ...initialThread,
        id: "thread-2",
        sessionId: "session-2",
        logicalMemoryId: "00000000-0000-4000-8000-000000000205"
      }
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
    await f.render(replacementDraft, initialThread);
    await act(async () => {
      releaseOld();
      await oldResumePending;
      releaseVisibility([]);
      await visibilityRead;
    });
    expect(container.querySelector(".hq-composer__visibility")).toBeNull();
    expect(visibilityClient.listOwnedSharedMemoryGrants).toHaveBeenCalledTimes(
      1
    );
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

  it("restores a durable uncertain second turn and never sends it automatically", async () => {
    const pending: ManagedConversationPendingSend = {
      request: {
        executionId: "execution-1",
        capturedSessionId: "execution-1",
        threadId: "execution-1",
        idempotencyKey: "desktop-prompt:stable",
        clientUserMessageId: "message-stable",
        prompt: "Saved uncertain second turn",
        fileMentionCommandIds: ["file-command"],
        terminalContextReferences: [],
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
      },
      attachments: [{ commandId: "file-command", label: "plan.md" }]
    };
    const f = fixture("ready", "queued", draft, [], [], null, pending);
    await f.render();
    expect(container.querySelector("textarea")?.value).toBe(
      pending.request.prompt
    );
    expect(container.querySelector("textarea")?.disabled).toBe(true);
    expect(f.send).not.toHaveBeenCalled();
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Retry the same prompt")!
        .click()
    );
    expect(f.send).toHaveBeenCalledWith(pending.request);
  });

  it("never retries an old saved request after the stable route adopts another execution", async () => {
    const pending: ManagedConversationPendingSend = {
      request: {
        executionId: "execution-1",
        capturedSessionId: "execution-1",
        threadId: "execution-1",
        idempotencyKey: "desktop-prompt:old-execution",
        clientUserMessageId: "message-old-execution",
        prompt: "Uncertain old turn",
        fileMentionCommandIds: [],
        terminalContextReferences: []
      },
      attachments: []
    };
    const f = fixture("ready", "queued", draft, [], [], null, pending);
    const replacementIdentity = {
      ...identity,
      executionId: "execution-2",
      capturedSessionId: "session-2",
      threadId: "thread-2"
    };
    vi.mocked(f.api.resume).mockImplementation(async (input) => ({
      operation: "resume",
      status: "ready",
      conversation:
        input.threadId === "thread-2" ? replacementIdentity : identity
    }));
    await f.render();
    const replacementDraft = {
      ...draft,
      conversation: replacementIdentity,
      thread: { ...thread, id: "thread-2", sessionId: "session-2" }
    } as ManagedConversationDraft;
    await f.render(replacementDraft);
    expect(container.querySelector("textarea")?.value).toBe(
      pending.request.prompt
    );
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Retry the same prompt")!
        .click()
    );
    expect(f.send).not.toHaveBeenCalled();
    expect(f.api.writeDraft).not.toHaveBeenCalled();
    expect(f.persistPendingSend).not.toHaveBeenCalled();
    expect(container.textContent).toContain("different Conversation execution");
    expect(container.querySelector("textarea")?.disabled).toBe(true);
  });

  it("keeps an unreadable runtime unresolved and permits only exact manual retry", async () => {
    const pending: ManagedConversationPendingSend = {
      request: {
        executionId: "execution-1",
        capturedSessionId: "execution-1",
        threadId: "execution-1",
        idempotencyKey: "desktop-prompt:stable",
        clientUserMessageId: "message-stable",
        prompt: "Still uncertain",
        fileMentionCommandIds: [],
        terminalContextReferences: []
      },
      attachments: []
    };
    const f = fixture("ready", "queued", draft, [], [], null, pending);
    vi.mocked(f.api.runtime).mockRejectedValue(
      new Error("runtime unavailable")
    );
    await f.render();
    expect(container.querySelector("textarea")?.disabled).toBe(true);
    expect(f.send).not.toHaveBeenCalled();
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Retry the same prompt")!
        .click()
    );
    expect(f.send).toHaveBeenCalledWith(pending.request);
  });

  it("keeps the composer locked when owner recovery cannot be read", async () => {
    const f = fixture(
      "ready",
      "queued",
      draft,
      [],
      [],
      null,
      null,
      "unavailable"
    );
    await f.render();
    expect(container.querySelector("textarea")?.disabled).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')
        ?.disabled
    ).toBe(true);
    expect(f.api.writeDraft).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("does not dispatch when the durable send-intent write fails", async () => {
    const f = fixture();
    f.persistPendingSend.mockRejectedValueOnce(
      new Error("secure store failed")
    );
    await f.render();
    await f.enter("Keep this local");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Send message"]')!
        .click()
    );
    expect(f.send).not.toHaveBeenCalled();
    expect(container.querySelector("textarea")?.value).toBe("Keep this local");
    expect(container.textContent).toContain("Nothing was sent");
  });

  it("removes a failed optimistic send before a new manual send", async () => {
    vi.useFakeTimers();
    const f = fixture("ready", "uncertain");
    await f.render();
    await f.enter("Try this once");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Send message"]')!
        .click()
    );
    expect(container.textContent).toContain("Sending…");
    f.setLatestCommand({
      id: "failed-command",
      sequence: 1,
      executionGeneration: 1,
      commandKind: "prompt",
      clientUserMessageId: f.send.mock.calls[0]![0].clientUserMessageId,
      state: "failed",
      lastErrorCode: null,
      updatedAt: "2026-10-19T01:00:00Z"
    });
    await act(async () => vi.advanceTimersByTimeAsync(2_001));
    expect(container.textContent).not.toContain("Sending…");
    expect(container.querySelector("textarea")?.value).toBe("Try this once");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Send message"]')!
        .click()
    );
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(container.querySelectorAll("small")).toHaveLength(1);
  });

  it("serializes draft autosaves, dispatch save, and delete in typing order", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const writes: string[] = [];
    vi.mocked(f.api.writeDraft).mockImplementation(async (input) => {
      writes.push(`write:${input.value}`);
      return { operation: "draft_write", ok: true };
    });
    vi.mocked(f.api.deleteDraft).mockImplementation(async () => {
      writes.push("delete");
      return { operation: "draft_delete", ok: true };
    });
    await f.render();
    await f.enter("A");
    await f.enter("AB");
    expect(writes).toEqual([]);
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(writes).toEqual(["write:AB"]);
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Send message"]')!
        .click();
    });
    expect(f.send).toHaveBeenCalledOnce();
    expect(writes).toEqual(["write:AB", "write:AB", "delete"]);
    f.setLatestCommand({
      id: "command-1",
      sequence: 1,
      executionGeneration: 1,
      commandKind: "prompt",
      clientUserMessageId: f.send.mock.calls[0]![0].clientUserMessageId,
      state: "completed",
      lastErrorCode: null,
      updatedAt: "2026-10-19T01:00:00Z"
    });
    await act(async () => vi.advanceTimersByTimeAsync(2_001));
    expect(writes).toEqual(["write:AB", "write:AB", "delete"]);
  });

  it("treats queued acceptance as settled while allowing the next draft during the reply", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.render();
    await f.enter("First turn");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Send message"]')!
        .click()
    );
    expect(f.send).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain("Check delivery");
    expect(container.textContent).not.toContain("Retry same prompt");
    expect(container.querySelector("textarea")?.disabled).toBe(false);
    expect(f.persistPendingSend).toHaveBeenCalledWith(
      "execution-1",
      null,
      expect.objectContaining({ status: "queued" }),
      expect.objectContaining({
        clientUserMessageId: f.send.mock.calls[0]![0].clientUserMessageId
      })
    );
    await f.enter("Next unsent draft");
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(f.api.writeDraft).toHaveBeenCalledWith(
      expect.objectContaining({ value: "Next unsent draft" })
    );
  });

  it("flushes the latest draft immediately when navigating away before debounce", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.render();
    await f.enter("Draft before navigation");
    expect(f.api.writeDraft).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    expect(f.api.writeDraft).toHaveBeenCalledWith(
      expect.objectContaining({ value: "Draft before navigation" })
    );
    root = createRoot(container);
  });

  it("drains an in-flight autosave before final save and does not revive a sent draft", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operations: string[] = [];
    vi.mocked(f.api.writeDraft).mockImplementation(async (input) => {
      operations.push(`write:${input.value}`);
      if (operations.length === 1) await delayed;
      return { operation: "draft_write", ok: true };
    });
    vi.mocked(f.api.deleteDraft).mockImplementation(async () => {
      operations.push("delete");
      return { operation: "draft_delete", ok: true };
    });
    await f.render();
    await f.enter("A");
    await act(async () => vi.advanceTimersByTimeAsync(250));
    await f.enter("AB");
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Send message"]')!
        .click();
      release();
      await delayed;
    });
    expect(operations).toEqual(["write:A", "write:AB", "delete"]);
    const messageId = f.send.mock.calls[0]![0].clientUserMessageId;
    f.setLatestCommand({
      id: "done",
      sequence: 1,
      executionGeneration: 1,
      commandKind: "prompt",
      clientUserMessageId: messageId,
      state: "completed",
      lastErrorCode: null,
      updatedAt: "2026-10-19T01:00:00Z"
    });
    await act(async () => vi.advanceTimersByTimeAsync(2_001));
    expect(operations).toEqual(["write:A", "write:AB", "delete"]);
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

  it("retries the user turn preceding the selected older reply", async () => {
    const events = [
      ["user-1", "user", "First question"],
      ["reply-1", "assistant", "First answer"],
      ["user-2", "user", "Second question"],
      ["reply-2", "assistant", "Second answer"]
    ].map(([id, actor, content], index) => ({
      id,
      actor,
      content,
      eventType: "message",
      timestamp: `2026-10-19T00:00:0${index}Z`,
      sourceEventTime: null,
      sourceSequence: index + 1,
      invalidatedAt: null,
      metadata: {}
    })) as unknown as PersonalDesktopConversationEvent[];
    const capturedDraft = {
      ...draft,
      conversation: { ...identity, capturedSessionId: "captured-1" }
    } as ManagedConversationDraft;
    const f = fixture("ready", "queued", capturedDraft, events);
    await f.render();
    await act(async () =>
      container
        .querySelectorAll<HTMLButtonElement>(
          '[aria-label="Retry last prompt"]'
        )[0]!
        .click()
    );
    expect(container.querySelector("textarea")?.value).toBe("First question");
    await act(async () =>
      container
        .querySelectorAll<HTMLButtonElement>(
          '[aria-label="Retry last prompt"]'
        )[1]!
        .click()
    );
    expect(container.querySelector("textarea")?.value).toBe("Second question");
  });

  it("follows streamed content updates but respects manual scroll position", async () => {
    vi.useFakeTimers();
    const events = [
      {
        id: "reply-1",
        actor: "assistant",
        eventType: "message",
        content: "Part one",
        timestamp: "2026-10-19T00:00:00Z",
        sourceEventTime: null,
        sourceSequence: 1,
        invalidatedAt: null,
        metadata: {}
      }
    ] as unknown as PersonalDesktopConversationEvent[];
    const capturedDraft = {
      ...draft,
      conversation: { ...identity, capturedSessionId: "captured-1" }
    } as ManagedConversationDraft;
    const f = fixture("ready", "queued", capturedDraft, events);
    await f.render();
    const scroll = container.querySelector<HTMLElement>(
      ".hq-conversation__scroll"
    )!;
    let height = 500;
    Object.defineProperty(scroll, "scrollHeight", { get: () => height });
    Object.defineProperty(scroll, "clientHeight", { get: () => 100 });
    events[0]!.content = "Part one streamed part two";
    await act(async () => vi.advanceTimersByTimeAsync(2_001));
    expect(scroll.scrollTop).toBe(500);
    scroll.scrollTop = 100;
    scroll.dispatchEvent(new Event("scroll", { bubbles: true }));
    height = 800;
    events[0]!.content = "Part one streamed part two and three";
    await act(async () => vi.advanceTimersByTimeAsync(2_001));
    expect(scroll.scrollTop).toBe(100);
  });

  it("loads the next Project-file page with the returned offset and revision", async () => {
    let page = 0;
    const command = vi.fn(
      async (request: {
        operation: string;
        requestId: string;
        executionId: string;
        fileOperation?: { offset: number; revision: unknown };
      }) => {
        const commandRecord = {
          id: `file-command-${++page}`,
          state: "completed",
          commandKind: "file_browse",
          executionId: "execution-1",
          executionGeneration: 1,
          createdAt: "2026-10-19T00:00:00Z"
        };
        if (request.operation === "file_start")
          return {
            ...request,
            operation: "file_start",
            command: commandRecord
          };
        const offset = page > 2 ? 200 : 0;
        return {
          requestId: request.requestId,
          executionId: request.executionId,
          operation: "file_result",
          command: commandRecord,
          result: {
            protocolVersion: 1,
            checkpointId: "33333333-3333-4333-8333-333333333333",
            checkpointSequence: 1,
            revision: {
              checkpointId: "33333333-3333-4333-8333-333333333333",
              revisionDigest: "b".repeat(64)
            },
            kind: "browse",
            path: "",
            entries: [
              {
                path: offset ? "later.txt" : "first.txt",
                name: offset ? "later.txt" : "first.txt",
                entryKind: "file",
                size: 1,
                executable: false
              }
            ],
            totalEntries: 201,
            nextOffset: offset ? null : 200
          }
        };
      }
    );
    const f = fixture("ready", "queued", draft, [], [], {
      command
    } as unknown as ManagedProjectDesktopApi);
    await f.render();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Attach a Project file"]'
        )!
        .click()
    );
    expect(container.textContent).toContain("Load more (1 of 201)");
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.includes("Load more"))!
        .click()
    );
    const starts = command.mock.calls.filter(
      ([request]) => request.operation === "file_start"
    );
    expect(starts[1]![0].fileOperation).toMatchObject({
      offset: 200,
      revision: { revisionDigest: "b".repeat(64) }
    });
    expect(container.textContent).toContain("first.txt");
    expect(container.textContent).toContain("later.txt");
  });
});
