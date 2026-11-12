// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type {
  PersonalDesktopApi,
  RecallActivityQuestion,
  RecallActivityOverview,
  RecallActivityListInput
} from "@koed-labs/shared/personal-desktop";
import { RecallActivityPage } from "./RecallActivityPage.js";

it("keeps overview totals independent of pagination and page-only search, and applies server filters before pagination", async () => {
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
  const row = (id: number, query: string): RecallActivityQuestion => ({
    id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    query,
    recordedAt: "2026-11-11T10:00:00Z",
    updatedAt: "2026-11-11T10:00:00Z",
    metadata: null,
    searchDomain: "global",
    status: "answered",
    projectId: null,
    projectName: null,
    sessionId: null,
    usage
  });
  const first = row(1, "Navigation decision"),
    second = row(2, "Onboarding decision"),
    older = row(3, "Earlier decision");
  first.projectId =
    'repository:{"kind":"portable_repository","key":"gr_test","device":null}';
  first.projectName = "koed";
  const cursor = { id: second.id, recordedAt: second.recordedAt };
  const overview: RecallActivityOverview = {
    asOf: first.recordedAt,
    timezone: "UTC",
    bucket: "day",
    recordedQuestions: 120,
    recordedErrors: 2,
    linkedQuestions: 0,
    tokens: usage,
    tokenTimeline: [],
    memoryResults: {
      found: 60,
      not_found: 20,
      insufficient: 10,
      pending_summary: 10,
      unknown: 20,
      foundPercentage: 75
    },
    knownDurations: 0,
    medianDurationMs: null,
    questions: [
      {
        start: "2026-11-11T00:00:00Z",
        count: 120,
        errors: 2,
        found: 60,
        notFound: 20,
        insufficient: 10,
        pendingSummary: 10,
        unknown: 20
      }
    ]
  };
  const list = vi.fn(async (input: RecallActivityListInput) => ({
    questions: input.cursor ? [older] : [first, second],
    nextCursor: input.cursor ? null : cursor,
    asOf: first.recordedAt
  }));
  const stats = vi.fn(async () => overview);
  const api = {
    listRecallActivity: list,
    recallActivityOverview: stats,
    subscribe: () => () => {}
  } as unknown as PersonalDesktopApi;
  // happy-dom does not implement the Web Animations API used by ScrollArea.
  const animations = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "getAnimations"
  );
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => []
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (name: string) =>
    [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === name
    )!;
  const setInput = async (input: HTMLInputElement, value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  try {
    await act(async () =>
      root.render(
        <RecallActivityPage
          api={api}
          adapters={{ openExternal: vi.fn(), writeClipboard: vi.fn() }}
        />
      )
    );
    expect(container.querySelector(".recall-stat strong")?.textContent).toBe(
      "118"
    );
    expect(
      container.querySelector(".recall-bar-group")?.getAttribute("aria-label")
    ).toContain("60 found, 58 other outcomes, 2 errors");
    expect(container.querySelector(".recall-table")?.textContent).toContain(
      "Unknown"
    );
    await act(async () => button("Older").click());
    expect(list.mock.calls.at(-1)?.[0].cursor).toEqual(cursor);
    expect(
      container.querySelector(".recall-question-link")?.textContent
    ).toContain("Earlier decision");
    expect(container.querySelector(".recall-stat strong")?.textContent).toBe(
      "118"
    );
    expect(stats).toHaveBeenCalledTimes(1);
    const requests = list.mock.calls.length;
    await setInput(
      container.querySelector(
        'input[aria-label="Search questions on this page"]'
      )!,
      "missing question"
    );
    expect(container.textContent).toContain(
      "No questions on this page match your search"
    );
    expect(container.querySelector(".recall-stat strong")?.textContent).toBe(
      "118"
    );
    expect(list).toHaveBeenCalledTimes(requests);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Filters"]')!
        .click()
    );
    const min = [...container.querySelectorAll("label")]
      .find((label) => label.textContent?.startsWith("Minimum duration"))!
      .querySelector("input")!;
    await setInput(min, "2.5");
    await act(async () =>
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    );
    expect(list.mock.calls.at(-1)?.[0]).toMatchObject({ minDurationMs: 2500 });
    expect(list.mock.calls.at(-1)?.[0].cursor).toBeUndefined();
    expect(stats).toHaveBeenCalledTimes(2);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Filters"]')!
        .click()
    );
    const form = container.querySelector("form")!;
    expect(form.querySelector('input[type="checkbox"]')).toBeNull();
    expect(
      form.querySelector('input[placeholder="All Conversations"]')
    ).toBeNull();
    const choose = async (label: string, option: string) => {
      await act(async () =>
        form
          .querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
          .click()
      );
      const choice = [
        ...document.querySelectorAll<HTMLElement>('[role="option"]')
      ].find((element) => element.textContent?.trim() === option)!;
      await act(async () => choice.click());
    };
    await choose("Recorded Project", "koed");
    await choose("Calling AI Client", "Unknown AI Client");
    await choose("Memory outcome", "Memory found");
    await act(async () =>
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      )
    );
    expect(list.mock.calls.at(-1)?.[0]).toMatchObject({
      projectId: first.projectId,
      callerName: "",
      status: "answered",
      memoryStatus: "found",
      minDurationMs: 2500
    });
    expect(stats).toHaveBeenCalledTimes(3);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    if (animations)
      Object.defineProperty(Element.prototype, "getAnimations", animations);
    else delete (Element.prototype as Partial<Element>).getAnimations;
  }
});
