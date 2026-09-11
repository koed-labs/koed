// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useManagedConversationLifecycle,
  type ManagedConversationLifecycle
} from "./use-managed-conversation-lifecycle.js";
import { NewConversationComposer } from "../views/personal/NewConversationComposer.js";
import type { ManagedConversationDesktopApi } from "../../ipc/managed-conversation-protocol.js";
import type { PersonalMemoryStore } from "./personal-memory.js";
import type { DesktopProject } from "../../project-memory-ui.js";
import type { ManagedConversationRealtimeUpdate } from "./managed-conversation-runtime.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const executionId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const project: DesktopProject = {
  id: "project-1",
  name: "Research",
  path: "/tmp/research",
  eventCount: 0,
  threads: [],
  catalogued: true,
  discoveredAt: "2026-08-17T12:00:00.000Z",
  lastSeenAt: "2026-08-17T12:00:00.000Z",
  localProjectId: "project-1",
  branch: null,
  remoteDisplay: null,
  isWorktree: false
};
const conversation = {
  executionId,
  projectId: project.id,
  capturedSessionId: executionId,
  threadId: executionId
};
const launch = {
  projectId: project.id,
  aiClientDriverId: "codex",
  aiClientInstanceId: "codex.default",
  model: "model",
  reasoningEffort: null,
  permissionMode: "supervised",
  runnerKind: "local_device",
  idempotencyKey: "launch-original"
} as const;
const prompt = {
  clientUserMessageId: "33333333-3333-4333-8333-333333333333",
  prompt: "  Explain\nthis Project  ",
  status: "queued",
  message: ""
} as const;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("managed Conversation lifecycle", () => {
  let root: Root;
  let container: HTMLDivElement;
  let lifecycle: ManagedConversationLifecycle;
  beforeEach(() => {
    container = document.createElement("div");
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers();
  });
  function Harness(
    props: Parameters<typeof useManagedConversationLifecycle>[0]
  ) {
    lifecycle = useManagedConversationLifecycle(props);
    return null;
  }
  const started = () =>
    lifecycle.started(project, conversation, "starting", launch, prompt);

  it("persists and restores the same launch, message, and provisional title", async () => {
    vi.useFakeTimers();
    let saved = "";
    const api = {
      readRecovery: vi.fn(async () => ({
        operation: "recovery_read",
        value: saved
      })),
      writeRecovery: vi.fn(async (_owner: string, value: string) => {
        saved = value;
        return { operation: "recovery_write", ok: true };
      }),
      inspect: vi.fn(async () => ({
        operation: "inspect",
        status: "starting",
        executionId
      }))
    } as unknown as ManagedConversationDesktopApi;
    await act(async () =>
      root.render(<Harness api={api} store={null} ownerId="owner-1" />)
    );
    await act(async () => {
      expect(started()).toBe(executionId);
    });
    expect(lifecycle.drafts.get(executionId)?.thread).toMatchObject({
      name: "Explain this Project",
      sample: prompt.prompt
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(saved).toContain("launch-original");
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () =>
      root.render(<Harness api={api} store={null} ownerId="owner-1" />)
    );
    expect(lifecycle.drafts.get(executionId)).toMatchObject({
      conversation,
      launchInput: launch,
      initialPrompt: prompt
    });
  });

  it("does not let delayed recovery replace a newly accepted Conversation or another owner", async () => {
    const first = deferred<{ operation: "recovery_read"; value: string }>();
    const api = {
      readRecovery: vi.fn(() => first.promise),
      inspect: vi.fn(async () => ({
        operation: "inspect",
        status: "starting",
        executionId
      }))
    } as unknown as ManagedConversationDesktopApi;
    await act(async () =>
      root.render(<Harness api={api} store={null} ownerId="owner-1" />)
    );
    await act(async () => {
      started();
    });
    await act(async () =>
      first.resolve({ operation: "recovery_read", value: "" })
    );
    expect(lifecycle.drafts.size).toBe(1);
    const savedDraft = lifecycle.drafts.get(executionId);
    const second = deferred<{ operation: "recovery_read"; value: string }>();
    vi.mocked(api.readRecovery!)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValueOnce({ operation: "recovery_read", value: "" });
    await act(async () =>
      root.render(<Harness api={api} store={null} ownerId="owner-2" />)
    );
    await act(async () =>
      root.render(<Harness api={api} store={null} ownerId="owner-3" />)
    );
    await act(async () =>
      second.resolve({
        operation: "recovery_read",
        value: JSON.stringify({
          schemaVersion: 1,
          drafts: [
            {
              routeId: executionId,
              draft: savedDraft
            }
          ]
        })
      })
    );
    expect(lifecycle.drafts.size).toBe(0);
  });

  it("discards inspection and launch callbacks from a previous owner", async () => {
    const inspection =
      deferred<Awaited<ReturnType<ManagedConversationDesktopApi["inspect"]>>>();
    const api = {
      inspect: vi.fn(() => inspection.promise)
    } as unknown as ManagedConversationDesktopApi;
    const upsertThread = vi.fn();
    const store = { upsertThread } as unknown as PersonalMemoryStore;
    await act(async () =>
      root.render(<Harness api={api} store={store} ownerId="owner-1" />)
    );
    const previousStarted = lifecycle.started;
    await act(async () => {
      started();
    });
    expect(api.inspect).toHaveBeenCalledOnce();
    await act(async () =>
      root.render(<Harness api={api} store={store} ownerId="owner-2" />)
    );
    await act(async () => {
      inspection.resolve({
        operation: "inspect",
        status: "ready",
        executionId,
        conversation: { ...conversation, capturedSessionId: sessionId }
      });
      expect(
        previousStarted(project, conversation, "ready", launch, prompt)
      ).toBeNull();
    });
    expect(lifecycle.drafts.size).toBe(0);
    expect(upsertThread).not.toHaveBeenCalled();
  });

  it("adopts canonical identity and ignores an older execution update", async () => {
    const api = {
      inspect: vi.fn(async () => ({
        operation: "inspect",
        status: "starting",
        executionId
      }))
    } as unknown as ManagedConversationDesktopApi;
    await act(async () => root.render(<Harness api={api} store={null} />));
    await act(async () => {
      started();
    });
    const update = {
      type: "managed_conversation_upserted",
      execution: {
        id: executionId,
        executionGeneration: 2,
        stateVersion: 3,
        state: "running",
        sessionId,
        providerThreadId: "thread-1"
      },
      latestCommand: null
    } as unknown as ManagedConversationRealtimeUpdate;
    await act(async () =>
      root.render(
        <Harness api={api} store={null} update={{ revision: 1, update }} />
      )
    );
    expect(lifecycle.drafts.get(executionId)).toMatchObject({
      status: "ready",
      conversation: { capturedSessionId: sessionId, threadId: "thread-1" },
      initialPrompt: prompt
    });
    await act(async () =>
      root.render(
        <Harness
          api={api}
          store={null}
          update={{
            revision: 2,
            update: {
              ...update,
              execution: {
                ...update.execution,
                executionGeneration: 1,
                stateVersion: 9,
                state: "failed"
              }
            }
          }}
        />
      )
    );
    expect(lifecycle.drafts.get(executionId)?.status).toBe("ready");
  });

  it("retains the launch key when inspection fails without a confirmed terminal state", async () => {
    const api = {
      inspect: vi.fn(async () => {
        throw new Error("Network unavailable");
      }),
      start: vi.fn(async () => ({
        operation: "start",
        status: "ready",
        executionId,
        conversation: { ...conversation, capturedSessionId: sessionId }
      }))
    } as unknown as ManagedConversationDesktopApi;
    await act(async () => root.render(<Harness api={api} store={null} />));
    await act(async () => {
      started();
    });
    expect(lifecycle.drafts.get(executionId)?.status).toBe("failed");
    await act(async () => lifecycle.retry(executionId));
    expect(api.start).toHaveBeenCalledWith(launch);
    expect(lifecycle.drafts.get(executionId)?.initialPrompt).toEqual(prompt);
  });
  it("persists a new terminal retry key, adopts the new execution, and restores its stable route", async () => {
    vi.useFakeTimers();
    let saved = "";
    const replacementId = "44444444-4444-4444-8444-444444444444";
    const start =
      deferred<Awaited<ReturnType<ManagedConversationDesktopApi["start"]>>>();
    const api = {
      readRecovery: vi.fn(async () => ({
        operation: "recovery_read",
        value: saved
      })),
      writeRecovery: vi.fn(async (_owner: string, value: string) => {
        saved = value;
        return { operation: "recovery_write", ok: true };
      }),
      inspect: vi.fn(async (id: string) => ({
        operation: "inspect",
        executionId: id,
        status: id === executionId ? "failed" : "starting"
      })),
      start: vi.fn(() => {
        expect(saved).not.toContain("launch-original");
        return start.promise;
      })
    } as unknown as ManagedConversationDesktopApi;
    await act(async () =>
      root.render(<Harness api={api} store={null} ownerId="owner-1" />)
    );
    await act(async () => {
      started();
    });
    await act(async () => lifecycle.retry(executionId));
    const replacementKey = vi.mocked(api.start).mock.calls[0]?.[0]
      .idempotencyKey;
    expect(replacementKey).toBeTruthy();
    expect(replacementKey).not.toBe(launch.idempotencyKey);
    expect(saved).toContain(replacementKey!);
    expect(api.inspect).toHaveBeenCalledTimes(1);
    await act(async () =>
      start.resolve({
        operation: "start",
        status: "starting",
        executionId: replacementId
      })
    );
    expect(lifecycle.drafts.get(executionId)).toMatchObject({
      conversation: {
        executionId: replacementId,
        capturedSessionId: replacementId
      },
      launchInput: { idempotencyKey: replacementKey },
      status: "starting"
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () =>
      root.render(<Harness api={api} store={null} ownerId="owner-1" />)
    );
    expect(lifecycle.drafts.get(executionId)?.conversation.executionId).toBe(
      replacementId
    );
    expect(api.start).toHaveBeenCalledTimes(1);
  });

  it("reuses the replacement key after an uncertain terminal retry response", async () => {
    const api = {
      inspect: vi.fn(async () => ({
        operation: "inspect",
        status: "failed",
        executionId
      })),
      start: vi.fn(async () => {
        throw new Error("Response lost");
      })
    } as unknown as ManagedConversationDesktopApi;
    await act(async () => root.render(<Harness api={api} store={null} />));
    await act(async () => {
      started();
    });
    await act(async () => lifecycle.retry(executionId));
    await act(async () => lifecycle.retry(executionId));
    const calls = vi.mocked(api.start).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[0].idempotencyKey).not.toBe(launch.idempotencyKey);
    expect(calls[1]?.[0]).toEqual(calls[0]?.[0]);
    expect(api.inspect).toHaveBeenCalledOnce();
  });
  it.each(["lost_response", "reconciling"] as const)(
    "recovers a created execution and uncertain first prompt after %s without resending",
    async (outcome) => {
      vi.useFakeTimers();
      let saved = "";
      const api = {
        readRecovery: vi.fn(async () => ({
          operation: "recovery_read",
          value: saved
        })),
        writeRecovery: vi.fn(async (_owner: string, value: string) => {
          saved = value;
          return { operation: "recovery_write", ok: true };
        }),
        writeDraft: vi.fn(async () => ({ operation: "draft_write", ok: true })),
        start: vi.fn(async () => ({
          operation: "start",
          status: "starting",
          executionId
        })),
        inspect: vi.fn(async () => ({
          operation: "inspect",
          status: "starting",
          executionId
        })),
        send: vi.fn(async () => {
          if (outcome === "lost_response") throw new Error("Response lost");
          return {
            operation: "send",
            status: "reconciling",
            message: "Delivery is uncertain"
          };
        })
      } as unknown as ManagedConversationDesktopApi;
      function ComposerHarness() {
        lifecycle = useManagedConversationLifecycle({
          api,
          store: null,
          ownerId: "owner-1"
        });
        return lifecycle.drafts.size ? (
          <p>Recovered Conversation</p>
        ) : (
          <NewConversationComposer
            api={api}
            projectId={project.id}
            requirePrompt
            options={{
              runners: [],
              instances: [
                {
                  instanceId: "codex.default",
                  driverId: "codex",
                  displayName: "Codex",
                  ready: true,
                  readiness: "ready",
                  models: [{ id: "model", supportedReasoningEfforts: [] }],
                  capabilities: {
                    defaultPermissionMode: "supervised",
                    permissionModes: [
                      { mode: "supervised", support: "supported" }
                    ]
                  }
                }
              ]
            }}
            selection={{
              instanceId: "codex.default",
              model: "model",
              reasoningEffort: "",
              permissionMode: "supervised"
            }}
            onChange={() => undefined}
            onStarted={(identity, status, launchInput, initialPrompt) =>
              lifecycle.started(
                project,
                identity,
                status,
                launchInput,
                initialPrompt
              )
            }
          />
        );
      }
      await act(async () => root.render(<ComposerHarness />));
      const input = container.querySelector("textarea")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value"
        )!.set!.call(input, "Run this task once");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(
            '[aria-label="Start Conversation"]'
          )!
          .click()
      );
      const draft = lifecycle.drafts.get(executionId)!;
      expect(draft.initialPrompt).toMatchObject({
        status: "reconciling",
        prompt: "Run this task once"
      });
      expect(draft.launchInput).toEqual(
        vi.mocked(api.start).mock.calls[0]?.[0]
      );
      expect(draft.initialPrompt?.clientUserMessageId).toBe(
        vi.mocked(api.send).mock.calls[0]?.[0].clientUserMessageId
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });
      await act(async () => root.unmount());
      root = createRoot(container);
      await act(async () => root.render(<ComposerHarness />));
      expect(lifecycle.drafts.get(executionId)).toMatchObject({
        launchInput: draft.launchInput,
        initialPrompt: draft.initialPrompt
      });
      expect(api.start).toHaveBeenCalledOnce();
      expect(api.send).toHaveBeenCalledOnce();
    }
  );
});
