// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentThinkingIndicator } from "./AgentThinkingIndicator";
import type { AgentChatProgress } from "@/lib/agent-chat-progress";
let root: Root;
let container: HTMLDivElement;
const progress: AgentChatProgress = {
  key: "turn-1",
  state: "working",
  label: "Working on your request…",
  steps: [
    {
      id: "phase",
      title: "Reviewing the changes",
      detail: "Checking the modified files"
    }
  ]
};
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-05T12:00:00Z"));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});
it("shows a quiet live label, elapsed wait and visible reported phases", async () => {
  await act(async () =>
    root.render(<AgentThinkingIndicator progress={progress} />)
  );
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    progress.label
  );
  expect(container.querySelector("details")?.open).toBe(true);
  await act(async () => vi.advanceTimersByTime(4000));
  expect(container.textContent).toContain("4s");
  expect(container.querySelector('[role="status"]')?.textContent).not.toContain(
    "4s"
  );
  await act(async () =>
    root.render(
      <AgentThinkingIndicator progress={{ ...progress, key: "turn-2" }} />
    )
  );
  expect(container.textContent).not.toContain("4s");
});
it("stops animation and timers while waiting for the user, and cleans up on unmount", async () => {
  await act(async () =>
    root.render(<AgentThinkingIndicator progress={progress} />)
  );
  expect(vi.getTimerCount()).toBe(1);
  await act(async () =>
    root.render(
      <AgentThinkingIndicator
        progress={{
          ...progress,
          state: "waiting",
          label: "Waiting for your input"
        }}
      />
    )
  );
  expect(vi.getTimerCount()).toBe(0);
  expect(container.querySelector(".motion-safe\\:animate-pulse")).toBeNull();
  await act(async () =>
    root.render(<AgentThinkingIndicator progress={progress} />)
  );
  await act(async () => root.render(null));
  expect(vi.getTimerCount()).toBe(0);
});

it("retains activity collapsed when the turn completes and stops the timer", async () => {
  await act(async () =>
    root.render(<AgentThinkingIndicator progress={progress} />)
  );
  expect(container.querySelector("details")?.open).toBe(true);
  await act(async () =>
    root.render(
      <AgentThinkingIndicator progress={{ ...progress, state: "completed" }} />
    )
  );
  expect(container.querySelector("details")?.open).toBe(false);
  expect(container.textContent).toContain("Checking the modified files");
  expect(container.textContent).toContain("Agent activity · 1 updates");
  expect(vi.getTimerCount()).toBe(0);
  expect(container.querySelector('[role="status"]')).toBeNull();
});
