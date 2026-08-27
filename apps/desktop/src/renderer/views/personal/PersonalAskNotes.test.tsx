// @vitest-environment happy-dom
import {
  PERSONAL_DESKTOP_CONTRACT_VERSION,
  type PersonalDesktopApi
} from "@koed/shared/personal-desktop";
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
    expect(container.textContent).toContain("What would you like to know?");
    expect(
      container.querySelector(".personal-ask-main")?.getAttribute("data-view")
    ).toBe("welcome");
    expect(container.textContent).not.toContain("Earlier question");
    expect(container.textContent).not.toContain("Catch me up");
    expect(container.textContent).not.toContain(
      "Koed searches only Personal Memory available to you."
    );
    expect(container.querySelector(".personal-ask-recents")).toBeNull();
    expect(
      container.querySelector(".personal-ask-composer-footer span")
    ).toBeNull();
    expect(
      container.querySelector(".personal-ask-composer-footer .lucide-sparkles")
    ).toBeNull();

    const submitButton = container.querySelector(
      'button[aria-label="Submit question"]'
    );
    expect(submitButton?.querySelector(".lucide-arrow-up")).not.toBeNull();
    expect(submitButton?.querySelector(".personal-ask-spinner")).toBeNull();

    const textarea = container.querySelector(
      'textarea[aria-label="Ask Personal Memory"]'
    ) as HTMLTextAreaElement;
    await enterText(textarea, "What did I decide?");
    await click(
      container.querySelector('button[aria-label="Submit question"]')
    );
    expect(container.textContent).toContain("Searching...");
    expect(container.textContent).not.toContain("Searching Personal Memory");
    expect(
      container
        .querySelector('button[aria-label="Submit question"]')
        ?.querySelector(".personal-ask-spinner")
    ).not.toBeNull();

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
    expect(container.querySelector(".personal-ask-answer")).not.toBeNull();
    expect(
      container.querySelector(".personal-ask-main")?.getAttribute("data-view")
    ).toBe("conversation");
    expect(
      container
        .querySelector(".personal-ask-conversation-heading")
        ?.getAttribute("aria-label")
    ).toBe("Conversation actions");
    expect(
      container.querySelector(".personal-ask-conversation-title")
    ).toBeNull();
    expect(onSelectThread).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333333"
    );
    expect(
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "New"
      )?.classList
    ).toContain("personal-new-conversation-standalone");
  });

  it("clears a stale thread-load error and presents AI Client failures clearly", async () => {
    const loadAskThread = vi.fn(
      async ({ askThreadId }: { askThreadId: string }) => {
        if (askThreadId === "22222222-2222-4222-8222-222222222222") {
          throw new Error("invalid response");
        }
        return [
          {
            id: "11111111-1111-4111-8111-111111111111",
            askThreadId,
            askTurnIndex: 0,
            query: "What was the last branch?",
            answerMarkdown: null,
            errorMessage:
              "The Codex worker could not verify its answer against enough supporting Personal Memory evidence.",
            status: "error" as const,
            createdAt: "2026-08-17T12:00:00.000Z",
            updatedAt: "2026-08-17T12:00:01.000Z",
            answeredAt: "2026-08-17T12:00:01.000Z"
          }
        ];
      }
    );
    const api: PersonalDesktopApi = {
      assignSessionProject: vi.fn(async () => ({ projectId: null })),
      listProjects: vi.fn(async () => []),
      loadEventPage: vi.fn(async () => []),
      updateSessionTitle: vi.fn(async ({ title }) => ({ title })),
      subscribe: vi.fn(() => () => undefined),
      loadAskThread
    };
    const render = async (selectedThreadId: string) => {
      await act(async () => {
        root.render(
          <PersonalAskView
            api={api}
            markdownAdapters={adapters}
            onNew={vi.fn()}
            onSelectThread={vi.fn()}
            selectedThreadId={selectedThreadId}
          />
        );
      });
    };

    await render("22222222-2222-4222-8222-222222222222");
    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        "This Ask thread could not be opened."
      )
    );

    await render("33333333-3333-4333-8333-333333333333");
    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        "The Codex worker could not verify its answer against enough supporting Personal Memory evidence."
      )
    );
    expect(container.textContent).not.toContain(
      "This Ask thread could not be opened."
    );
    expect(container.textContent).not.toContain("codex_failed");
  });
});

