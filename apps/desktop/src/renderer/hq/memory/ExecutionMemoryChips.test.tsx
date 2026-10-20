// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ManagedConversationDesktopApi,
  ManagedConversationRuntimeItem,
  ManagedConversationTurnCitation
} from "../../../ipc/managed-conversation-protocol.js";
import { ExecutionMemoryChips } from "./ExecutionMemoryChips.js";
import {
  latestRuntimeTurn,
  visibleTurnCitations
} from "./execution-memory-chips.js";

const citation = (
  alias: string,
  providerTurnId = "turn-2"
): ManagedConversationTurnCitation => ({
  alias,
  providerTurnId,
  sourceType: "curated_memory",
  sourceId: alias,
  visibility: "personal",
  detailAvailable: true,
  title: alias === "a" ? "Keep the tests" : "Use the release checklist",
  summary: null
});
const item = (
  id: string,
  providerTurnId: string | null,
  createdAt: string,
  executionGeneration = 1
) =>
  ({
    id,
    providerTurnId,
    createdAt,
    executionGeneration,
    revision: 1
  }) as ManagedConversationRuntimeItem;
const props = {
  ownerId: "owner-1",
  profileKey: "profile-1",
  projectId: "project-1",
  executionId: "execution-1",
  providerTurnId: "turn-2"
};

