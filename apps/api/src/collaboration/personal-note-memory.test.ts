import type {
  CollaborationMessageRecord,
  MemorySourceRepository,
  PersonalNoteProjectionCursorRecord
} from "@koed/db";
import { describe, expect, it, vi } from "vitest";

import {
  createPersonalNoteMemoryRepairService,
  projectPersonalNoteToMemory,
  reconcilePersonalNotesToMemory,
  type PersonalNoteMemoryReconciliationOptions
} from "./personal-note-memory.js";

const message: CollaborationMessageRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  threadId: "22222222-2222-4222-8222-222222222222",
  threadSequence: 7,
  audienceVersion: 1,
  scope: "personal",
  personalOwnerUserId: "33333333-3333-4333-8333-333333333333",
  teamId: null,
  teamWorkspaceId: null,
  senderKind: "user",
  senderPrincipalId: "33333333-3333-4333-8333-333333333333",
  senderUserId: "33333333-3333-4333-8333-333333333333",
  senderDisplayName: "Alice",
  recipientStatus: "read",
  bodyText: "The launch date is September 14.",
  metadata: {},
  provenance: { kind: "user_message", id: "note-request" },
  createdAt: "2026-08-18T10:00:00.000Z",
  updatedAt: "2026-08-18T10:00:00.000Z"
};

