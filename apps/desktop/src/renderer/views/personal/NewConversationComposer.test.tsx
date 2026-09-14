// @vitest-environment happy-dom
import { act } from "react";
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
});
