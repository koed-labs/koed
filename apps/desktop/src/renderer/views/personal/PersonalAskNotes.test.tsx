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
import type { ManagedConversationDesktopApi } from "../../../ipc/managed-conversation-protocol.js";
import {
  localAiClientFlowKeys,
  type LocalAiClientResponse
} from "../../../ipc/local-ai-client-protocol.js";
import type { DesktopProject } from "../../../project-memory-ui.js";

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
  vi.useRealTimers();
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
  it("starts a managed Project Conversation through the approved Ask layout", async () => {
    const api: PersonalDesktopApi = {
      assignSessionProject: vi.fn(async () => ({ projectId: null })),
      updateSessionPresentation: vi.fn(async () => {
        throw new Error("Unexpected presentation update in this fixture");
      }),
      listProjects: vi.fn(async () => []),
      loadEventPage: vi.fn(async () => []),
      updateSessionTitle: vi.fn(async ({ title }) => ({ title })),
      subscribe: vi.fn(() => () => undefined),
      loadAskThread: vi.fn(async () => [])
    };
    const project = {
      id: "project-research",
      name: "Research",
      path: "/tmp/research",
      eventCount: 0,
      threads: [],
      catalogued: true,
      discoveredAt: "2026-08-17T12:00:00.000Z",
      lastSeenAt: "2026-08-17T12:00:00.000Z",
      localProjectId: "project-research",
      branch: null,
      remoteDisplay: null,
      isWorktree: false
    } satisfies DesktopProject;
    const independent = {
      ...project,
      id: "project-independent",
      name: "Independent",
      path: "/tmp/koed/Independent",
      localProjectId: "project-independent"
    } satisfies DesktopProject;
    const start = vi.fn(async () => ({
      operation: "start" as const,
      status: "starting" as const,
      executionId: "11111111-1111-4111-8111-111111111111"
    }));
    const send = vi.fn(async () => ({
      operation: "send" as const,
      status: "queued" as const,
      conversation: {
        executionId: "11111111-1111-4111-8111-111111111111",
        projectId: project.id,
        capturedSessionId: "11111111-1111-4111-8111-111111111111",
        threadId: "11111111-1111-4111-8111-111111111111"
      },
      idempotencyKey: "desktop-prompt:test",
      clientUserMessageId: "22222222-2222-4222-8222-222222222222"
    }));
    const managedConversations = {
      launchOptions: vi.fn(async () => ({
        operation: "launch_options" as const,
        options: {
          runners: [
            {
              kind: "local_device" as const,
              deploymentId: "local",
              deviceId: "device",
              displayName: "This device"
            }
          ],
          instances: [
            {
              instanceId: "codex-default",
              driverId: "codex" as const,
              displayName: "Codex",
              ready: true,
              readiness: "ready",
              models: [
                {
                  id: "gpt-test",
                  supportedReasoningEfforts: ["medium"],
                  defaultReasoningEffort: "medium",
                  isDefault: true
                }
              ],
              capabilities: {
                defaultPermissionMode: "supervised" as const,
                permissionModes: [
                  { mode: "supervised" as const, support: "supported" as const }
                ]
              }
            }
          ]
        }
      })),
      start,
      send,
      writeDraft: vi.fn(async () => ({
        operation: "draft_write" as const,
        ok: true as const
      })),
      deleteDraft: vi.fn(async () => ({
        operation: "draft_delete" as const,
        ok: true as const
      }))
    } as unknown as ManagedConversationDesktopApi;
    vi.useFakeTimers();
    const loadedOptions = await managedConversations.launchOptions();
    loadedOptions.options.instances.push({
      ...loadedOptions.options.instances[0]!,
      instanceId: "codex-preferred",
      displayName: "Preferred Codex",
      models: [
        {
          id: "preferred-model",
          supportedReasoningEfforts: ["low", "high"],
          defaultReasoningEffort: "low"
        }
      ]
    });
    const defaultAssignment = {
      provider: "codex" as const,
      ai_client_instance_id: "codex-default",
      model: "gpt-test",
      reasoning_effort: "medium",
      timeout_ms: 120000,
      max_attempts: 2
    };
    const settings: LocalAiClientResponse = {
      operation: "list",
      readModel: {
        instances: [],
        capabilitySnapshots: [],
        settings: [
          {
            flowKey: "conversations",
            provider: "codex",
            aiClientInstanceId: "codex-preferred",
            model: "preferred-model",
            reasoningEffort: "high",
            timeoutMs: 120000,
            maxAttempts: 2,
            createdAt: "2026-09-09T10:00:00.000Z",
            updatedAt: "2026-09-09T10:00:00.000Z"
          }
        ],
        defaults: Object.fromEntries(
          localAiClientFlowKeys.map((key) => [
            key,
            {
              source: "code",
              available: true,
              assignment: defaultAssignment,
              reason: null
            }
          ])
        ) as LocalAiClientResponse["readModel"]["defaults"]
      }
    };
    const localAiClients = {
      list: vi.fn(async () => settings),
      refresh: vi.fn(async () => settings),
      set: vi.fn(async () => settings),
      reset: vi.fn(async () => settings)
    };

    let resolveOptions!: (value: typeof loadedOptions) => void;
    managedConversations.launchOptions = vi
      .fn(
        () =>
          new Promise<typeof loadedOptions>((resolve) => {
            resolveOptions = resolve;
          })
      )
      .mockRejectedValueOnce(new Error("API starting"));
    let resolveProject!: (value: DesktopProject) => void;
    const pendingProject = new Promise<DesktopProject>((resolve) => {
      resolveProject = resolve;
    });
    const onConversationStarted = vi.fn();
    const onOpenProject = vi.fn(async () => {
      throw new Error("The selected folder is not accessible.");
    });
    await act(async () => {
      root.render(
        <PersonalAskView
          api={api}
          managedConversations={managedConversations}
          localAiClients={localAiClients}
          markdownAdapters={adapters}
          onConversationStarted={onConversationStarted}
          onNew={vi.fn()}
          onOpenProject={onOpenProject}
          onResolveIndependent={vi
            .fn(() => pendingProject)
            .mockRejectedValueOnce(new Error("Projects starting"))}
          projects={[project]}
        />
      );
    });
    expect(container.querySelector("textarea")).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(500));

    expect(container.textContent).toContain("Where shall we start?");
    expect(container.textContent).toContain("Chat");
    expect(container.textContent).not.toContain("Send your first message");
    expect(container.querySelector(".conversation-new-device")).toBeNull();
    expect(container.textContent).toContain("Research");
    expect(container.textContent).toContain("Open a project");
    expect(container.textContent).not.toContain("CHOOSE YOUR CONTEXT");
    expect(container.textContent).not.toContain("Working in");

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    await enterText(textarea, "Investigate the generic task");
    const submit = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Start Conversation"]'
    )!;
    expect(textarea.disabled).toBe(false);
    expect(submit.disabled).toBe(true);
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
    });
    expect(start).not.toHaveBeenCalled();
    await act(async () => resolveOptions(loadedOptions));
    expect(submit.disabled).toBe(true);
    await act(async () => resolveProject(independent));
    expect(container.querySelector("textarea")).toBe(textarea);
    expect(textarea.value).toBe("Investigate the generic task");
    expect(submit.disabled).toBe(false);
    vi.useRealTimers();

    await click(
      [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Open a project")
      ) ?? null
    );
    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        "The selected folder is not accessible."
      )
    );
    expect(textarea.value).toBe("Investigate the generic task");
    await click(
      [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Research")
      ) ?? null
    );
    expect(textarea.value).toBe("Investigate the generic task");
    await click(
      container.querySelector('button[aria-label="Start Conversation"]')
    );
    await vi.waitFor(() =>
      expect(onConversationStarted).toHaveBeenCalledTimes(1)
    );
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: project.id,
        contextKind: "project",
        aiClientInstanceId: "codex-preferred",
        model: "preferred-model",
        reasoningEffort: "high"
      })
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Investigate the generic task" })
    );
  });

  it("keeps the empty start page understandable when AI Clients are unavailable", async () => {
    const independent = {
      id: "project-independent",
      name: "Independent",
      path: "/tmp/koed/Independent",
      eventCount: 0,
      threads: [],
      catalogued: true,
      discoveredAt: "2026-08-17T12:00:00.000Z",
      lastSeenAt: "2026-08-17T12:00:00.000Z",
      localProjectId: "project-independent",
      branch: null,
      remoteDisplay: null,
      isWorktree: false
    } satisfies DesktopProject;
    const managedConversations = {
      launchOptions: vi.fn(async () => {
        throw new Error("offline");
      })
    } as unknown as ManagedConversationDesktopApi;

    await act(async () => {
      root.render(
        <PersonalAskView
          api={
            {
              loadAskThread: vi.fn(async () => [])
            } as unknown as PersonalDesktopApi
          }
          managedConversations={managedConversations}
          markdownAdapters={adapters}
          onNew={vi.fn()}
          onResolveIndependent={vi.fn(async () => independent)}
          projects={[]}
        />
      );
    });

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector("form")?.getAttribute("aria-busy")).toBe(
      "true"
    );
    expect(container.textContent).toContain("Where shall we start?");
    expect(container.textContent).toContain("Start without a Project");
    expect(container.querySelector("textarea")).not.toBeNull();
    expect(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Start Conversation"]'
      )?.disabled
    ).toBe(true);
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
      updateSessionPresentation: vi.fn(async () => {
        throw new Error("Unexpected presentation update in this fixture");
      }),
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
        "This historical Ask thread could not be opened."
      )
    );

    await render("33333333-3333-4333-8333-333333333333");
    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        "The Codex worker could not verify its answer against enough supporting Personal Memory evidence."
      )
    );
    expect(container.textContent).not.toContain(
      "This historical Ask thread could not be opened."
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
      updateSessionPresentation: vi.fn(async () => {
        throw new Error("Unexpected presentation update in this fixture");
      }),
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
      updateSessionPresentation: vi.fn(async () => {
        throw new Error("Unexpected presentation update in this fixture");
      }),
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
