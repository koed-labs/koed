// @vitest-environment happy-dom
import type { PersonalDesktopApi } from "@koed/shared/personal-desktop";
import type { CollaborationMessage } from "@koed/shared/collaboration";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PersonalAskView } from "./PersonalAskView.js";
import { PersonalNotesView } from "./PersonalNotesView.js";

const adapters = { openExternal: vi.fn(), writeClipboard: vi.fn() };
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const click = async (element: Element | null) => {
  if (!(element instanceof HTMLElement)) throw new Error("button not found");
  await act(async () => element.click());
};

const enterText = async (element: HTMLTextAreaElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set?.call(element, value);
    element.dispatchEvent(new InputEvent("input", { bubbles: true }));
  });
};

describe("Personal Ask", () => {
  it("shows the focused welcome state, pending state, and final answer", async () => {
    let finish!: (
      value: Awaited<ReturnType<NonNullable<PersonalDesktopApi["submitAsk"]>>>
    ) => void;
    const submitAsk = vi.fn(
      async () =>
        await new Promise<
          Awaited<ReturnType<NonNullable<PersonalDesktopApi["submitAsk"]>>>
        >((resolve) => {
          finish = resolve;
        })
    );
    const api: PersonalDesktopApi = {
      assignSessionProject: vi.fn(async () => ({ projectId: null })),
      listProjects: vi.fn(async () => []),
      loadEventPage: vi.fn(async () => []),
      updateSessionTitle: vi.fn(async ({ title }) => ({ title })),
      subscribe: vi.fn(() => () => undefined),
      listAskThreads: vi.fn(async () => ({
        threads: [
          {
            askThreadId: "22222222-2222-4222-8222-222222222222",
            firstQuestion: "Earlier question",
            latestStatus: "answered" as const,
            turnCount: 1,
            updatedAt: "2026-08-17T12:00:00.000Z"
          }
        ],
        nextCursor: null
      })),
      loadAskThread: vi.fn(async () => []),
      submitAsk
    };
    const onSelectThread = vi.fn();
    await act(async () => {
      root.render(
        <PersonalAskView
          api={api}
          markdownAdapters={adapters}
          onNew={vi.fn()}
          onSelectThread={onSelectThread}
        />
      );
    });
    expect(container.textContent).toContain("What would you like to do?");
    expect(container.textContent).not.toContain("Earlier question");
    expect(container.textContent).not.toContain("Catch me up");
    expect(container.textContent).not.toContain(
      "Koed searches only Personal Memory available to you."
    );
    expect(container.querySelector(".personal-ask-recents")).toBeNull();

    const textarea = container.querySelector(
      'textarea[aria-label="Ask Personal Memory"]'
    ) as HTMLTextAreaElement;
    await enterText(textarea, "What did I decide?");
    await click(
      container.querySelector('button[aria-label="Submit question"]')
    );
    expect(container.textContent).toContain("Searching Personal Memory");

    await act(async () => {
      finish({
        id: "11111111-1111-4111-8111-111111111111",
        askThreadId: "33333333-3333-4333-8333-333333333333",
        askTurnIndex: 0,
        query: "What did I decide?",
        answerMarkdown: "You chose the **Ask welcome page**.",
        errorMessage: null,
        status: "answered",
        createdAt: "2026-08-17T12:00:00.000Z",
        updatedAt: "2026-08-17T12:00:01.000Z",
        answeredAt: "2026-08-17T12:00:01.000Z"
      });
      await Promise.resolve();
    });
    expect(container.textContent).toContain("You chose the Ask welcome page.");
    expect(onSelectThread).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333333"
    );
  });
});

describe("Personal Notes", () => {
  it("searches, opens, and creates immutable Notes-to-self messages", async () => {
    const message: CollaborationMessage = {
      id: "11111111-1111-4111-8111-111111111111",
      clientMessageId: null,
      threadId: "22222222-2222-4222-8222-222222222222",
      scope: "personal",
      teamId: null,
      sequence: 1,
      sender: {
        id: "33333333-3333-4333-8333-333333333333",
        displayName: "You",
        membershipState: "enabled"
      },
      senderKind: "user",
      body: "# Launch note\nKeep the Ask page focused.",
      createdAt: "2026-08-17T12:00:00.000Z",
      updatedAt: "2026-08-17T12:00:00.000Z",
      editedAt: null,
      deletedAt: null,
      delivery: "sent",
      recipientStatus: "read",
      failure: null
    };
    const onSave = vi.fn(async () => undefined);
    await act(async () => {
      root.render(
        <PersonalNotesView
          markdownAdapters={adapters}
          messages={[message]}
          newNote={false}
          onBack={vi.fn()}
          onNew={vi.fn()}
          onSave={onSave}
          onSelect={vi.fn()}
          selectedNoteId={message.id}
        />
      );
    });
    expect(container.textContent).toContain("Keep the Ask page focused.");
    expect(container.textContent).not.toContain("Delete");
    expect(container.textContent).not.toContain("Edit");

    await act(async () => {
      root.render(
        <PersonalNotesView
          markdownAdapters={adapters}
          messages={[message]}
          newNote
          onBack={vi.fn()}
          onNew={vi.fn()}
          onSave={onSave}
          onSelect={vi.fn()}
        />
      );
    });
    const textarea = container.querySelector(
      'textarea[aria-label="Note content"]'
    ) as HTMLTextAreaElement;
    await enterText(textarea, "A new durable Note");
    await click(container.querySelector('button[type="submit"]'));
    expect(onSave).toHaveBeenCalledWith("A new durable Note");
  });
});
