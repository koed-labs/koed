import type {
  CollaborationRepository,
  MemorySourceRepository,
  PersonalNoteRecord
} from "@koed/db";
import { describe, expect, it, vi } from "vitest";

import {
  createPersonalNoteMemoryRepairService,
  projectPersonalNoteToMemory,
  reconcilePersonalNotesToMemory
} from "./personal-note-memory.js";

const ownerUserId = "33333333-3333-4333-8333-333333333333";
const note: PersonalNoteRecord = {
  noteId: "11111111-1111-4111-8111-111111111111",
  logicalMemoryId: "55555555-5555-4555-8555-555555555555",
  title: "Launch date",
  titleVersion: 1,
  body: "The launch date is September 14.",
  revisionId: "22222222-2222-4222-8222-222222222222",
  revision: 2,
  contentHash: "a".repeat(64),
  memoryEventId: null,
  projectionState: "pending",
  projectionFailureCode: null,
  createdAt: "2026-08-18T10:00:00.000Z",
  updatedAt: "2026-08-18T10:05:00.000Z",
  sourceSequence: 7
};

const projectedNote: PersonalNoteRecord = {
  ...note,
  memoryEventId: "44444444-4444-4444-8444-444444444444",
  projectionState: "available"
};

describe("Personal Note memory Projection", () => {
  it("projects the exact revision and queues its embedding", async () => {
    const createMemoryEvent = vi.fn(async () => ({
      id: projectedNote.memoryEventId
    }));
    const markPersonalNoteProjectionAvailable = vi.fn(
      async () => projectedNote
    );
    const getPersonalNote = vi.fn(async () => projectedNote);
    const listPendingPersonalNoteRevisions = vi.fn(async () => []);
    const markPersonalNoteProjectionFailed = vi.fn(async () => projectedNote);
    const notifyPersonalNoteChanged = vi.fn(async () => undefined);
    const enqueueEmbedding = vi.fn(async () => ({
      queued: true,
      inline: false,
      jobId: "embed-note"
    }));
    const requestContinuousShareAdvancement = vi.fn();

    await expect(
      projectPersonalNoteToMemory(
        {
          repository: {
            createMemoryEvent,
            getPersonalNote,
            listPendingPersonalNoteRevisions,
            markPersonalNoteProjectionAvailable,
            markPersonalNoteProjectionFailed,
            notifyPersonalNoteChanged
          } as unknown as Pick<MemorySourceRepository, "createMemoryEvent"> &
            Pick<
              CollaborationRepository,
              | "getPersonalNote"
              | "listPendingPersonalNoteRevisions"
              | "markPersonalNoteProjectionAvailable"
              | "markPersonalNoteProjectionFailed"
            >,
          enqueueEmbedding,
          requestContinuousShareAdvancement
        },
        { ownerUserId, note }
      )
    ).resolves.toEqual({
      memoryEventId: projectedNote.memoryEventId,
      embedding: { queued: true, inline: false, jobId: "embed-note" }
    });

    expect(createMemoryEvent).toHaveBeenCalledWith(
      { userId: ownerUserId },
      expect.objectContaining({
        rawEventType: "personal_note_revision",
        content: note.body,
        idempotencyKey: `personal-note:${note.noteId}:revision:${note.revision}`,
        sourceSequence: note.sourceSequence,
        metadata: expect.objectContaining({
          personalNoteId: note.noteId,
          personalNoteRevisionId: note.revisionId,
          personalNoteRevision: note.revision,
          personalNoteContentHash: note.contentHash,
          includeInEmbedding: true,
          includeInLcm: false
        })
      })
    );
    expect(enqueueEmbedding).toHaveBeenCalledWith(
      "memory_event",
      projectedNote.memoryEventId,
      "interactive_recall_question"
    );
    expect(markPersonalNoteProjectionAvailable).toHaveBeenCalledWith(
      { userId: ownerUserId },
      {
        noteId: note.noteId,
        revision: note.revision,
        memoryEventId: projectedNote.memoryEventId
      }
    );
    expect(notifyPersonalNoteChanged).toHaveBeenCalledWith(
      { userId: ownerUserId },
      note.noteId,
      "UPDATE"
    );
    expect(requestContinuousShareAdvancement).toHaveBeenCalledOnce();
  });

  it("does not project a superseded revision", async () => {
    const createMemoryEvent = vi.fn();
    const enqueueEmbedding = vi.fn();

    await expect(
      projectPersonalNoteToMemory(
        {
          repository: {
            createMemoryEvent
          } as unknown as Parameters<
            typeof projectPersonalNoteToMemory
          >[0]["repository"],
          enqueueEmbedding
        },
        { ownerUserId, note: { ...note, projectionState: "superseded" } }
      )
    ).rejects.toThrow("superseded Personal Note revision");
    expect(createMemoryEvent).not.toHaveBeenCalled();
    expect(enqueueEmbedding).not.toHaveBeenCalled();
  });

  it("does not enqueue an embedding when the revision advances during projection", async () => {
    const createMemoryEvent = vi.fn(async () => ({
      id: projectedNote.memoryEventId
    }));
    const markPersonalNoteProjectionAvailable = vi.fn(async () => null);
    const enqueueEmbedding = vi.fn();

    await expect(
      projectPersonalNoteToMemory(
        {
          repository: {
            createMemoryEvent,
            markPersonalNoteProjectionAvailable
          } as unknown as Parameters<
            typeof projectPersonalNoteToMemory
          >[0]["repository"],
          enqueueEmbedding
        },
        { ownerUserId, note }
      )
    ).rejects.toThrow("advanced while its revision was projected");
    expect(enqueueEmbedding).not.toHaveBeenCalled();
  });

  it("repairs a bounded pending revision set and records isolated failures", async () => {
    const failedNote = {
      ...note,
      noteId: "55555555-5555-4555-8555-555555555555",
      revisionId: "66666666-6666-4666-8666-666666666666"
    };
    const repository = {
      listPendingPersonalNoteRevisions: vi.fn(async () => [
        { ownerUserId, noteId: note.noteId, revision: note.revision },
        {
          ownerUserId,
          noteId: failedNote.noteId,
          revision: failedNote.revision
        }
      ]),
      getPersonalNote: vi.fn(async (_actor, input) =>
        input.noteId === note.noteId ? note : failedNote
      ),
      createMemoryEvent: vi
        .fn()
        .mockResolvedValueOnce({ id: projectedNote.memoryEventId })
        .mockRejectedValueOnce(new Error("storage unavailable")),
      markPersonalNoteProjectionAvailable: vi.fn(async () => projectedNote),
      markPersonalNoteProjectionFailed: vi.fn(async () => undefined)
    };
    const enqueueEmbedding = vi.fn(async () => ({
      queued: true,
      inline: false,
      jobId: "embed-note"
    }));

    await expect(
      reconcilePersonalNotesToMemory(
        {
          repository: repository as unknown as Parameters<
            typeof reconcilePersonalNotesToMemory
          >[0]["repository"],
          enqueueEmbedding
        },
        { limit: 2 }
      )
    ).resolves.toEqual({
      scanned: 2,
      projected: 1,
      failures: 1,
      embeddingQueued: 1,
      hasMore: true
    });
    expect(repository.listPendingPersonalNoteRevisions).toHaveBeenCalledWith({
      limit: 2
    });
    expect(repository.markPersonalNoteProjectionFailed).toHaveBeenCalledWith(
      { userId: ownerUserId },
      {
        noteId: failedNote.noteId,
        revision: failedNote.revision,
        failureCode: "projection_failed"
      }
    );
  });

  it("coalesces overlapping bounded repair runs", async () => {
    let release!: (value: Array<never>) => void;
    const pending = new Promise<Array<never>>((resolve) => {
      release = resolve;
    });
    const repository = {
      listPendingPersonalNoteRevisions: vi.fn(() => pending),
      getPersonalNote: vi.fn(),
      createMemoryEvent: vi.fn(),
      markPersonalNoteProjectionAvailable: vi.fn(),
      markPersonalNoteProjectionFailed: vi.fn()
    };
    const service = createPersonalNoteMemoryRepairService({
      repository: repository as unknown as Parameters<
        typeof createPersonalNoteMemoryRepairService
      >[0]["repository"],
      enqueueEmbedding: vi.fn(),
      revisionLimit: 7,
      intervalMs: 60_000
    });

    const overlapping = service.runNow();
    expect(repository.listPendingPersonalNoteRevisions).toHaveBeenCalledOnce();
    expect(repository.listPendingPersonalNoteRevisions).toHaveBeenCalledWith({
      limit: 7
    });
    release([]);
    await overlapping;
    await service.close();
    await service.runNow();
    expect(repository.listPendingPersonalNoteRevisions).toHaveBeenCalledOnce();
  });
});