describe("Personal Notes", () => {
  it("retries the list and selected detail after a transient refresh failure", async () => {
    const summary = {
      noteId: "11111111-1111-4111-8111-111111111111",
      title: "Recovered Note",
      titleVersion: 1,
      revisionId: "22222222-2222-4222-8222-222222222222",
      revision: 1,
      contentHash: "a".repeat(64),
      memoryEventId: "44444444-4444-4444-8444-444444444444",
      projectionState: "available" as const,
      projectionFailureCode: null,
      createdAt: "2026-08-17T12:00:00.000Z",
      updatedAt: "2026-08-17T12:00:00.000Z",
      sourceSequence: 1
    };
    const listNotes = vi
      .fn<NonNullable<PersonalDesktopApi["listNotes"]>>()
      .mockRejectedValueOnce(new Error("API restarting"))
      .mockResolvedValue({ notes: [summary], nextBeforeSequence: null });
    const api: PersonalDesktopApi = {
      listProjects: vi.fn(async () => []),
      loadEventPage: vi.fn(async () => []),
      assignSessionProject: vi.fn(async () => ({ projectId: null })),
      updateSessionTitle: vi.fn(async ({ title }) => ({ title })),
      listNotes,
      subscribe: vi.fn(() => () => undefined)
    };

    await act(async () => {
      root.render(
        <PersonalNotesView
          api={api}
          markdownAdapters={adapters}
          newNote={false}
          onBack={vi.fn()}
          onNew={vi.fn()}
          onSave={vi.fn(async () => undefined)}
          onSelect={vi.fn()}
        />
      );
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Notes could not be refreshed")
    );

    await click(
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Retry Notes"
      ) ?? null
    );

    await vi.waitFor(() => expect(listNotes).toHaveBeenCalledTimes(2));
    expect(container.textContent).toContain("Recovered Note");
    expect(container.textContent).not.toContain("Notes could not be refreshed");
  });

  it("searches, opens, edits, and creates revisioned Personal Notes", async () => {
    let noteChangeListener:
      | Parameters<PersonalDesktopApi["subscribe"]>[0]
      | undefined;
    const summary = {
      noteId: "11111111-1111-4111-8111-111111111111",
      title: "Launch note",
      titleVersion: 1,
      revisionId: "22222222-2222-4222-8222-222222222222",
      revision: 1,
      contentHash: "a".repeat(64),
      memoryEventId: "44444444-4444-4444-8444-444444444444",
      projectionState: "available" as const,
      projectionFailureCode: null,
      createdAt: "2026-08-17T12:00:00.000Z",
      updatedAt: "2026-08-17T12:00:00.000Z",
      sourceSequence: 1
    };
    const note = {
      ...summary,
      body: "# Launch note\nKeep the Ask page focused.",
      logicalMemoryId: "55555555-5555-4555-8555-555555555555",
      event: {
        id: summary.memoryEventId,
        actor: "user",
        eventType: "personal_note_revision",
        timestamp: summary.createdAt,
        sourceEventTime: summary.createdAt,
        sourceSequence: 1,
        content: "# Launch note\nKeep the Ask page focused.",
        contentPreview: "Launch note",
        invalidatedAt: null,
        metadata: {}
      }
    };
    const api: PersonalDesktopApi = {
      listProjects: vi.fn(async () => []),
      loadEventPage: vi.fn(async () => []),
      assignSessionProject: vi.fn(async () => ({ projectId: null })),
      updateSessionTitle: vi.fn(async ({ title }) => ({ title })),
      listNotes: vi.fn(async () => ({
        notes: [summary],
        nextBeforeSequence: null
      })),
      loadNote: vi.fn(async () => note),
      renameNote: vi.fn(async ({ title }) => ({ ...summary, title })),
      updateNote: vi.fn(async ({ body }) => ({
        ...note,
        body,
        revisionId: "33333333-3333-4333-8333-333333333333",
        revision: 2,
        contentHash: "b".repeat(64),
        memoryEventId: null,
        projectionState: "pending" as const,
        event: null
      })),
      subscribe: vi.fn((listener) => {
        noteChangeListener = listener;
        return () => undefined;
      })
    };
    const onSave = vi.fn(async () => undefined);
    const onNew = vi.fn();
    await act(async () => {
      root.render(
        <PersonalNotesView
          api={api}
          markdownAdapters={adapters}
          newNote={false}
          onBack={vi.fn()}
          onNew={onNew}
          onSave={onSave}
          onSelect={vi.fn()}
          selectedNoteId={summary.noteId}
        />
      );
    });
    expect(
      container
        .querySelector(".personal-notes-workspace")
        ?.getAttribute("data-narrow-view")
    ).toBe("detail");
    expect(
      container.querySelector(".personal-notes-list > header > h1")?.textContent
    ).toBe("Notes");
    expect(
      container
        .querySelector(".personal-notes-list > header > span")
        ?.getAttribute("aria-label")
    ).toBe("1 Notes");
    expect(
      container.querySelector(
        '.personal-note-items > button[aria-label="New Note"]'
      )
    ).not.toBeNull();
    expect(
      container.querySelector(
        '.personal-notes-list > header button[aria-label="New Note"]'
      )
    ).toBeNull();
    await click(
      container.querySelector(
        '.personal-note-items > button[aria-label="New Note"]'
      )
    );
    expect(onNew).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Keep the Ask page focused.");
    expect(container.textContent).not.toContain("Delete");
    expect(
      container.querySelector('button[aria-label="Edit Note"]')
    ).toBeNull();
    expect(
      container.querySelector('button[aria-label="Share Note"]')
    ).toBeNull();
    await click(container.querySelector('[aria-label="Edit Note content"]'));
    const bodyEditor = container.querySelector(
      'textarea[aria-label="Note content"]'
    ) as HTMLTextAreaElement;
    expect(
      container.querySelector(
        ".personal-note-edit-actions button[type='submit']"
      )?.textContent
    ).toBe("Save");
    expect(
      container.querySelector(
        ".personal-note-edit-actions button[type='button']"
      )?.textContent
    ).toBe("Cancel");
    await enterText(bodyEditor, "Updated launch guidance");
    await click(
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Save"
      ) ?? null
    );
    await vi.waitFor(() =>
      expect(api.updateNote).toHaveBeenCalledWith({
        noteId: summary.noteId,
        expectedRevision: 1,
        body: "Updated launch guidance",
        idempotencyKey: expect.any(String)
      })
    );
    await act(async () =>
      noteChangeListener?.({
        contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
        type: "notes_changed",
        noteIds: [summary.noteId]
      })
    );
    await vi.waitFor(() => expect(api.listNotes).toHaveBeenCalledTimes(3));

    await act(async () => {
      root.render(
        <PersonalNotesView
          api={api}
          markdownAdapters={adapters}
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
    expect(onSave).toHaveBeenCalledWith(
      "A new durable Note",
      expect.any(String)
    );

    await act(async () => {
      root.render(
        <PersonalNotesView
          api={api}
          markdownAdapters={adapters}
          newNote={false}
          onBack={vi.fn()}
          onNew={vi.fn()}
          onSave={onSave}
          onSelect={vi.fn()}
        />
      );
    });
    expect(
      container
        .querySelector(".personal-notes-workspace")
        ?.getAttribute("data-narrow-view")
    ).toBe("list");
    expect(document.activeElement?.textContent).toBe("Notes");
  });
});