describe("Personal Note memory Projection", () => {
  it("creates one idempotent embeddable Memory Event and enqueues it", async () => {
    const createMemoryEvent = vi.fn(
      async () =>
        ({
          id: "44444444-4444-4444-8444-444444444444"
        }) as Awaited<ReturnType<MemorySourceRepository["createMemoryEvent"]>>
    );
    const enqueueEmbedding = vi.fn(async () => ({
      queued: true,
      inline: false,
      jobId: "embed-note"
    }));

    const result = await projectPersonalNoteToMemory(
      {
        repository: {
          createMemoryEvent
        } as Pick<MemorySourceRepository, "createMemoryEvent">,
        enqueueEmbedding
      },
      {
        ownerUserId: "33333333-3333-4333-8333-333333333333",
        threadKind: "notes_to_self",
        message
      }
    );

    expect(createMemoryEvent).toHaveBeenCalledWith(
      { userId: "33333333-3333-4333-8333-333333333333" },
      {
        projectId: "unassigned",
        actor: "user",
        eventType: "captured",
        rawEventType: "personal_note_created",
        content: message.bodyText,
        metadata: {
          semanticUnitType: "personal_note",
          sourceAdapterVersion: "desktop-notes-v1",
          collaborationThreadId: message.threadId,
          collaborationMessageId: message.id,
          includeInEmbedding: true,
          includeInLcm: false
        },
        visibility: "personal",
        captureMethod: "api",
        idempotencyKey: `personal-note:${message.id}`,
        capturedAt: message.createdAt,
        sourceEventTime: message.createdAt,
        sourceSequence: message.threadSequence
      }
    );
    expect(enqueueEmbedding).toHaveBeenCalledWith(
      "memory_event",
      "44444444-4444-4444-8444-444444444444",
      "interactive_recall_question"
    );
    expect(result).toEqual({
      memoryEventId: "44444444-4444-4444-8444-444444444444",
      embedding: { queued: true, inline: false, jobId: "embed-note" }
    });
  });

  it("rejects a message outside the Personal owner boundary", async () => {
    const createMemoryEvent = vi.fn();
    const enqueueEmbedding = vi.fn();

    await expect(
      projectPersonalNoteToMemory(
        {
          repository: {
            createMemoryEvent
          } as Pick<MemorySourceRepository, "createMemoryEvent">,
          enqueueEmbedding
        },
        {
          ownerUserId: "55555555-5555-4555-8555-555555555555",
          threadKind: "notes_to_self",
          message
        }
      )
    ).rejects.toThrow("Personal Note owner does not match its message");
    expect(createMemoryEvent).not.toHaveBeenCalled();
    expect(enqueueEmbedding).not.toHaveBeenCalled();
  });

  it("resumes bounded history from a durable cursor and skips one malformed Note", async () => {
    let cursor: PersonalNoteProjectionCursorRecord = {
      ownerUserId: message.personalOwnerUserId!,
      threadId: message.threadId,
      lastThreadSequence: 6,
      scannedCount: 0,
      existingCount: 0,
      createdCount: 0,
      embeddingQueuedCount: 0,
      failureCount: 0,
      lastFailureCode: null,
      updatedAt: message.createdAt
    };
    const malformed = { ...message, senderUserId: null };
    const valid = {
      ...message,
      id: "66666666-6666-4666-8666-666666666666",
      threadSequence: 8
    };
    const repository = {
      getPersonalNotesThread: vi.fn(async () => ({
        id: message.threadId,
        kind: "notes_to_self",
        personalOwnerUserId: message.personalOwnerUserId
      })),
      getOrCreatePersonalNoteProjectionCursor: vi.fn(async () => cursor),
      listMessages: vi.fn(async () => ({
        messages: [malformed, valid],
        hasMore: true,
        nextBeforeSequence: 7,
        nextAfterSequence: 8
      })),
      findPersonalNoteMemoryEventId: vi.fn(async () => null),
      createMemoryEvent: vi.fn(async () => ({
        id: "77777777-7777-4777-8777-777777777777"
      })),
      advancePersonalNoteProjectionCursor: vi.fn(async (_actor, input) => {
        cursor = {
          ...cursor,
          lastThreadSequence: input.nextSequence,
          scannedCount: cursor.scannedCount + 1,
          existingCount:
            cursor.existingCount + (input.outcome === "existing" ? 1 : 0),
          createdCount:
            cursor.createdCount + (input.outcome === "created" ? 1 : 0),
          embeddingQueuedCount:
            cursor.embeddingQueuedCount + (input.embeddingQueued ? 1 : 0),
          failureCount:
            cursor.failureCount + (input.outcome === "failed" ? 1 : 0),
          lastFailureCode: input.failureCode ?? null
        };
        return cursor;
      })
    };
    const enqueueEmbedding = vi.fn(async () => ({
      queued: true,
      inline: false,
      jobId: "embed-note"
    }));

    await expect(
      reconcilePersonalNotesToMemory(
        {
          repository:
            repository as unknown as PersonalNoteMemoryReconciliationOptions["repository"],
          enqueueEmbedding
        },
        { ownerUserId: message.personalOwnerUserId!, limit: 2 }
      )
    ).resolves.toEqual({
      scanned: 2,
      existing: 0,
      created: 1,
      embeddingQueued: 1,
      failures: 1,
      hasMore: true,
      cursor: 8
    });
    expect(
      repository.advancePersonalNoteProjectionCursor
    ).toHaveBeenNthCalledWith(
      1,
      { userId: message.personalOwnerUserId },
      expect.objectContaining({
        outcome: "failed",
        failureCode: "invalid_note"
      })
    );
    expect(repository.createMemoryEvent).toHaveBeenCalledTimes(1);
  });

  it("lets concurrent reconciliation callers share durable cursor progress", async () => {
    let cursor: PersonalNoteProjectionCursorRecord = {
      ownerUserId: message.personalOwnerUserId!,
      threadId: message.threadId,
      lastThreadSequence: 6,
      scannedCount: 0,
      existingCount: 0,
      createdCount: 0,
      embeddingQueuedCount: 0,
      failureCount: 0,
      lastFailureCode: null,
      updatedAt: message.createdAt
    };
    let releaseMessagePages!: () => void;
    const messagePagesReady = new Promise<void>((resolve) => {
      releaseMessagePages = resolve;
    });
    let pageReaders = 0;
    let memoryEventCreated = false;
    const repository = {
      getPersonalNotesThread: vi.fn(async () => ({
        id: message.threadId,
        kind: "notes_to_self",
        personalOwnerUserId: message.personalOwnerUserId
      })),
      getOrCreatePersonalNoteProjectionCursor: vi.fn(async () => cursor),
      listMessages: vi.fn(async () => {
        pageReaders += 1;
        if (pageReaders === 2) releaseMessagePages();
        await messagePagesReady;
        return {
          messages: [message],
          hasMore: false,
          nextBeforeSequence: null,
          nextAfterSequence: message.threadSequence
        };
      }),
      findPersonalNoteMemoryEventId: vi.fn(async () =>
        memoryEventCreated ? "77777777-7777-4777-8777-777777777777" : null
      ),
      createMemoryEvent: vi.fn(async () => {
        memoryEventCreated = true;
        return { id: "77777777-7777-4777-8777-777777777777" };
      }),
      advancePersonalNoteProjectionCursor: vi.fn(async (_actor, input) => {
        if (cursor.lastThreadSequence !== input.expectedSequence) return null;
        cursor = { ...cursor, lastThreadSequence: input.nextSequence };
        return cursor;
      })
    };
    const options = {
      repository:
        repository as unknown as PersonalNoteMemoryReconciliationOptions["repository"],
      enqueueEmbedding: vi.fn(async () => ({
        queued: true,
        inline: false,
        jobId: "embed-note"
      }))
    };

    await expect(
      Promise.all([
        reconcilePersonalNotesToMemory(options, {
          ownerUserId: message.personalOwnerUserId!
        }),
        reconcilePersonalNotesToMemory(options, {
          ownerUserId: message.personalOwnerUserId!
        })
      ])
    ).resolves.toEqual([
      expect.objectContaining({ cursor: message.threadSequence, failures: 0 }),
      expect.objectContaining({ cursor: message.threadSequence, failures: 0 })
    ]);
    expect(
      repository.advancePersonalNoteProjectionCursor
    ).toHaveBeenCalledTimes(2);
    expect(
      repository.getOrCreatePersonalNoteProjectionCursor
    ).toHaveBeenCalledTimes(3);
  });

  it("does not advance the cursor when embedding admission asks for a retry", async () => {
    const cursor: PersonalNoteProjectionCursorRecord = {
      ownerUserId: message.personalOwnerUserId!,
      threadId: message.threadId,
      lastThreadSequence: 6,
      scannedCount: 0,
      existingCount: 0,
      createdCount: 0,
      embeddingQueuedCount: 0,
      failureCount: 0,
      lastFailureCode: null,
      updatedAt: message.createdAt
    };
    const repository = {
      getPersonalNotesThread: vi.fn(async () => ({
        id: message.threadId,
        kind: "notes_to_self",
        personalOwnerUserId: message.personalOwnerUserId
      })),
      getOrCreatePersonalNoteProjectionCursor: vi.fn(async () => cursor),
      listMessages: vi.fn(async () => ({
        messages: [message],
        hasMore: false,
        nextBeforeSequence: null,
        nextAfterSequence: message.threadSequence
      })),
      findPersonalNoteMemoryEventId: vi.fn(async () => null),
      createMemoryEvent: vi.fn(async () => ({
        id: "77777777-7777-4777-8777-777777777777"
      })),
      advancePersonalNoteProjectionCursor: vi.fn()
    };

    await expect(
      reconcilePersonalNotesToMemory(
        {
          repository:
            repository as unknown as PersonalNoteMemoryReconciliationOptions["repository"],
          enqueueEmbedding: vi.fn(async () => ({
            queued: false,
            inline: false
          }))
        },
        { ownerUserId: message.personalOwnerUserId! }
      )
    ).resolves.toMatchObject({ cursor: 6, failures: 1, hasMore: true });
    expect(
      repository.advancePersonalNoteProjectionCursor
    ).not.toHaveBeenCalled();
  });

  it("starts bounded background repair and coalesces overlapping runs", async () => {
    let releaseActors!: (actors: Array<{ userId: string }>) => void;
    const actors = new Promise<Array<{ userId: string }>>((resolve) => {
      releaseActors = resolve;
    });
    const repository = {
      listPersonalNoteProjectionActors: vi.fn(() => actors),
      getPersonalNotesThread: vi.fn(),
      getOrCreatePersonalNoteProjectionCursor: vi.fn(),
      listMessages: vi.fn(),
      findPersonalNoteMemoryEventId: vi.fn(),
      createMemoryEvent: vi.fn(),
      advancePersonalNoteProjectionCursor: vi.fn()
    };
    const service = createPersonalNoteMemoryRepairService({
      repository: repository as unknown as Parameters<
        typeof createPersonalNoteMemoryRepairService
      >[0]["repository"],
      enqueueEmbedding: vi.fn(),
      actorLimit: 3,
      noteLimit: 7,
      intervalMs: 60_000
    });

    const overlapping = service.runNow();
    expect(repository.listPersonalNoteProjectionActors).toHaveBeenCalledOnce();
    expect(repository.listPersonalNoteProjectionActors).toHaveBeenCalledWith({
      limit: 3
    });
    releaseActors([]);
    await overlapping;
    await service.close();
    await service.runNow();
    expect(repository.listPersonalNoteProjectionActors).toHaveBeenCalledOnce();
  });

  it("processes at most one bounded Note page per owner in each repair run", async () => {
    let cursor: PersonalNoteProjectionCursorRecord = {
      ownerUserId: message.personalOwnerUserId!,
      threadId: message.threadId,
      lastThreadSequence: 6,
      scannedCount: 0,
      existingCount: 0,
      createdCount: 0,
      embeddingQueuedCount: 0,
      failureCount: 0,
      lastFailureCode: null,
      updatedAt: message.createdAt
    };
    const repository = {
      listPersonalNoteProjectionActors: vi.fn(async () => [
        { userId: message.personalOwnerUserId! }
      ]),
      getPersonalNotesThread: vi.fn(async () => ({
        id: message.threadId,
        kind: "notes_to_self",
        personalOwnerUserId: message.personalOwnerUserId
      })),
      getOrCreatePersonalNoteProjectionCursor: vi.fn(async () => cursor),
      listMessages: vi.fn(async () => ({
        messages: [message],
        hasMore: true,
        nextBeforeSequence: null,
        nextAfterSequence: message.threadSequence
      })),
      findPersonalNoteMemoryEventId: vi.fn(async () => null),
      createMemoryEvent: vi.fn(async () => ({
        id: "77777777-7777-4777-8777-777777777777"
      })),
      advancePersonalNoteProjectionCursor: vi.fn(async (_actor, input) => {
        cursor = { ...cursor, lastThreadSequence: input.nextSequence };
        return cursor;
      })
    };
    const enqueueEmbedding = vi.fn(async () => ({
      queued: true,
      inline: false,
      jobId: "embed-note"
    }));
    const service = createPersonalNoteMemoryRepairService({
      repository: repository as unknown as Parameters<
        typeof createPersonalNoteMemoryRepairService
      >[0]["repository"],
      enqueueEmbedding,
      noteLimit: 7,
      intervalMs: 60_000
    });

    await service.runNow();
    await service.close();
    expect(repository.listMessages).toHaveBeenCalledOnce();
    expect(repository.listMessages).toHaveBeenCalledWith(
      { userId: message.personalOwnerUserId },
      expect.objectContaining({ limit: 7 })
    );
    expect(enqueueEmbedding).toHaveBeenCalledWith(
      "memory_event",
      "77777777-7777-4777-8777-777777777777",
      "historical_import_backfill"
    );
  });
});
