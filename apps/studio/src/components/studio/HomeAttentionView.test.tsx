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
const onLoadMore = vi.fn();
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
async function render(
  items: HomeItem[],
  coverage: Array<{
    source: HomeItem["source"];
    complete: boolean;
    nextCursor: string | null;
  }> = [],
  recent: HomeItem[] = [item(99)],
  ongoing: HomeItem[] = []
) {
  await act(async () =>
    root.render(
      <HomeAttentionView
        state="ready"
        snapshot={{
          generatedAt: "2026-10-05T12:00:00Z",
          coverage,
          needsYou: items,
          ongoing,
          recent,
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
        onLoadMore={onLoadMore}
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
  onLoadMore.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("shows native Agent attribution and authoritative state, with native paging", async () => {
  const nativeItem = {
    sourceEventId: "delivery:123e4567-e89b-42d3-a456-426614174333",
    source: "native_agent_activity",
    sourceId: "123e4567-e89b-42d3-a456-426614174333",
    sourceRevision: "n0123456789abcdef",
    kind: "agent_work",
    state: "blocked",
    title: "Ada · Reconcile the failed delivery",
    summary: "Failed on Codex",
    updatedAt: "2026-10-05T12:00:00Z",
    destination: {
      kind: "execution",
      executionId: "123e4567-e89b-42d3-a456-426614174444"
    }
  } as const satisfies HomeItem;
  await render(
    [nativeItem],
    [
      {
        source: "native_agent_activity",
        complete: false,
        nextCursor: "agent-cursor"
      }
    ]
  );

  expect(container.textContent).toContain(
    "Ada · Reconcile the failed delivery"
  );
  expect(container.textContent).toContain("Agent work");
  expect(container.textContent).toContain("Blocked");
  await act(async () =>
    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find(
        (button) => button.textContent?.trim() === "Load more Agent activity"
      )!
      .click()
  );
  expect(onLoadMore).toHaveBeenCalledWith("native_agent_activity");
});

it("shows completed native Agent activity in the existing Ongoing section", async () => {
  const completed: HomeItem = {
    sourceEventId: "delivery:completed-1",
    source: "native_agent_activity",
    sourceId: "completed-1",
    sourceRevision: "n0123456789abcdef",
    kind: "agent_work",
    state: "recent",
    title: "Ada · Finished the plan",
    summary: "Completed on Codex",
    updatedAt: "2026-10-05T12:00:00Z",
    destination: {
      kind: "execution",
      executionId: "123e4567-e89b-42d3-a456-426614174444"
    }
  };
  await render([], [], [completed]);

  expect(container.textContent).toContain("Ongoing work");
  expect(container.textContent).toContain("Ada · Finished the plan");
  expect(container.textContent).toContain("Recent");
  expect(container.textContent).not.toContain("Recent chats");
  expect(container.querySelectorAll("li")).toHaveLength(1);
  await act(async () =>
    container.querySelector<HTMLButtonElement>("li button")!.click()
  );
  expect(onOpen).toHaveBeenCalledWith(completed);
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
