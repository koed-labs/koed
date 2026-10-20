// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CuratedAssertion,
  CuratedMemoryDesktopApi
} from "../../../ipc/curated-memory-protocol.js";
import { HqLearnedToday, localTodayStart } from "./HqLearnedToday.js";

const owner = "00000000-0000-4000-8000-000000000101";
const project = "00000000-0000-4000-8000-000000000102";
const item = (text: string, id: string): CuratedAssertion => ({
  id,
  ownerUserId: owner,
  scope: "project",
  projectId: project,
  kind: "learning",
  authorKind: "user",
  authorRef: owner,
  visibility: "personal",
  classificationVersion: 1,
  assertionText: text,
  status: "current",
  createdAt: new Date().toISOString(),
  observedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  suppressionToken: null,
  sources: [],
  replaces: []
});
const first = item(
  "Use a smaller launch",
  "00000000-0000-4000-8000-000000000103"
);
const second = item("Ask users first", "00000000-0000-4000-8000-000000000104");
const cursor = { updatedAt: first.updatedAt, id: first.id };

describe("HQ Learned today", () => {
  let node: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    node.remove();
  });
  it("uses the viewer's midnight even across a DST offset change", () => {
    const now = new Date(2026, 9, 25, 15);
    expect(localTodayStart(now)).toBe(new Date(2026, 9, 25).toISOString());
  });
  it("pages all today assertions, expands, and undoes the exact Forget receipt", async () => {
    const page = vi.fn(
      async (
        _scope: string,
        _project?: string,
        next?: unknown,
        since?: string
      ) => {
        expect(since).toBe(localTodayStart());
        return next
          ? { assertions: [second], nextCursor: null }
          : { assertions: [first], nextCursor: cursor };
      }
    );
    const forget = vi.fn(async (id: string) => ({
      ...first,
      id,
      status: "suppressed",
      suppressionToken: "12345"
    }));
    const undo = vi.fn(async (id: string) => ({ ...first, id }));
    const api = { page, forget, undo } as unknown as CuratedMemoryDesktopApi;
    await act(async () =>
      root.render(
        <HqLearnedToday api={api} projectId={project} ownerId={owner} />
      )
    );
    expect(node.textContent).toContain("Learned 2 things today");
    expect(page).toHaveBeenCalledTimes(2);
    await act(async () =>
      (
        node.querySelector(".hq-learned-today__heading") as HTMLButtonElement
      ).click()
    );
    expect(node.textContent).toContain(first.assertionText);
    await act(async () =>
      (
        node.querySelector(
          `[aria-label="Forget: ${first.assertionText}"]`
        ) as HTMLButtonElement
      ).click()
    );
    expect(forget).toHaveBeenCalledWith(first.id);
    expect(node.textContent).toContain("Memory forgotten.");
    await act(async () =>
      (
        node.querySelector(
          ".hq-learned-today__undo button"
        ) as HTMLButtonElement
      ).click()
    );
    expect(undo).toHaveBeenCalledWith(first.id, "12345");
    expect(node.textContent).toContain("Learned 2 things today");
  });
  it("does not show or mutate a cross-owner page", async () => {
    const forget = vi.fn();
    const api = {
      page: async () => ({
        assertions: [{ ...first, ownerUserId: second.id }],
        nextCursor: null
      }),
      forget
    } as unknown as CuratedMemoryDesktopApi;
    await act(async () =>
      root.render(
        <HqLearnedToday api={api} projectId={project} ownerId={owner} />
      )
    );
    expect(node.textContent).not.toContain(first.assertionText);
    expect(node.querySelector('[role="alert"]')?.textContent).toContain(
      "scope"
    );
    expect(forget).not.toHaveBeenCalled();
  });
  it("refreshes new memory after a panel revision without leaving the Project", async () => {
    let rows = [first];
    const page = vi.fn(async () => ({ assertions: rows, nextCursor: null }));
    const onOpenItem = vi.fn();
    const api = { page } as unknown as CuratedMemoryDesktopApi;
    await act(async () =>
      root.render(
        <HqLearnedToday
          api={api}
          projectId={project}
          ownerId={owner}
          memoryRevision={0}
          onOpenItem={onOpenItem}
        />
      )
    );
    expect(node.textContent).toContain("Learned 1 thing today");
    rows = [first, second];
    await act(async () =>
      root.render(
        <HqLearnedToday
          api={api}
          projectId={project}
          ownerId={owner}
          memoryRevision={1}
          onOpenItem={onOpenItem}
        />
      )
    );
    expect(node.textContent).toContain("Learned 2 things today");
    await act(async () =>
      (
        node.querySelector(".hq-learned-today__heading") as HTMLButtonElement
      ).click()
    );
    const firstDetail = [
      ...node.querySelectorAll<HTMLButtonElement>(".hq-learned-today__detail")
    ].find(
      (button) => button.querySelector("b")?.textContent === first.assertionText
    );
    expect(firstDetail).toBeDefined();
    await act(async () => firstDetail!.click());
    expect(onOpenItem).toHaveBeenCalledWith(
      expect.objectContaining({ id: first.id })
    );
  });
  it("drops a late page after the keyed Project identity switches", async () => {
    let resolveOld!: (value: {
      assertions: CuratedAssertion[];
      nextCursor: null;
    }) => void;
    const oldApi = {
      page: () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        })
    } as unknown as CuratedMemoryDesktopApi;
    const newProject = "00000000-0000-4000-8000-000000000105";
    const newApi = {
      page: async () => ({
        assertions: [{ ...second, projectId: newProject }],
        nextCursor: null
      })
    } as unknown as CuratedMemoryDesktopApi;
    await act(async () =>
      root.render(
        <HqLearnedToday
          key="old"
          api={oldApi}
          projectId={project}
          ownerId={owner}
        />
      )
    );
    await act(async () =>
      root.render(
        <HqLearnedToday
          key="new"
          api={newApi}
          projectId={newProject}
          ownerId={owner}
        />
      )
    );
    await act(async () =>
      resolveOld({ assertions: [first], nextCursor: null })
    );
    expect(node.textContent).toContain("Learned 1 thing today");
    await act(async () =>
      (
        node.querySelector(".hq-learned-today__heading") as HTMLButtonElement
      ).click()
    );
    expect(node.textContent).toContain(second.assertionText);
    expect(node.textContent).not.toContain(first.assertionText);
  });
});
