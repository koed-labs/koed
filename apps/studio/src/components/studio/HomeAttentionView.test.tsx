// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HomeItem } from "@koed/shared/home";
import { HomeAttentionView } from "./HomeAttentionView";

let container: HTMLDivElement;
let root: Root;
const onOpen = vi.fn();
const onSetCleared = vi.fn();
const item = (index: number): HomeItem => ({
  sourceEventId: `job:${index}`,
  source: "personal_agent_job",
  sourceId: `job-${index}`,
  sourceRevision: "1",
  kind: "job_review",
  state: "review",
  title: `Agent job ${index}`,
  summary: "Awaiting review",
  updatedAt: "2026-10-05T12:00:00Z",
  destination: { kind: "execution", executionId: `execution-${index}` }
});
async function render(items: HomeItem[]) {
  await act(async () =>
    root.render(
      <HomeAttentionView
        state="ready"
        snapshot={{
          generatedAt: "2026-10-05T12:00:00Z",
          coverage: [],
          needsYou: items,
          ongoing: [],
          recent: [item(99)],
          cleared: [],
          badgeCount: items.length
        }}
        refreshing={false}
        mutationError={null}
        pendingItemIds={new Set()}
        loadingSources={new Set()}
        canMutate
        onRefresh={vi.fn()}
        onOpen={onOpen}
        onSetCleared={onSetCleared}
        onLoadMore={vi.fn()}
      />
    )
  );
}
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  onOpen.mockClear();
  onSetCleared.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
it("keeps only the three requested sections and pages attention items without losing their actions", async () => {
  const items = Array.from({ length: 12 }, (_, index) => item(index + 1));
  await render(items);
  expect(container.textContent).toContain("Ongoing work");
  expect(container.textContent).toContain("Cleared");
  expect(container.textContent).not.toContain("Recent chats");
  expect(container.textContent).not.toContain("Agent job 99");
  expect(container.querySelectorAll("li")).toHaveLength(5);
  const next = () =>
    container.querySelector<HTMLButtonElement>(
      '[aria-label="Next Needs you items"]'
    )!;
  await act(async () => next().click());
  expect(container.textContent).toContain("6–10 of 12");
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Clear Agent job 6"]')!
      .click()
  );
  expect(onSetCleared).toHaveBeenCalledWith(items[5], true);
  await act(async () => next().click());
  expect(container.querySelectorAll("li")).toHaveLength(2);
  expect(next().disabled).toBe(true);
  await render(items.slice(0, 3));
  expect(container.querySelectorAll("li")).toHaveLength(3);
  expect(
    container.querySelector('[aria-label="Needs you pagination"]')
  ).toBeNull();
});
