import {
  PERSONAL_DESKTOP_CONTRACT_VERSION,
  type PersonalDesktopResult
} from "@koed/shared";
import { describe, expect, it, vi } from "vitest";

import { createPersonalMemoryPreloadApi } from "./personal-memory-preload.js";
import {
  personalMemoryCommandChannel,
  personalMemoryEventChannel
} from "./protocol.js";

const success = (
  operation: PersonalDesktopResult["operation"],
  data: Record<string, unknown>
) => ({
  contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
  operation,
  ok: true,
  data
});

describe("Personal Memory preload bridge", () => {
  const events = () => ({
    on: vi.fn(),
    removeListener: vi.fn()
  });

  it("exposes exact methods and constructs the IPC request internally", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValue(success("personal.projects.list", { projects: [] }));
    const api = createPersonalMemoryPreloadApi(invoke, events());

    await expect(api.listProjects()).resolves.toEqual([]);
    expect(Object.keys(api).sort()).toEqual([
      "assignSessionProject",
      "createNote",
      "listAskThreads",
      "listNotes",
      "listProjectMetadata",
      "listProjects",
      "loadAskThread",
      "loadEventPage",
      "loadNote",
      "renameNote",
      "submitAsk",
      "subscribe",
      "updateNote",
      "updateSessionTitle"
    ]);
    expect(invoke).toHaveBeenCalledWith(personalMemoryCommandChannel, {
      contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
      operation: "personal.projects.list",
      input: {}
    });
  });

  it("creates a Personal Note through the protected IPC operation", async () => {
    const note = {
      noteId: "11111111-1111-4111-8111-111111111111",
      logicalMemoryId: "33333333-3333-4333-8333-333333333333",
      title: "Local note",
      titleVersion: 1,
      body: "Local note",
      revisionId: "44444444-4444-4444-8444-444444444444",
      revision: 1,
      contentHash: "a".repeat(64),
      memoryEventId: "22222222-2222-4222-8222-222222222222",
      projectionState: "available",
      projectionFailureCode: null,
      createdAt: "2026-08-20T12:00:00.000Z",
      updatedAt: "2026-08-20T12:00:00.000Z",
      sourceSequence: 1,
      event: {
        id: "22222222-2222-4222-8222-222222222222",
        actor: "user",
        eventType: "personal_note_revision",
        timestamp: "2026-08-20T12:00:00.000Z",
        sourceEventTime: "2026-08-20T12:00:00.000Z",
        sourceSequence: 1,
        content: "Local note",
        contentPreview: "Local note",
        invalidatedAt: null,
        metadata: {}
      }
    };
    const invoke = vi
      .fn()
      .mockResolvedValue(success("personal.notes.create", { note }));
    const api = createPersonalMemoryPreloadApi(invoke, events());
    const input = {
      body: "Local note",
      idempotencyKey: "11111111-1111-4111-8111-111111111111"
    };

    await expect(api.createNote?.(input)).resolves.toEqual(note);
    expect(invoke).toHaveBeenCalledWith(personalMemoryCommandChannel, {
      contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
      operation: "personal.notes.create",
      input
    });
  });

  it("exposes local Project metadata without allowing arbitrary IPC input", async () => {
    const invoke = vi.fn().mockResolvedValue(
      success("personal.projects.metadata.list", {
        projects: []
      })
    );
    const api = createPersonalMemoryPreloadApi(invoke, events());

    await expect(api.listProjectMetadata?.()).resolves.toEqual([]);
    expect(invoke).toHaveBeenCalledWith(personalMemoryCommandChannel, {
      contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
      operation: "personal.projects.metadata.list",
      input: {}
    });
  });

  it("constructs a bounded Captured Session title request", async () => {
    const invoke = vi.fn().mockResolvedValue(
      success("personal.sessions.update_title", {
        title: "Release planning"
      })
    );
    const api = createPersonalMemoryPreloadApi(invoke, events());
    const input = {
      sessionId: "11111111-1111-4111-8111-111111111111",
      title: "Release planning"
    };

    await expect(api.updateSessionTitle(input)).resolves.toEqual({
      title: "Release planning"
    });
    expect(invoke).toHaveBeenCalledWith(personalMemoryCommandChannel, {
      contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
      operation: "personal.sessions.update_title",
      input
    });
  });

  it.each([
    { apiToken: "raw-token" },
    { authorization: "Bearer raw-token" },
    { headers: { authorization: "Bearer raw-token" } },
    { url: "http://127.0.0.1:3000" },
    { path: "/v1/memory/graph/events" },
    { remoteAuthority: "team.example.test" }
  ])("rejects transport authority before IPC: %j", async (extra) => {
    const invoke = vi.fn();
    const api = createPersonalMemoryPreloadApi(invoke, events());
    await expect(
      api.loadEventPage({
        projectId: "project-1",
        threadId: "thread-1",
        limit: 50,
        ...extra
      })
    ).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("validates IPC results before returning them to the renderer", async () => {
    const api = createPersonalMemoryPreloadApi(
      vi.fn().mockResolvedValue(
        success("personal.projects.list", {
          projects: [],
          apiToken: "raw-token"
        })
      ),
      events()
    );
    await expect(api.listProjects()).rejects.toThrow();
  });

  it("validates live changes and removes the exact listener", () => {
    const eventBridge = events();
    const api = createPersonalMemoryPreloadApi(vi.fn(), eventBridge);
    const listener = vi.fn();
    const unsubscribe = api.subscribe(listener);
    expect(eventBridge.on).toHaveBeenCalledWith(
      personalMemoryEventChannel,
      expect.any(Function)
    );
    const wrapped = eventBridge.on.mock.calls[0]?.[1];

    wrapped?.(
      {},
      {
        contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
        type: "conversation_events_changed",
        eventRefs: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            projectId: "project-1",
            threadId: "thread-1"
          }
        ]
      }
    );
    wrapped?.({}, { apiToken: "not-a-change" });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(eventBridge.removeListener).toHaveBeenCalledWith(
      personalMemoryEventChannel,
      wrapped
    );
    wrapped?.(
      {},
      {
        contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
        type: "conversation_events_changed",
        eventRefs: [
          {
            id: "00000000-0000-4000-8000-000000000002",
            projectId: "project-1",
            threadId: "thread-1"
          }
        ]
      }
    );
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
