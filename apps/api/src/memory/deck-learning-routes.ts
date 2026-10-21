import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type {
  CollaborationRepository,
  createFlashcardDeckRepository
} from "@koed/db";
import type { ApiRouteContext } from "../server/context.js";
import { authenticateProjectOperation } from "../projects/desktop-read-auth.js";

const params = z
  .object({ projectId: z.uuid(), deckId: z.uuid(), cardId: z.uuid() })
  .strict();
const body = z
  .object({
    mode: z.enum(["begin", "reconcile"]),
    expectedDeckVersion: z.number().int().positive(),
    expectedCardVersion: z.number().int().positive()
  })
  .strict();
type Notes = Pick<
  CollaborationRepository,
  "createPersonalNote" | "findPersonalNoteByIdempotencyKey" | "getPersonalNote"
>;
export const deckLearningClaim = (question: string) =>
  `Needs another look: ${question.slice(0, 3900)}`;

/** The fixed owner/Card Note is preserved after edits and lost responses. */
export async function ensureDeckLearning(input: {
  context: ApiRouteContext;
  notes: Notes;
  ownerId: string;
  cardId: string;
  question: string;
  sourceKey: string;
  mode: "begin" | "reconcile";
}) {
  const actor = { userId: input.ownerId };
  const idempotencyKey = `deck-again:${input.sourceKey}:${input.cardId}`;
  let note = await input.notes.findPersonalNoteByIdempotencyKey(actor, {
    idempotencyKey
  });
  if (!note) {
    if (input.mode === "reconcile")
      return { proposalId: null, status: "retry_needed" as const };
    note = await input.notes.createPersonalNote(actor, {
      body: deckLearningClaim(input.question),
      idempotencyKey
    });
  }
  if (
    note.revision !== 1 ||
    !note.body.startsWith("Needs another look: ") ||
    note.body.length > 4000
  )
    throw Object.assign(new Error("First Again evidence changed"), {
      statusCode: 409
    });
  await input.context.collaboration
    .projectPersonalNote?.({ ownerUserId: input.ownerId, note })
    .catch(() => undefined);
  const current = await input.notes.getPersonalNote(actor, {
    noteId: note.noteId
  });
  if (!current || current.revision !== 1 || current.body !== note.body)
    throw Object.assign(new Error("First Again evidence is unavailable"), {
      statusCode: 409
    });
  if (current.projectionState !== "available" || !current.memoryEventId)
    return { proposalId: null, status: "projection_pending" as const };
  const proposal = await input.context
    .requireRepository()
    .createDeckLearningProposal(actor, {
      noteId: current.noteId,
      memoryEventId: current.memoryEventId,
      claim: current.body
    });
  return { proposalId: proposal.id, status: proposal.status };
}

export function registerDeckLearningRoutes(
  app: FastifyInstance,
  context: ApiRouteContext,
  notes: Notes | null,
  decks: Pick<
    ReturnType<typeof createFlashcardDeckRepository>,
    "progress" | "getPersonal"
  > | null
) {
  app.post(
    "/v1/projects/:projectId/decks/:deckId/cards/:cardId/learning",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      if (!request.headers.authorization?.trim().startsWith("Koed-Desktop "))
        throw Object.assign(
          new Error("Deck learning requires Desktop owner authority"),
          { statusCode: 403 }
        );
      const actor = await authenticateProjectOperation(
        request,
        {
          deploymentProfile: context.config.deploymentProfile,
          koedHome: context.config.koedHome,
          auth: context.auth
        },
        true
      );
      if (!notes || !decks)
        throw Object.assign(new Error("Personal Deck learning unavailable"), {
          statusCode: 503
        });
      const { projectId, deckId, cardId } = params.parse(request.params);
      const { mode, expectedDeckVersion, expectedCardVersion } = body.parse(
        request.body
      );
      const deck = await decks.getPersonal(actor.id, projectId, deckId);
      const card = deck.cards.find((item) => item.id === cardId);
      if (
        mode === "begin" &&
        (deck.version !== expectedDeckVersion ||
          card?.version !== expectedCardVersion)
      )
        throw Object.assign(new Error("Deck Card changed before first Again"), {
          statusCode: 409
        });
      const progress = await decks.progress(actor.id, projectId);
      if (!card || progress.link.teamBackendId)
        throw Object.assign(new Error("Deck Card is unavailable"), {
          statusCode: 409
        });
      return ensureDeckLearning({
        context,
        notes,
        ownerId: actor.id,
        cardId,
        question: card.question,
        sourceKey: `${projectId}:personal`,
        mode
      });
    }
  );
}
