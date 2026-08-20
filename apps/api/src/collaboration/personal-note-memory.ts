import type {
  CollaborationMessageRecord,
  MemorySourceRepository
} from "@koed/db";
import type { KoedWorkClass } from "@koed/shared";

import type { MemoryJobStatus } from "../memory/jobs.js";

export interface PersonalNoteMemoryProjectionOptions {
  repository: Pick<MemorySourceRepository, "createMemoryEvent"> &
    Partial<Pick<MemorySourceRepository, "notifyPersonalNoteChanged">>;
  enqueueEmbedding(
    sourceType: "memory_event",
    sourceId: string,
    workClass?: KoedWorkClass
  ): Promise<MemoryJobStatus>;
}

export interface PersonalNoteMemoryReconciliationOptions {
  repository: Pick<
    MemorySourceRepository,
    | "createMemoryEvent"
    | "findPersonalNoteMemoryEventId"
    | "listThreads"
    | "listMessages"
    | "getOrCreatePersonalNoteProjectionCursor"
    | "advancePersonalNoteProjectionCursor"
  >;
  enqueueEmbedding(
    sourceType: "memory_event",
    sourceId: string,
    workClass?: KoedWorkClass
  ): Promise<MemoryJobStatus>;
}

export interface PersonalNoteMemoryReconciliationResult {
  scanned: number;
  existing: number;
  created: number;
  embeddingQueued: number;
  failures: number;
  hasMore: boolean;
  cursor: number;
}

export const projectPersonalNoteToMemory = async (
  options: PersonalNoteMemoryProjectionOptions,
  input: {
    ownerUserId: string;
    threadKind: "notes_to_self";
    message: CollaborationMessageRecord;
  }
): Promise<{ memoryEventId: string; embedding: MemoryJobStatus }> => {
  if (
    input.message.scope !== "personal" ||
    input.message.personalOwnerUserId !== input.ownerUserId ||
    input.message.senderKind !== "user" ||
    input.message.senderUserId !== input.ownerUserId
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
  await options.repository
    .notifyPersonalNoteChanged?.(
      { userId: input.ownerUserId },
      input.message.id,
      "INSERT"
    )
    .catch(() => undefined);
  const embedding = await options.enqueueEmbedding(
    "memory_event",
    event.id,
    "interactive_recall_question"
  );
  return { memoryEventId: event.id, embedding };
};

export const reconcilePersonalNotesToMemory = async (
  options: PersonalNoteMemoryReconciliationOptions,
  input: { ownerUserId: string; limit?: number }
): Promise<PersonalNoteMemoryReconciliationResult> => {
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 50)));
  const actor = { userId: input.ownerUserId };
  const threads = await options.repository.listThreads(actor, {
    scope: "personal",
    includeArchived: true,
    limit: 100
  });
  const notesThread = threads?.find(
    (thread) =>
      thread.kind === "notes_to_self" &&
      thread.personalOwnerUserId === input.ownerUserId
  );
  if (!notesThread) {
    return {
      scanned: 0,
      existing: 0,
      created: 0,
      embeddingQueued: 0,
      failures: 0,
      hasMore: false,
      cursor: 0
    };
  }
  let durable =
    await options.repository.getOrCreatePersonalNoteProjectionCursor(actor, {
      threadId: notesThread.id
    });
  if (!durable)
    throw new Error("Personal Note Projection cursor is unavailable");
  const page = await options.repository.listMessages(actor, {
    threadId: notesThread.id,
    afterSequence: durable.lastThreadSequence,
    limit
  });
  if (!page) throw new Error("Personal Note history is unavailable");

  let existing = 0;
  let created = 0;
  let embeddingQueued = 0;
  let failures = 0;
  let scanned = 0;
  for (const message of page.messages) {
    scanned += 1;
    let outcome: "existing" | "created" | "failed" = "failed";
    let queued = false;
    let failureCode: string | undefined;
    try {
      const prior = await options.repository.findPersonalNoteMemoryEventId(
        actor,
        message.id
      );
      const projection = await projectPersonalNoteToMemory(options, {
        ownerUserId: input.ownerUserId,
        threadKind: "notes_to_self",
        message
      });
      outcome = prior ? "existing" : "created";
      queued = projection.embedding.queued;
      if (!queued) {
        failures += 1;
        break;
      }
      if (outcome === "existing") existing += 1;
      else created += 1;
      if (queued) embeddingQueued += 1;
    } catch (error) {
      failures += 1;
      if (!(error instanceof TypeError)) break;
      failureCode = "invalid_note";
    }
    const advanced =
      await options.repository.advancePersonalNoteProjectionCursor(actor, {
        threadId: notesThread.id,
        expectedSequence: durable.lastThreadSequence,
        nextSequence: message.threadSequence,
        outcome,
        embeddingQueued: queued,
        ...(failureCode ? { failureCode } : {})
      });
    if (!advanced) {
      throw new Error("Personal Note Projection cursor changed concurrently");
    }
    durable = advanced;
  }

  return {
    scanned,
    existing,
    created,
    embeddingQueued,
    failures,
    hasMore: page.hasMore || scanned < page.messages.length,
    cursor: durable.lastThreadSequence
  };
};

export const drainPersonalNotesToMemory = async (
  options: PersonalNoteMemoryReconciliationOptions,
  input: { ownerUserId: string; maxBatches?: number }
): Promise<void> => {
  const maxBatches = Math.max(
    1,
    Math.min(100, Math.trunc(input.maxBatches ?? 100))
  );
  let previousCursor = -1;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await reconcilePersonalNotesToMemory(options, {
      ownerUserId: input.ownerUserId,
      limit: 100
    });
    if (!result.hasMore || result.cursor <= previousCursor) return;
    previousCursor = result.cursor;
  }
};
