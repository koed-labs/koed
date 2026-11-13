// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  PersonalDesktopApi,
  RecallActivityPage as RecallPageResult,
  RecallActivityListInput,
  RecallActivityOverview
} from "@koed-labs/shared/personal-desktop";
import { RecallActivityPage } from "./RecallActivityPage.js";
import { useRecallActivity } from "./use-recall-activity.js";

let root: Root | undefined;
let container: HTMLDivElement;
const originalAnimations = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "getAnimations"
);
beforeEach(() => {
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => []
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  if (originalAnimations)
    Object.defineProperty(
      Element.prototype,
      "getAnimations",
      originalAnimations
    );
  else delete (Element.prototype as Partial<Element>).getAnimations;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const fixture = () => {
  const usage = {
    coverage: "unavailable" as const,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    totalTokens: null,
    recordedAttempts: 0,
    includesEstimates: false
  };
  const overview: RecallActivityOverview = {
    asOf: new Date().toISOString(),
    timezone: "UTC",
    bucket: "day",
    tokens: usage,
    linkedQuestions: 0,
    tokenTimeline: [],
    recordedQuestions: 2,
    recordedErrors: 0,
    memoryResults: {
      found: 0,
      not_found: 0,
      insufficient: 0,
      pending_summary: 0,
      unknown: 2,
      foundPercentage: null
    },
    knownDurations: 0,
    medianDurationMs: null,
    questions: [],
    filterOptions: {
      projects: [
        { projectId: "project-a", projectName: "Project A" },
        { projectId: "project-b", projectName: "Project B" }
      ],
      callerNames: ["codex", "pi"]
    }
  };
  const list = vi.fn(
    async (_input: RecallActivityListInput): Promise<RecallPageResult> => ({
      questions: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          recordedAt: overview.asOf,
          updatedAt: overview.asOf,
          query: "Question A",
          queryTruncated: true,
          usage,
          metadata: {
            version: 1 as const,
            memoryStatus: null,
            caller: { name: "codex", version: null }
          },
          searchDomain: "global" as const,
          status: "answered" as const,
          projectId: "project-a",
          projectName: "Project A",
          sessionId: null
        }
      ],
      nextCursor: null,
      asOf: overview.asOf
    })
  );
  const api = {
    listRecallActivity: list,
    recallActivityOverview: vi.fn(async () => overview),
    subscribe: () => () => {}
  } as unknown as PersonalDesktopApi;
  return { list, api };
};
const render = async (api: PersonalDesktopApi) =>
  act(async () =>
    root!.render(
      <RecallActivityPage
        api={api}
        adapters={{ openExternal: vi.fn(), writeClipboard: vi.fn() }}
      />
    )
  );
const click = async (label: string) =>
  act(async () =>
    container
      .querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
      .click()
  );
const choose = async (label: string, option: string) => {
  await click(label);
  const element = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]')
  ].find((row) => row.textContent?.trim() === option);
  expect(element, option).toBeTruthy();
  await act(async () => element!.click());
};

it("offers projects and callers outside the loaded page and retains them after selection", async () => {
  const { api, list } = fixture();
  await render(api);
  expect(
    container.querySelector(".recall-question-link")?.getAttribute("title")
  ).toBe("Question shortened for display");
  await click("Filters");
  await choose("Recorded Project", "Project B");
  await choose("Calling AI Client", "pi");
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  );
  expect(list.mock.calls.at(-1)![0]).toMatchObject({
    projectId: "project-b",
    callerName: "pi"
  });
  await click("Filters");
  await choose("Recorded Project", "Project A");
  await choose("Calling AI Client", "Codex");
});

it("moves Today at midnight and catches up after sleep without changing custom dates", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 12, 23, 59, 59));
  const { api, list } = fixture();
  await render(api);
  await choose("Date range", "Today");
  const initial = list.mock.calls.at(-1)![0];
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  const next = list.mock.calls.at(-1)![0];
  expect(next.from).toBe(initial.to);
  expect(new Date(next.from).getDate()).toBe(13);
  vi.setSystemTime(new Date(2026, 10, 16, 9));
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(new Date(list.mock.calls.at(-1)![0].from).getDate()).toBe(16);
  await choose("Date range", "Custom range");
  const fixed = list.mock.calls.at(-1)![0];
  await act(async () => vi.advanceTimersByTimeAsync(24 * 3_600_000));
  expect(list.mock.calls.at(-1)![0].from).toBe(fixed.from);
  expect(list.mock.calls.at(-1)![0].to).toBe(fixed.to);
});

it("recomputes a preset on manual refresh even before a delayed rollover timer runs", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 12, 20));
  const { api, list } = fixture();
  await render(api);
  const initial = list.mock.calls.at(-1)![0];
  vi.setSystemTime(new Date(2026, 10, 13, 9));
  await click("Refresh activity");
  expect(list.mock.calls.at(-1)![0].from).not.toBe(initial.from);
  expect(new Date(list.mock.calls.at(-1)![0].to).getDate()).toBe(14);
});

it("retains the shortened-question flag when refresh reuses hydrated text", async () => {
  const { api, list } = fixture();
  const input = {
    from: "2026-11-01T00:00:00Z",
    to: "2026-12-01T00:00:00Z",
    limit: 50
  };
  const initial = await list(input);
  list.mockClear();
  list.mockImplementation(async (request) => ({
    ...initial,
    questions: initial.questions.map((row) => ({
      ...row,
      query: request.hydrate === false ? null : row.query,
      queryTruncated: request.hydrate === false ? undefined : true
    }))
  }));
  let view!: ReturnType<typeof useRecallActivity>;
  function View() {
    view = useRecallActivity(api, input, "UTC");
    return null;
  }
  await act(async () => root!.render(<View />));
  expect(view.page?.questions[0]?.queryTruncated).toBe(true);
  await act(async () => view.refresh());
  expect(list).toHaveBeenCalledTimes(2);
  expect(list.mock.calls[1]![0].hydrate).toBe(false);
  expect(view.page?.questions[0]?.query).toBe("Question A");
  expect(view.page?.questions[0]?.queryTruncated).toBe(true);
});