describe("execution memory chips", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    container.className = "hq-main-panel";
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers();
    container.remove();
    vi.restoreAllMocks();
  });

  it("uses the question's exact turn and hides citations from another turn", () => {
    const items = [
      item("question:one", "turn-1", "2026-10-20T10:00:00Z"),
      item("question:two", "turn-2", "2026-10-20T11:00:00Z")
    ];
    expect(latestRuntimeTurn(items, "question:one")).toBe("turn-1");
    expect(latestRuntimeTurn(items)).toBe("turn-2");
    expect(
      visibleTurnCitations([citation("a"), citation("old", "turn-1")], "turn-2")
    ).toEqual([citation("a")]);
    expect(
      latestRuntimeTurn([item("new", null, "2026-10-20T12:00:00Z"), ...items])
    ).toBe("turn-2");
    expect(
      latestRuntimeTurn(
        [item("new-generation", null, "2026-10-20T12:00:00Z", 2), ...items],
        undefined,
        2
      )
    ).toBeNull();
  });

  it("shows a persisted count, opens reauthorized detail, and clears on identity switch", async () => {
    const turnCitations = vi.fn(async () => ({
      operation: "turn_citations" as const,
      executionId: props.executionId,
      providerTurnId: "turn-2",
      citations: [citation("a"), citation("b")]
    }));
    const citationDetail = vi.fn(async () => ({
      operation: "citation_detail" as const,
      executionId: props.executionId,
      providerTurnId: "turn-2",
      alias: "a",
      citation: citation("a")
    }));
    const api = {
      turnCitations,
      citationDetail
    } as unknown as ManagedConversationDesktopApi;
    await act(async () =>
      root.render(
        <ExecutionMemoryChips
          {...props}
          api={api}
          panelHost={container}
          variant="count"
        />
      )
    );
    expect(
      container.querySelector(".hq-execution-memory__chip")?.textContent
    ).toContain("2 memories");
    await act(async () =>
      (
        container.querySelector(
          ".hq-execution-memory__chip"
        ) as HTMLButtonElement
      ).click()
    );
    await act(async () =>
      (
        container.querySelector(
          ".hq-execution-memory__panel > button:nth-child(2)"
        ) as HTMLButtonElement
      ).click()
    );
    expect(citationDetail).toHaveBeenCalledWith(
      props.executionId,
      "turn-2",
      "a"
    );
    expect(
      container.querySelector('[aria-label="Memory source detail"]')
    ).not.toBeNull();
    await act(async () =>
      root.render(
        <ExecutionMemoryChips
          {...props}
          ownerId="owner-2"
          api={api}
          panelHost={container}
          variant="count"
        />
      )
    );
    expect(container.querySelector(".hq-execution-memory__panel")).toBeNull();
    expect(turnCitations).toHaveBeenCalledTimes(2);
  });

  it("shows no chip without a persisted provider turn or citations", async () => {
    const turnCitations = vi.fn(async () => ({
      operation: "turn_citations" as const,
      executionId: props.executionId,
      providerTurnId: "turn-2",
      citations: []
    }));
    const api = { turnCitations } as unknown as ManagedConversationDesktopApi;
    await act(async () =>
      root.render(
        <ExecutionMemoryChips
          {...props}
          providerTurnId={null}
          api={api}
          variant="why"
        />
      )
    );
    expect(turnCitations).not.toHaveBeenCalled();
    await act(async () =>
      root.render(<ExecutionMemoryChips {...props} api={api} variant="why" />)
    );
    expect(container.querySelector(".hq-execution-memory__chip")).toBeNull();
  });

  it("discards a delayed response after owner, profile, project, execution, and turn change", async () => {
    let resolveOld!: (value: unknown) => void;
    const oldResult = new Promise((resolve) => {
      resolveOld = resolve;
    });
    const oldApi = {
      turnCitations: vi.fn(() => oldResult)
    } as unknown as ManagedConversationDesktopApi;
    const newApi = {
      turnCitations: vi.fn(async () => ({
        operation: "turn_citations",
        executionId: "execution-2",
        providerTurnId: "turn-3",
        citations: []
      }))
    } as unknown as ManagedConversationDesktopApi;
    await act(async () =>
      root.render(
        <ExecutionMemoryChips {...props} api={oldApi} variant="count" />
      )
    );
    await act(async () =>
      root.render(
        <ExecutionMemoryChips
          ownerId="owner-2"
          profileKey="profile-2"
          projectId="project-2"
          executionId="execution-2"
          providerTurnId="turn-3"
          api={newApi}
          variant="count"
        />
      )
    );
    await act(async () =>
      resolveOld({
        operation: "turn_citations",
        executionId: props.executionId,
        providerTurnId: "turn-2",
        citations: [citation("a")]
      })
    );
    expect(container.querySelector(".hq-execution-memory__chip")).toBeNull();
  });

  it("refreshes initially empty citations and fences the same turn ID in a new generation", async () => {
    vi.useFakeTimers();
    let available = false;
    const turnCitations = vi.fn(async () => ({
      operation: "turn_citations" as const,
      executionId: props.executionId,
      providerTurnId: "turn-2",
      citations: available ? [citation("a")] : []
    }));
    const api = { turnCitations } as unknown as ManagedConversationDesktopApi;
    await act(async () =>
      root.render(
        <ExecutionMemoryChips
          {...props}
          executionGeneration={1}
          api={api}
          variant="count"
        />
      )
    );
    expect(container.querySelector(".hq-execution-memory__chip")).toBeNull();
    available = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(
      container.querySelector(".hq-execution-memory__chip")?.textContent
    ).toContain("1 memory");
    available = false;
    await act(async () =>
      root.render(
        <ExecutionMemoryChips
          {...props}
          executionGeneration={2}
          api={api}
          variant="count"
        />
      )
    );
    expect(container.querySelector(".hq-execution-memory__chip")).toBeNull();
  });

  it("hides selected detail when the refreshed citation becomes unavailable", async () => {
    vi.useFakeTimers();
    let available = true;
    const turnCitations = vi.fn(async () => ({
      operation: "turn_citations" as const,
      executionId: props.executionId,
      providerTurnId: "turn-2",
      citations: [{ ...citation("a"), detailAvailable: available }]
    }));
    const citationDetail = vi.fn(async () => ({
      operation: "citation_detail" as const,
      executionId: props.executionId,
      providerTurnId: "turn-2",
      alias: "a",
      citation: { ...citation("a"), summary: "Private source text" }
    }));
    const api = {
      turnCitations,
      citationDetail
    } as unknown as ManagedConversationDesktopApi;
    await act(async () =>
      root.render(
        <ExecutionMemoryChips
          {...props}
          api={api}
          panelHost={container}
          variant="why"
        />
      )
    );
    await act(async () =>
      (
        container.querySelector(
          ".hq-execution-memory__chip"
        ) as HTMLButtonElement
      ).click()
    );
    expect(container.textContent).toContain("Private source text");
    available = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(container.textContent).not.toContain("Private source text");
    expect(container.textContent).toContain(
      "This memory source is unavailable."
    );
  });
});
