// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewConversationComposer } from "./NewConversationComposer.js";
import type {
  ManagedConversationDesktopApi,
  ManagedConversationLaunchOptions
} from "../../../ipc/managed-conversation-protocol.js";

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
      models: [{ id: "model", supportedReasoningEfforts: [] }],
      capabilities: {
        defaultPermissionMode: "supervised",
        permissionModes: [{ mode: "supervised", support: "supported" }]
      }
    }
  ]
};
const conversation = {
  executionId: "execution-1",
  projectId: "project-1",
  capturedSessionId: "execution-1",
  threadId: "execution-1"
};

describe("first Conversation prompt retries", () => {
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
    vi.restoreAllMocks();
  });

  it.each([false, true])(
    "keeps the scoped Skill through a model change and checks expiry at submission (expired: %s)",
    async (expired) => {
      const skill = {
        resourceId: `res_${"a".repeat(64)}`,
        kind: "skill",
        name: "review",
        status: "ready",
        source: "user",
        invocation: "native_skill",
        availability: "available",
        executionSupport: "koed_managed"
      };
      const resources = vi.fn(async () => ({
        operation: "resources",
        catalog: {
          version: 1,
          provider: "codex",
          aiClientInstanceId: "codex.default",
          hostedInstanceId: "codex.default",
          computerLabel: null,
          projectId: "project-1",
          observedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          resources: [skill]
        }
      }));
      const send = vi.fn(
        async (
          input: Parameters<ManagedConversationDesktopApi["send"]>[0]
        ) => ({
          operation: "send",
          status: "queued",
          conversation,
          idempotencyKey: input.idempotencyKey,
          clientUserMessageId: input.clientUserMessageId
        })
      );
      const start = vi.fn(async () => ({
        operation: "start",
        status: "starting",
        executionId: "execution-1",
        conversation
      }));
      const api = {
        resources,
        send,
        start,
        writeDraft: vi.fn(async () => ({ operation: "draft_write", ok: true })),
        deleteDraft: vi.fn(async () => ({
          operation: "draft_delete",
          ok: true
        }))
      } as unknown as ManagedConversationDesktopApi;
      function Harness() {
        const [model, setModel] = useState("model");
        return (
          <>
            <button onClick={() => setModel("model-2")}>Change model</button>
            <NewConversationComposer
              api={api}
              projectId="project-1"
              options={{
                ...options,
                instances: [
                  {
                    ...options.instances[0]!,
                    models: [
                      { id: "model", supportedReasoningEfforts: [] },
                      { id: "model-2", supportedReasoningEfforts: [] }
                    ]
                  }
                ]
              }}
              selection={{
                instanceId: "codex.default",
                model,
                reasoningEffort: "",
                permissionMode: "supervised"
              }}
              onChange={() => undefined}
              onStarted={() => undefined}
              requirePrompt
            />
          </>
        );
      }
      await act(async () => root.render(<Harness />));
      const textarea = container.querySelector("textarea")!;
      const enter = async (value: string) =>
        act(async () => {
          Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            "value"
          )!.set!.call(textarea, value);
          textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
        });
      await enter("/review");
      expect(resources).toHaveBeenCalledWith({
        aiClientInstanceId: "codex.default",
        projectId: "project-1"
      });
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[role="option"]')!.click()
      );
      await act(async () =>
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent === "Change model")!
          .click()
      );
      expect(
        container.querySelector('[aria-label="Selected Skills"]')?.textContent
      ).toContain("review");
      await enter("Check the files");
      if (expired) vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
      await act(async () =>
        container
          .querySelector("form")!
          .dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true })
          )
      );
      if (expired) {
        expect(start).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
        expect(container.textContent).toContain("Skill choices expired");
        return;
      }
      expect(start).toHaveBeenCalledWith(
        expect.objectContaining({ model: "model-2" })
      );
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "Check the files",
          selectedResourceIds: [skill.resourceId],
          selectedResourceHostedInstanceId: "codex.default"
        })
      );
    }
  );

  it("discards choices after Project navigation, including returning to the original Project", async () => {
    const resources = vi.fn(async () => ({
      operation: "resources",
      catalog: {
        version: 1,
        provider: "codex",
        aiClientInstanceId: "codex.default",
        hostedInstanceId: "codex.default",
        computerLabel: null,
        projectId: "project-1",
        observedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        resources: [
          {
            resourceId: `res_${"a".repeat(64)}`,
            kind: "skill",
            name: "review",
            status: "ready",
            source: "user",
            invocation: "native_skill",
            availability: "available",
            executionSupport: "koed_managed"
          }
        ]
      }
    }));
    const api = { resources } as unknown as ManagedConversationDesktopApi;
    function Harness() {
      const [project, setProject] = useState("project-1");
      return (
        <>
          <button
            onClick={() =>
              setProject((current) =>
                current === "project-1" ? "project-2" : "project-1"
              )
            }
          >
            Switch Project
          </button>
          <NewConversationComposer
            api={api}
            projectId={project}
            options={options}
            selection={{
              instanceId: "codex.default",
              model: "model",
              reasoningEffort: "",
              permissionMode: "supervised"
            }}
            onChange={() => undefined}
            onStarted={() => undefined}
          />
        </>
      );
    }
    await act(async () => root.render(<Harness />));
    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )!.set!.call(textarea, "/review");
      textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
    });
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[role="option"]')!.click()
    );
    expect(
      container.querySelector('[aria-label="Selected Skills"]')
    ).not.toBeNull();
    for (let step = 0; step < 2; step++)
      await act(async () =>
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent === "Switch Project")!
          .click()
      );
    expect(
      container.querySelector('[aria-label="Selected Skills"]')
    ).toBeNull();
  });

  it.each(["rejected", "uncertain"] as const)(
    "keeps the launch stable after a %s prompt response",
    async (outcome) => {
      const start = vi.fn<ManagedConversationDesktopApi["start"]>(async () => ({
        operation: "start",
        status: "starting",
        executionId: "execution-1",
        conversation
      }));
      const send = vi
        .fn<ManagedConversationDesktopApi["send"]>()
        .mockImplementationOnce(async (input) => {
          if (outcome === "uncertain") throw new Error("response lost");
          return {
            operation: "send",
            status: "rejected",
            conversation,
            idempotencyKey: input.idempotencyKey,
            clientUserMessageId: input.clientUserMessageId
          };
        })
        .mockImplementation(async (input) => ({
          operation: "send",
          status: "queued",
          conversation,
          idempotencyKey: input.idempotencyKey,
          clientUserMessageId: input.clientUserMessageId
        }));
      const writeDraft = vi.fn(async () => ({
        operation: "draft_write" as const,
        ok: true as const
      }));
      const api = {
        start,
        send,
        writeDraft,
        deleteDraft: vi.fn(async () => ({
          operation: "draft_delete",
          ok: true
        }))
      } as unknown as ManagedConversationDesktopApi;
      const onStarted = vi.fn();
      await act(async () =>
        root.render(
          <NewConversationComposer
            api={api}
            options={options}
            projectId="project-1"
            selection={{
              instanceId: "codex.default",
              model: "model",
              reasoningEffort: "",
              permissionMode: "supervised"
            }}
            onChange={vi.fn()}
            onStarted={onStarted}
            requirePrompt
          />
        )
      );
      const textarea = container.querySelector("textarea")!;
      const enter = async (text: string) =>
        act(async () => {
          Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            "value"
          )!.set!.call(textarea, text);
          textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
        });
      const submit = async () =>
        act(async () =>
          container
            .querySelector<HTMLButtonElement>(
              '[aria-label="Start Conversation"]'
            )!
            .click()
        );
      await enter("Original prompt");
      await submit();
      expect(send).toHaveBeenCalledOnce();
      expect(onStarted).toHaveBeenCalledOnce();
      expect(onStarted).toHaveBeenLastCalledWith(
        conversation,
        "starting",
        start.mock.calls[0]![0],
        expect.objectContaining({
          prompt: "Original prompt",
          clientUserMessageId: send.mock.calls[0]![0].clientUserMessageId,
          status: outcome === "uncertain" ? "reconciling" : "rejected"
        })
      );
      expect(textarea.disabled).toBe(outcome === "uncertain");
      if (outcome === "rejected") await enter("Edited prompt");
      await submit();
      expect(start.mock.calls[1]![0]).toEqual(start.mock.calls[0]![0]);
      const first = send.mock.calls[0]![0];
      const retry = send.mock.calls[1]![0];
      expect(onStarted.mock.calls[0]![3].status).toBe(
        outcome === "uncertain" ? "reconciling" : "rejected"
      );
      if (outcome === "uncertain") expect(retry).toEqual(first);
      else {
        expect(retry.prompt).toBe("Edited prompt");
        expect(retry.clientUserMessageId).not.toBe(first.clientUserMessageId);
        expect(retry.idempotencyKey).not.toBe(first.idempotencyKey);
      }
      expect(onStarted).toHaveBeenCalledWith(
        conversation,
        "starting",
        start.mock.calls[0]![0],
        expect.objectContaining({
          prompt: retry.prompt,
          clientUserMessageId: retry.clientUserMessageId,
          status: "queued"
        })
      );
      expect(writeDraft).toHaveBeenLastCalledWith(
        expect.objectContaining({ value: retry.prompt })
      );
    }
  );

  it("keeps local launch selection while scoping standalone drafts to the null Project identity", async () => {
    const standaloneConversation = {
      executionId: "execution-independent",
      projectId: null,
      capturedSessionId: "session-independent",
      threadId: "thread-independent",
      executionOwner: {
        driverId: "codex" as const,
        instanceId: "codex.default"
      }
    };
    const start = vi.fn<ManagedConversationDesktopApi["start"]>(async () => ({
      operation: "start",
      status: "ready",
      executionId: standaloneConversation.executionId,
      conversation: standaloneConversation
    }));
    const send = vi.fn<ManagedConversationDesktopApi["send"]>(
      async (input) => ({
        operation: "send",
        status: "queued",
        conversation: standaloneConversation,
        idempotencyKey: input.idempotencyKey,
        clientUserMessageId: input.clientUserMessageId
      })
    );
    const writeDraft = vi.fn(async () => ({
      operation: "draft_write" as const,
      ok: true as const
    }));
    const api = {
      start,
      send,
      writeDraft,
      deleteDraft: vi.fn(async () => ({ operation: "draft_delete", ok: true }))
    } as unknown as ManagedConversationDesktopApi;
    const onStarted = vi.fn();

    await act(async () =>
      root.render(
        <NewConversationComposer
          api={api}
          contextKind="independent"
          options={options}
          projectId="local-chats-project"
          selection={{
            instanceId: "codex.default",
            model: "model",
            reasoningEffort: "",
            permissionMode: "supervised"
          }}
          onChange={vi.fn()}
          onStarted={onStarted}
          requirePrompt
        />
      )
    );
    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )!.set!.call(textarea, "A standalone first prompt.");
      textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
    });
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Start Conversation"]')!
        .click()
    );

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "local-chats-project",
        contextKind: "independent"
      })
    );
    expect(writeDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: null,
        capturedSessionId: standaloneConversation.executionId,
        threadId: standaloneConversation.executionId,
        value: "A standalone first prompt."
      })
    );
    expect(onStarted).toHaveBeenCalledWith(
      standaloneConversation,
      "ready",
      start.mock.calls[0]![0],
      expect.objectContaining({ status: "queued" })
    );
  });
});
