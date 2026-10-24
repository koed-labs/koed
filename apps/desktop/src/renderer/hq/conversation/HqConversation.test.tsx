// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopProject } from "../../../project-memory-ui.js";
import type { DesktopApi } from "../../../types.js";
import type {
  ManagedConversationDesktopApi,
  ManagedConversationLaunchOptions
} from "../../../ipc/managed-conversation-protocol.js";
import type { ManagedProjectDesktopApi } from "../../../ipc/managed-project-protocol.js";
import type { ManagedConversationLifecycle } from "../../state/use-managed-conversation-lifecycle.js";
import { HqBlankConversation } from "./HqConversation.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const project = {
  id: "project-1",
  name: "Project",
  path: "/project",
  contextKind: "project",
  threads: []
} as unknown as DesktopProject;
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
};
const identity = {
  executionId: "execution-1",
  projectId: project.id,
  capturedSessionId: "execution-1",
  threadId: "execution-1",
  executionOwner: { driverId: "codex" as const, instanceId: "codex.default" }
};

describe("HQ blank Conversation", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  function setup(
    start: ManagedConversationDesktopApi["start"],
    managedProject: ManagedProjectDesktopApi | null = null,
    localAiClients?: DesktopApi["localAiClients"],
    initial?: { instanceId: string; draft: string }
  ) {
    const send = vi.fn<ManagedConversationDesktopApi["send"]>(
      async (input) => ({
        operation: "send",
        status: "queued",
        conversation: identity,
        idempotencyKey: input.idempotencyKey,
        clientUserMessageId: input.clientUserMessageId
      })
    );
    const writeDraft = vi.fn<ManagedConversationDesktopApi["writeDraft"]>(
      async () => ({ operation: "draft_write", ok: true })
    );
    const api = {
      launchOptions: vi.fn(async () => ({
        operation: "launch_options" as const,
        options
      })),
      start,
      send,
      writeDraft,
      deleteDraft: vi.fn(async () => ({ operation: "draft_delete", ok: true })),
      discoverCommands: vi.fn(async () => ({
        operation: "command_discovery",
        status: "ok",
        commands: []
      }))
    } as unknown as ManagedConversationDesktopApi;
    const started = vi.fn<ManagedConversationLifecycle["started"]>(
      () => "execution-1"
    );
    const persistPendingSend = vi.fn(async () => undefined);
    const lifecycle = {
      started,
      recoveryStatus: "ready",
      persistPendingSend,
      pendingSends: new Map()
    } as unknown as ManagedConversationLifecycle;
    const onStarted = vi.fn();
    const render = async () =>
      act(async () =>
        root.render(
          <HqBlankConversation
            api={api}
            localAiClients={localAiClients}
            projects={[project]}
            project={project}
            onProjectChange={vi.fn()}
            lifecycle={lifecycle}
            managedProject={managedProject}
            onStarted={onStarted}
            initialAiClientInstanceId={initial?.instanceId}
            initialDraft={initial?.draft}
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
      writeDraft,
      started,
      persistPendingSend,
      onStarted,
      render,
      enter
    };
  }

  it("blocks an unavailable requested AI until the user explicitly chooses another model", async () => {
    const start = vi.fn<ManagedConversationDesktopApi["start"]>(async () => ({
      operation: "start",
      status: "ready",
      executionId: "execution-1",
      conversation: identity
    }));
    const fixture = setup(start, null, undefined, {
      instanceId: "claude.unavailable",
      draft: "Carry this text"
    });
    fixture.api.launchOptions = vi.fn(async () => ({
      operation: "launch_options" as const,
      options: {
        ...options,
        instances: [
          {
            ...options.instances[0]!,
            models: [
              ...options.instances[0]!.models,
              {
                id: "model-b",
                isDefault: false,
                supportedReasoningEfforts: ["low", "high"]
              }
            ]
          }
        ]
      }
    }));
    await fixture.render();
    expect(container.querySelector("textarea")?.value).toBe("Carry this text");
    expect(container.textContent).toContain(
      "The requested AI Client is unavailable"
    );
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')
        ?.disabled
    ).toBe(true);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Send message"]')!
        .click()
    );
    expect(start).not.toHaveBeenCalled();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label^="Model and reasoning:"]'
        )!
        .click()
    );
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          '[aria-label="Choose AI Client and model"]'
        )!
        .click()
    );
    await act(async () =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
        .find((item) => item.textContent?.includes("model-b"))!
        .click()
    );
    expect(container.textContent).not.toContain(
      "The requested AI Client is unavailable"
    );
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')
        ?.disabled
    ).toBe(false);
  });

  it("queues a first prompt on an accepted starting execution with supervised permission", async () => {
    const start = vi.fn<ManagedConversationDesktopApi["start"]>(async () => ({
      operation: "start",
      status: "starting",
      executionId: "execution-1"
    }));
    const fixture = setup(start);
    await fixture.render();
    const line = container.querySelector(".hq-composer__visibility");
    expect(line?.textContent).toBe("Just me");
    expect(line?.nextElementSibling).toBe(
      container.querySelector("form.hq-composer")
    );
    await fixture.enter("Ship the fix");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Send message"]')!
        .click()
    );
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0]![0].permissionMode).toBe("supervised");
    expect(fixture.send).toHaveBeenCalledOnce();
    expect(fixture.persistPendingSend).toHaveBeenCalledWith(
      "execution-1",
      expect.objectContaining({
        request: expect.objectContaining({
          prompt: "Ship the fix",
          idempotencyKey: expect.stringMatching(/^desktop-prompt:/)
        })
      })
    );
    expect(fixture.persistPendingSend.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.send.mock.invocationCallOrder[0]!
    );
    expect(fixture.persistPendingSend).toHaveBeenCalledWith(
      "execution-1",
      null,
      expect.objectContaining({
        status: "queued",
        clientUserMessageId: fixture.send.mock.calls[0]![0].clientUserMessageId
      }),
      expect.objectContaining({
        clientUserMessageId: fixture.send.mock.calls[0]![0].clientUserMessageId
      })
    );
    expect(fixture.started.mock.calls[0]![1]).toEqual(identity);
    expect(fixture.onStarted).toHaveBeenCalledWith(
      "project-1",
      "execution-1",
      false
    );
  });

  it("does not send the first prompt when secure intent persistence fails", async () => {
    const start = vi.fn<ManagedConversationDesktopApi["start"]>(async () => ({
      operation: "start",
      status: "ready",
      executionId: "execution-1",
      conversation: identity
    }));
    const fixture = setup(start);
    fixture.persistPendingSend.mockRejectedValueOnce(
      new Error("secure store failed")
    );
    await fixture.render();
    await fixture.enter("Keep the first draft");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Send message"]')!
        .click()
    );
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.started.mock.calls.at(-1)![4]).toMatchObject({
      prompt: "Keep the first draft",
      status: "rejected",
      message: expect.stringContaining("Nothing was sent")
    });
  });

  it("keeps the exact launch key and draft locked after an uncertain start", async () => {
    const start = vi
      .fn<ManagedConversationDesktopApi["start"]>()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce({
        operation: "start",
        status: "ready",
        executionId: "execution-1",
        conversation: identity
      });
    const fixture = setup(start);
    await fixture.render();
    await fixture.enter("Original prompt");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Send message"]')!
        .click()
    );
    expect(container.querySelector("textarea")?.disabled).toBe(true);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".hq-conversation__retry")!
        .click()
    );
    expect(start.mock.calls[1]![0]).toEqual(start.mock.calls[0]![0]);
    expect(fixture.send).toHaveBeenCalledOnce();
    expect(fixture.send.mock.calls[0]![0].prompt).toBe("Original prompt");
  });

  it("starts a blank execution for attach while preserving the unsent message", async () => {
    const start = vi.fn<ManagedConversationDesktopApi["start"]>(async () => ({
      operation: "start",
      status: "ready",
      executionId: "execution-1",
      conversation: identity
    }));
    const fixture = setup(start, {
      command: vi.fn(),
      subscribe: vi.fn()
    } as unknown as ManagedProjectDesktopApi);
    await fixture.render();
    await fixture.enter("Read this file");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Attach a Project file"]'
        )!
        .click()
    );
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.writeDraft).toHaveBeenCalledWith({
      projectId: project.id,
      capturedSessionId: "execution-1",
      threadId: "execution-1",
      value: "Read this file"
    });
    expect(fixture.started.mock.calls[0]![4]).toMatchObject({
      prompt: "Read this file",
      status: "rejected"
    });
    expect(fixture.onStarted).toHaveBeenCalledWith(
      "project-1",
      "execution-1",
      true
    );
  });

  it("preserves attach intent and the unsent draft across uncertain start recovery", async () => {
    const start = vi
      .fn<ManagedConversationDesktopApi["start"]>()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce({
        operation: "start",
        status: "ready",
        executionId: "execution-1",
        conversation: identity
      });
    const fixture = setup(start, {
      command: vi.fn()
    } as unknown as ManagedProjectDesktopApi);
    await fixture.render();
    await fixture.enter("Read this file");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Attach a Project file"]'
        )!
        .click()
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".hq-conversation__retry")!
        .click()
    );
    expect(start.mock.calls[1]![0]).toEqual(start.mock.calls[0]![0]);
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.onStarted).toHaveBeenCalledWith(
      "project-1",
      "execution-1",
      true
    );
  });

  it("keeps an unavailable saved Conversations assignment gated until explicit selection", async () => {
    const start = vi.fn<ManagedConversationDesktopApi["start"]>();
    const localAiClients = {
      list: vi.fn(async () => ({
        readModel: {
          settings: [],
          capabilitySnapshots: [],
          defaults: {
            conversations: {
              assignment: {
                ai_client_instance_id: "missing.client",
                model: "missing-model",
                reasoning_effort: "high",
                provider: "openai",
                timeout_ms: 120_000,
                max_attempts: 2
              }
            }
          }
        }
      }))
    } as unknown as DesktopApi["localAiClients"];
    const fixture = setup(start, null, localAiClients);
    await fixture.render();
    await fixture.enter("Do not widen settings");
    expect(container.textContent).toContain(
      "saved Conversations AI Client or model is unavailable"
    );
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')
        ?.disabled
    ).toBe(true);
    expect(start).not.toHaveBeenCalled();
  });
});
