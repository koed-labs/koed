// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  PersonalDesktopApi,
  RecallActivityDetail as Detail
} from "@koed-labs/shared/personal-desktop";
import { RecallActivityDetail } from "./RecallActivityDetail.js";

let root: Root;
let container: HTMLDivElement;
const originalAnimations = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "getAnimations"
);
beforeEach(() => {
  // happy-dom has no Web Animations API, which the shared ScrollArea uses.
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => []
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  if (originalAnimations)
    Object.defineProperty(
      Element.prototype,
      "getAnimations",
      originalAnimations
    );
  else delete (Element.prototype as Partial<Element>).getAnimations;
  vi.restoreAllMocks();
});

function fixture(query: string | null = "What did we decide?"): Detail {
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
  return {
    question: {
      id: "00000000-0000-4000-8000-000000000001",
      query,
      queryTruncated: false,
      recordedAt: "2026-11-16T09:42:12Z",
      updatedAt: "2026-11-16T09:42:12Z",
      metadata: {
        version: 1,
        memoryStatus: "found",
        caller: { name: "codex-mcp-client", version: "0.71.0" }
      },
      searchDomain: "global",
      status: "answered",
      projectId: null,
      projectName: null,
      sessionId: "9dbf2ad1-a815-4fbc-9195-1d11f12c3b7e",
      usage
    },
    answer: "The recorded answer.",
    memoryStatus: "found",
    worker: null,
    model: null,
    searchCount: 1,
    expandCount: 2,
    candidateCount: 3,
    failure: null,
    evidence: [],
    citations: [],
    contentTruncated: false,
    usage: {
      ...usage,
      provenance: "unavailable",
      truncated: false,
      ambiguous: false,
      attempts: []
    }
  };
}

const tab = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (element) => element.textContent === name
  )!;
const panel = () =>
  document.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')!;
const select = async (name: string) => act(async () => tab(name).click());
const copyButton = () =>
  panel().querySelector<HTMLButtonElement>('button[aria-label^="Copy "]')!;
async function render(
  detail: Detail,
  writeClipboard = vi.fn(async (_text: string) => {})
) {
  const api = {
    loadRecallActivity: vi.fn(async () => detail)
  } as unknown as PersonalDesktopApi;
  await act(async () =>
    root.render(
      <RecallActivityDetail
        api={api}
        projects={[]}
        questionId={detail.question.id}
        revision={detail.question.updatedAt}
        onClose={vi.fn()}
        adapters={{ openExternal: vi.fn(), writeClipboard }}
      />
    )
  );
  return { writeClipboard };
}

it("opens Answer and moves all four record fields into Caller details before the full question", async () => {
  const detail = fixture();
  await render(detail);
  expect(
    [...document.querySelectorAll('[role="tab"]')].map(
      (element) => element.textContent
    )
  ).toEqual(["Answer", "Recall details", "Caller details", "Provider usage"]);
  expect(tab("Answer").getAttribute("aria-selected")).toBe("true");
  expect(panel().textContent).toContain(detail.answer);
  await select("Recall details");
  expect(
    panel().querySelector('[aria-label="Recorded counts"]')
  ).not.toBeNull();
  expect(panel().querySelector("dl[aria-label='Caller metadata']")).toBeNull();
  expect(panel().textContent).not.toContain("Calling AI Client");
  expect(panel().textContent).not.toContain(detail.question.id);
  await select("Caller details");
  expect(
    [...panel().querySelectorAll("dt")].map((element) => element.textContent)
  ).toEqual(["Calling AI Client", "Conversation", "Record", "Recorded at"]);
  expect(
    [...panel().querySelectorAll("dd")].map((element) => element.textContent)
  ).toEqual([
    "codex-mcp-client · 0.71.0",
    detail.question.sessionId,
    detail.question.id,
    new Date(detail.question.recordedAt).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "medium"
    })
  ]);
  expect(panel().querySelector("time")?.dateTime).toBe(
    detail.question.recordedAt
  );
  const metadata = panel().querySelector("dl")!;
  const question = panel().querySelector("section")!;
  expect(
    metadata.compareDocumentPosition(question) &
      Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy();
});

