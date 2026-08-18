import type {
  CollaborationMessageRecord,
  MemorySourceRepository
} from "@koed/db";

import type { MemoryJobStatus } from "../memory/jobs.js";

export interface PersonalNoteMemoryProjectionOptions {
  repository: Pick<MemorySourceRepository, "createMemoryEvent">;
  enqueueEmbedding(
    sourceType: "memory_event",
    sourceId: string
  ): Promise<MemoryJobStatus>;
}

export const projectPersonalNoteToMemory = async (
  options: PersonalNoteMemoryProjectionOptions,
  input: {
    ownerUserId: string;
    message: CollaborationMessageRecord;
  }
): Promise<{ memoryEventId: string; embedding: MemoryJobStatus }> => {
  if (
    input.message.scope !== "personal" ||
    input.message.personalOwnerUserId !== input.ownerUserId
  ) {
    throw new TypeError("Personal Note owner does not match its message");
  }
  const event = await options.repository.createMemoryEvent(
    { userId: input.ownerUserId },
    {
      projectId: "unassigned",
      actor: "user",
      eventType: "captured",
      rawEventType: "personal_note_created",
      content: input.message.bodyText,
      metadata: {
        semanticUnitType: "personal_note",
        sourceAdapterVersion: "desktop-notes-v1",
        collaborationThreadId: input.message.threadId,
        collaborationMessageId: input.message.id,
        includeInEmbedding: true,
        includeInLcm: false
      },
      visibility: "personal",
      captureMethod: "api",
      idempotencyKey: `personal-note:${input.message.id}`,
      capturedAt: input.message.createdAt,
      sourceEventTime: input.message.createdAt,
      sourceSequence: input.message.threadSequence
    }
  );
  const embedding = await options.enqueueEmbedding("memory_event", event.id);
  return { memoryEventId: event.id, embedding };
};
