import type {
  CollaborationMessageRecord,
  MemoryEventRecord,
  MemorySourceRepository
} from "@koed/db";
import { describe, expect, it, vi } from "vitest";

import { projectPersonalNoteToMemory } from "./personal-note-memory.js";

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
        }) as MemoryEventRecord
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
      "44444444-4444-4444-8444-444444444444"
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
          message
        }
      )
    ).rejects.toThrow("Personal Note owner does not match its message");
    expect(createMemoryEvent).not.toHaveBeenCalled();
    expect(enqueueEmbedding).not.toHaveBeenCalled();
  });
});
