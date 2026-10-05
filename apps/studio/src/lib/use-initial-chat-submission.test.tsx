// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import {
  useInitialChatSubmission,
  type InitialChatSubmission
} from "./use-initial-chat-submission";
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const submission: InitialChatSubmission = {
  id: "home-click",
  text: "What changed?",
  selection: {
    agentId: "agent",
    provider: "codex",
    model: "model-b",
    effort: "high",
    permissionMode: "read",
    instanceId: "chosen-client"
  }
};
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
});
async function render(
  ready: boolean,
  send: (
    text: string,
    selection: InitialChatSubmission["selection"]
  ) => Promise<unknown>,
  initial = submission
) {
  await act(async () =>
    root.render(
      <StrictMode>
        <HarnessHook ready={ready} send={send} submission={initial} />
      </StrictMode>
    )
  );
}
function HarnessHook(props: Parameters<typeof useInitialChatSubmission>[0]) {
  useInitialChatSubmission(props);
  return null;
}
it("waits for verified readiness then sends the Home question with its selected settings once", async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const send = vi.fn().mockResolvedValue(undefined);
  await render(false, send);
  expect(send).not.toHaveBeenCalled();
  await render(true, send);
  await render(true, send);
  expect(send).toHaveBeenCalledExactlyOnceWith(
    submission.text,
    submission.selection
  );
});
it("does not submit ordinary draft navigation", async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const send = vi.fn().mockResolvedValue(undefined);
  await act(async () => root.render(<HarnessHook ready send={send} />));
  expect(send).not.toHaveBeenCalled();
});
it("does not automatically retry a failed submission on rerender", async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const send = vi.fn().mockRejectedValue(new Error("offline"));
  await render(true, send);
  await render(false, send);
  await render(true, send);
  expect(send).toHaveBeenCalledOnce();
});
it("allows a new explicit Home submission while retaining once-only semantics", async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const send = vi.fn().mockResolvedValue(undefined);
  await render(true, send);
  await render(true, send, {
    ...submission,
    id: "next-click",
    text: "Next question"
  });
  expect(send).toHaveBeenCalledTimes(2);
  expect(send).toHaveBeenLastCalledWith("Next question", submission.selection);
});

it("does not repeat a claimed Home submission when route changes remount the chat", async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const ids = new Set<string>();
  const claim = (id: string) => {
    if (ids.has(id)) return false;
    ids.add(id);
    return true;
  };
  const send = vi.fn().mockResolvedValue(undefined);
  await act(async () =>
    root.render(
      <HarnessHook
        key="first"
        ready
        send={send}
        submission={submission}
        claim={claim}
      />
    )
  );
  await act(async () =>
    root.render(
      <HarnessHook
        key="second"
        ready
        send={send}
        submission={submission}
        claim={claim}
      />
    )
  );
  expect(send).toHaveBeenCalledOnce();
});
