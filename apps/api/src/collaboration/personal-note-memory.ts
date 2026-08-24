import type {
  CollaborationRepository,
  MemorySourceRepository,
  PersonalNoteRecord
} from "@koed/db";
import type { KoedWorkClass } from "@koed/shared";

import type { MemoryJobStatus } from "../memory/jobs.js";

type PersonalNoteProjectionRepository = Pick<
  MemorySourceRepository,
  "createMemoryEvent"
> &
  Pick<
    CollaborationRepository,
    | "getPersonalNote"
    | "listPendingPersonalNoteRevisions"
    | "markPersonalNoteProjectionAvailable"
    | "markPersonalNoteProjectionFailed"
  > &
  Partial<Pick<MemorySourceRepository, "notifyPersonalNoteChanged">>;

export interface PersonalNoteMemoryProjectionOptions {
  repository: PersonalNoteProjectionRepository;
  enqueueEmbedding(
    sourceType: "memory_event",
    sourceId: string,
    workClass?: KoedWorkClass
  ): Promise<MemoryJobStatus>;
  requestContinuousShareAdvancement?(): void;
}

export interface PersonalNoteMemoryRepairOptions extends PersonalNoteMemoryProjectionOptions {
  intervalMs?: number;
  revisionLimit?: number;
  onError?(error: unknown): void;
}

export interface PersonalNoteMemoryRepairService {
  runNow(): Promise<void>;
  close(): Promise<void>;
}

export interface PersonalNoteMemoryReconciliationResult {
  scanned: number;
  projected: number;
  failures: number;
  embeddingQueued: number;
  hasMore: boolean;
}

export const projectPersonalNoteToMemory = async (
  options: PersonalNoteMemoryProjectionOptions,
  input: {
    ownerUserId: string;
    note: PersonalNoteRecord;
    workClass?: KoedWorkClass;
  }
): Promise<{ memoryEventId: string; embedding: MemoryJobStatus }> => {
  const { note } = input;
  if (note.projectionState === "superseded") {
    throw new TypeError(
      "A superseded Personal Note revision cannot be projected"
    );
  }
  const event = await options.repository.createMemoryEvent(
    { userId: input.ownerUserId },
    {
      projectId: "unassigned",
      actor: "user",
      eventType: "captured",
      rawEventType: "personal_note_revision",
      content: note.body,
      metadata: {
        semanticUnitType: "personal_note",
        sourceAdapterVersion: "desktop-notes-v2",
        personalNoteId: note.noteId,
        personalNoteRevisionId: note.revisionId,
        personalNoteRevision: note.revision,
        personalNoteContentHash: note.contentHash,
        includeInEmbedding: true,
        includeInLcm: false
      },
      visibility: "personal",
      captureMethod: "api",
      idempotencyKey: `personal-note:${note.noteId}:revision:${note.revision}`,
      capturedAt: note.updatedAt,
      sourceEventTime: note.updatedAt,
      sourceSequence: note.sourceSequence
    }
  );
  const projected =
    await options.repository.markPersonalNoteProjectionAvailable(
      { userId: input.ownerUserId },
      {
        noteId: note.noteId,
        revision: note.revision,
        memoryEventId: event.id
      }
    );
  if (!projected) {
    throw new Error("Personal Note advanced while its revision was projected");
  }
  const embedding = await options.enqueueEmbedding(
    "memory_event",
    event.id,
    input.workClass ?? "interactive_recall_question"
  );
  options.requestContinuousShareAdvancement?.();
  await options.repository
    .notifyPersonalNoteChanged?.(
      { userId: input.ownerUserId },
      note.noteId,
      "UPDATE"
    )
    .catch(() => undefined);
  return { memoryEventId: event.id, embedding };
};

export const reconcilePersonalNotesToMemory = async (
  options: PersonalNoteMemoryProjectionOptions,
  input: { limit?: number }
): Promise<PersonalNoteMemoryReconciliationResult> => {
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 50)));
  const pending = await options.repository.listPendingPersonalNoteRevisions({
    limit
  });
  let projected = 0;
  let failures = 0;
  let embeddingQueued = 0;
  for (const candidate of pending) {
    try {
      const note = await options.repository.getPersonalNote(
        { userId: candidate.ownerUserId },
        { noteId: candidate.noteId }
      );
      if (!note || note.revision !== candidate.revision) continue;
      const result = await projectPersonalNoteToMemory(options, {
        ownerUserId: candidate.ownerUserId,
        note,
        workClass: "historical_import_backfill"
      });
      projected += 1;
      if (result.embedding.queued) embeddingQueued += 1;
    } catch (error) {
      failures += 1;
      await options.repository.markPersonalNoteProjectionFailed(
        { userId: candidate.ownerUserId },
        {
          noteId: candidate.noteId,
          revision: candidate.revision,
          failureCode:
            error instanceof TypeError ? "invalid_note" : "projection_failed"
        }
      );
    }
  }
  return {
    scanned: pending.length,
    projected,
    failures,
    embeddingQueued,
    hasMore: pending.length === limit
  };
};

export const createPersonalNoteMemoryRepairService = (
  options: PersonalNoteMemoryRepairOptions
): PersonalNoteMemoryRepairService => {
  const intervalMs = Math.max(100, Math.trunc(options.intervalMs ?? 5_000));
  const revisionLimit = Math.max(
    1,
    Math.min(100, Math.trunc(options.revisionLimit ?? 100))
  );
  let closed = false;
  let running: Promise<void> | null = null;

  const runNow = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (running) return running;
    running = reconcilePersonalNotesToMemory(options, {
      limit: revisionLimit
    })
      .then(() => undefined)
      .catch((error: unknown) => options.onError?.(error))
      .finally(() => {
        running = null;
      });
    return running;
  };

  const timer = setInterval(() => void runNow(), intervalMs);
  timer.unref();
  void runNow();

  return {
    runNow,
    async close() {
      closed = true;
      clearInterval(timer);
      await running;
    }
  };
};
