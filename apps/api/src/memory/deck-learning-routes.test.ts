import { describe, expect, it, vi } from "vitest";
import type { PersonalNoteRecord } from "@koed/db";
import type { ApiRouteContext } from "../server/context.js";
import { ensureDeckLearning } from "./deck-learning-routes.js";

const ownerId = "00000000-0000-4000-8000-000000000801";
const cardId = "00000000-0000-4000-8000-000000000803";
const noteId = "00000000-0000-4000-8000-000000000804";
const eventId = "00000000-0000-4000-8000-000000000805";
const note: PersonalNoteRecord = {
  noteId,
  logicalMemoryId: noteId,
  title: "Personal Note",
  titleVersion: 1,
  revisionId: noteId,
  contentHash: "a".repeat(64),
  projectionFailureCode: null,
  createdAt: "2026-10-21T10:00:00.000Z",
  updatedAt: "2026-10-21T10:00:00.000Z",
  sourceSequence: 1,
  body: "Needs another look: Original question",
  revision: 1,
  projectionState: "available",
  memoryEventId: eventId
};

describe("Deck Again evidence", () => {
  it("creates one source-backed Me learning proposal and preserves original Note after card edits", async () => {
    let stored: typeof note | null = null;
    const createPersonalNote = vi.fn(
      async (_actor, input: { body: string; idempotencyKey: string }) => {
        stored = { ...note, body: input.body };
        return stored;
      }
    );
    const findPersonalNoteByIdempotencyKey = vi.fn(async () => stored);
    const getPersonalNote = vi.fn(async () => stored);
    const createDeckLearningProposal = vi.fn(
      async (_actor, input: { claim: string }) => {
        expect(input.claim).toBe(note.body);
        return { id: eventId, status: "pending" };
      }
    );
    const context = {
      collaboration: { projectPersonalNote: vi.fn(async () => {}) },
      requireRepository: () => ({ createDeckLearningProposal })
    } as unknown as ApiRouteContext;
    const input = {
      context,
      notes: {
        createPersonalNote,
        findPersonalNoteByIdempotencyKey,
        getPersonalNote
      },
      ownerId,
      cardId,
      sourceKey: `${ownerId}:personal`
    };
    await expect(
      ensureDeckLearning({
        ...input,
        question: "Original question",
        mode: "begin"
      })
    ).resolves.toMatchObject({ status: "pending" });
    await expect(
      ensureDeckLearning({
        ...input,
        question: "Edited later",
        mode: "reconcile"
      })
    ).resolves.toMatchObject({ status: "pending" });
    expect(createPersonalNote).toHaveBeenCalledTimes(1);
    expect(createPersonalNote.mock.calls[0]?.[1]).toMatchObject({
      body: note.body,
      idempotencyKey: `deck-again:${ownerId}:personal:${cardId}`
    });
    expect(createDeckLearningProposal).toHaveBeenCalledTimes(2);
  });

  it("does not invent learning on a read-side retry without an existing Again Note", async () => {
    const createPersonalNote = vi.fn();
    const context = {
      collaboration: {},
      requireRepository: vi.fn()
    } as unknown as ApiRouteContext;
    await expect(
      ensureDeckLearning({
        context,
        notes: {
          createPersonalNote,
          findPersonalNoteByIdempotencyKey: async () => null,
          getPersonalNote: vi.fn()
        },
        ownerId,
        cardId,
        question: "Question",
        sourceKey: `${ownerId}:personal`,
        mode: "reconcile"
      })
    ).resolves.toEqual({ proposalId: null, status: "retry_needed" });
    expect(createPersonalNote).not.toHaveBeenCalled();
  });
});
