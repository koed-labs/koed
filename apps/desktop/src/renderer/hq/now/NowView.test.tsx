// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopProject } from "../../../project-memory-ui.js";
import type { ManagedConversationDesktopApi } from "../../../ipc/managed-conversation-protocol.js";
import { NowView } from "./NowView.js";

const projects = Array.from({ length: 7 }, (_, index) => ({
  id: `project-${index}`,
  name: `Project ${index}`,
  contextKind: "project",
  threads: []
})) as unknown as DesktopProject[];

describe("Now view", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("caps Project rows, persists fold state, and opens the selected Project", async () => {
    const select = vi.fn();
    const api = {
      list: async () => ({ operation: "list", executions: [], complete: true })
    } as unknown as ManagedConversationDesktopApi;
    await act(async () =>
      root.render(
        <NowView
          projects={projects}
          api={api}
          approvals={[]}
          onSelectProject={select}
          onSelectConversation={vi.fn()}
        />
      )
    );
    expect(
      container.querySelectorAll(
        '.hq-now__section[aria-label="Projects"] .hq-now__row'
      )
    ).toHaveLength(5);
    await act(async () =>
      (container.querySelector(".hq-now__more") as HTMLButtonElement).click()
    );
    expect(
      container.querySelectorAll(
        '.hq-now__section[aria-label="Projects"] .hq-now__row'
      )
    ).toHaveLength(7);
    await act(async () =>
      (
        container.querySelector(
          '.hq-now__section[aria-label="Projects"] header button'
        ) as HTMLButtonElement
      ).click()
    );
    expect(localStorage.getItem("koed.hq.now.v1")).toContain(
      '"projectsFolded":true'
    );
    await act(async () =>
      (
        container.querySelector(
          '.hq-now__section[aria-label="Projects"] header button'
        ) as HTMLButtonElement
      ).click()
    );
    await act(async () =>
      (
        container.querySelector(
          '.hq-now__section[aria-label="Projects"] .hq-now__row'
        ) as HTMLButtonElement
      ).click()
    );
    expect(select).toHaveBeenCalledWith("project-0");
  });

  it("drops a nonempty stale owner inventory before runtime fanout", async () => {
    let resolveList!: (value: {
      operation: "list";
      executions: [
        {
          executionId: string;
          projectId: string;
          sessionId: null;
          threadId: null;
          state: string;
        }
      ];
      complete: boolean;
    }) => void;
    const list = new Promise<{
      operation: "list";
      executions: [
        {
          executionId: string;
          projectId: string;
          sessionId: null;
          threadId: null;
          state: string;
        }
      ];
      complete: boolean;
    }>((resolve) => {
      resolveList = resolve;
    });
    const api = {
      list: () => list,
      runtime: vi.fn()
    } as unknown as ManagedConversationDesktopApi;
    await act(async () =>
      root.render(
        <NowView
          projects={[]}
          api={api}
          approvals={[]}
          onSelectProject={vi.fn()}
          onSelectConversation={vi.fn()}
        />
      )
    );
    await act(async () => root.unmount());
    await act(async () =>
      resolveList({
        operation: "list",
        executions: [
          {
            executionId: "old",
            projectId: "old-project",
            sessionId: null,
            threadId: null,
            state: "ready"
          }
        ],
        complete: true
      })
    );
    expect(api.runtime).not.toHaveBeenCalled();
  });

  it("hides old source rows immediately and never claims all clear after a truncated or failed read", async () => {
    const item = {
      id: "pending",
      itemKind: "user_input",
      state: "pending",
      answered: false,
      createdAt: "2026-10-19T00:00:00Z",
      payload: { questions: [{ question: "Which option?" }] }
    };
    const execution = {
      executionId: "execution-a",
      projectId: "project-0",
      sessionId: "session-a",
      threadId: "thread-a",
      state: "ready"
    };
    const first = {
      list: async () => ({
        operation: "list",
        executions: [execution],
        complete: false
      }),
      runtime: async () => ({ items: [item] })
    } as unknown as ManagedConversationDesktopApi;
    const second = {
      list: () => new Promise(() => undefined),
      runtime: vi.fn()
    } as unknown as ManagedConversationDesktopApi;
    const render = (api: ManagedConversationDesktopApi | null) => (
      <NowView
        projects={projects}
        projectsReady
        api={api}
        approvals={[]}
        onSelectProject={vi.fn()}
        onSelectConversation={vi.fn()}
      />
    );
    await act(async () => root.render(render(first)));
    expect(container.textContent).toContain("Which option?");
    expect(container.textContent).toContain("Older activity may be missing");
    await act(async () => root.render(render(second)));
    expect(container.textContent).not.toContain("Which option?");
    await act(async () => root.render(render(null)));
    expect(container.textContent).not.toContain("Nothing needs you right now");
  });
  it("reports a runtime read failure without claiming the attention list is complete", async () => {
    const api = {
      list: async () => ({
        operation: "list",
        executions: [
          {
            executionId: "e",
            projectId: "project-0",
            sessionId: "s",
            threadId: "t",
            state: "ready"
          }
        ],
        complete: true
      }),
      runtime: async () => {
        throw new Error("unavailable");
      }
    } as unknown as ManagedConversationDesktopApi;
    await act(async () =>
      root.render(
        <NowView
          projects={projects}
          projectsReady
          api={api}
          approvals={[]}
          onSelectProject={vi.fn()}
          onSelectConversation={vi.fn()}
        />
      )
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Some Conversation requests could not be loaded"
    );
    expect(container.textContent).not.toContain("Nothing needs you right now");
  });
});