it("caps only the header and preserves every character and paragraph in the displayed and copied question", async () => {
  const query =
    "  What prior decisions should guide this review?\n\n" +
    "Keep the original question and its paragraphs. ".repeat(100) +
    "\n\nThe final line.  ";
  const { writeClipboard } = await render(fixture(query));
  const title = document.querySelector(".recall-question-title")!;
  expect([...title.textContent!].length).toBeLessThanOrEqual(120);
  expect(title.textContent).toMatch(/…$/);
  expect(title.textContent).not.toContain("\n");
  // Scrolling a tab must not scroll the question header or the tab navigation.
  expect(title.closest('[data-slot="scroll-area-viewport"]')).toBeNull();
  expect(
    tab("Answer").closest('[data-slot="scroll-area-viewport"]')
  ).toBeNull();
  for (const name of [
    "Answer",
    "Recall details",
    "Provider usage",
    "Caller details"
  ]) {
    await select(name);
    expect(
      panel().querySelector('[data-slot="scroll-area-viewport"]')
    ).not.toBeNull();
  }
  expect(
    panel().querySelector(".recall-caller-question-text")?.textContent
  ).toBe(query);
  await act(async () => copyButton().click());
  expect(writeClipboard).toHaveBeenCalledExactlyOnceWith(query);
  expect(panel().querySelector('[role="status"]')?.textContent).toBe(
    "Question copied."
  );
});

it("reports a failed copy and allows the original question to be copied on retry", async () => {
  const writeClipboard = vi
    .fn(async (_text: string) => {})
    .mockRejectedValueOnce(new Error("Clipboard unavailable"));
  const detail = fixture();
  await render(detail, writeClipboard);
  await select("Caller details");
  await act(async () => copyButton().click());
  expect(panel().querySelector('[role="status"]')?.textContent).toBe(
    "Could not copy this question. Try again."
  );
  await act(async () => copyButton().click());
  expect(writeClipboard).toHaveBeenLastCalledWith(detail.question.query);
  expect(panel().querySelector('[role="status"]')?.textContent).toBe(
    "Question copied."
  );
});

it("keeps missing caller data and missing questions explicit without a copy action", async () => {
  const detail = fixture(null);
  detail.question.metadata = null;
  detail.question.sessionId = null;
  await render(detail);
  expect(document.querySelector(".recall-question-title")?.textContent).toBe(
    "Question unavailable"
  );
  await select("Caller details");
  expect(
    [...panel().querySelectorAll("dd")]
      .slice(0, 2)
      .map((element) => element.textContent)
  ).toEqual(["Unknown", "Not recorded"]);
  expect(
    panel().querySelector(".recall-caller-question-text")?.textContent
  ).toBe("Question unavailable");
  expect(copyButton()).toBeNull();
});

it("does not describe a truncated historical question as complete", async () => {
  const detail = fixture("Only this retained portion is available.");
  detail.question.queryTruncated = true;
  const { writeClipboard } = await render(detail);
  await select("Caller details");
  expect(panel().querySelector("h3")?.textContent).toBe("Recorded question");
  expect(panel().textContent).toContain(
    "Only the recorded portion of this question is available."
  );
  expect(copyButton().getAttribute("aria-label")).toBe(
    "Copy recorded question"
  );
  await act(async () => copyButton().click());
  expect(writeClipboard).toHaveBeenCalledExactlyOnceWith(detail.question.query);
});

it("replaces the full question and copy state when a different record is loaded", async () => {
  await render(fixture("First question"));
  await select("Caller details");
  await act(async () => copyButton().click());
  const next = fixture("Second question\n\nWith another paragraph.");
  next.question.id = "00000000-0000-4000-8000-000000000002";
  const { writeClipboard } = await render(next);
  expect(tab("Answer").getAttribute("aria-selected")).toBe("true");
  await select("Caller details");
  expect(panel().textContent).not.toContain("First question");
  expect(panel().querySelector('[role="status"]')).toBeNull();
  await act(async () => copyButton().click());
  expect(writeClipboard).toHaveBeenCalledExactlyOnceWith(next.question.query);
});
