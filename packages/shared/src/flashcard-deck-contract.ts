import { z } from "zod";

export const deckCardContentSchema = z
  .object({
    question: z.string().trim().min(1).max(4000),
    answer: z.string().trim().min(1).max(16000),
    sourceRef: z.string().trim().max(2048).nullable().optional(),
    topicLabel: z.string().trim().max(240).nullable().optional()
  })
  .strict();

export const createDeckSchema = z
  .object({
    idempotencyKey: z.uuid(),
    title: z.string().trim().min(1).max(500),
    scope: z.string().trim().max(2000),
    madeFrom: z.string().trim().max(4000),
    createdByAgentId: z.uuid().nullable().optional(),
    cards: z.array(deckCardContentSchema).min(1).max(500)
  })
  .strict();

export const createTeamDeckSchema = createDeckSchema.omit({
  createdByAgentId: true
});
export const patchDeckSchema = createDeckSchema
  .omit({ cards: true, createdByAgentId: true, idempotencyKey: true })
  .partial()
  .extend({ expectedVersion: z.number().int().positive().max(2147483647) })
  .strict();
export const patchDeckCardSchema = deckCardContentSchema
  .partial()
  .extend({ expectedVersion: z.number().int().positive().max(2147483647) })
  .strict();
export const deckCardSchema = deckCardContentSchema
  .required()
  .extend({
    id: z.uuid(),
    deckId: z.uuid(),
    version: z.number().int().positive().max(2147483647),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true })
  })
  .strict();
export const deckSchema = createDeckSchema
  .omit({ cards: true, idempotencyKey: true })
  .extend({
    id: z.uuid(),
    projectId: z.uuid(),
    uses: z.number().int().nonnegative().max(2147483647),
    version: z.number().int().positive().max(2147483647),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    cards: z.array(deckCardSchema)
  })
  .strict();
export const deckListSchema = z.object({ decks: z.array(deckSchema) }).strict();
export const deckProgressSchema = z
  .object({
    cardId: z.uuid(),
    box: z.number().int().nonnegative().max(2147483647),
    nextAt: z.iso.datetime({ offset: true }).nullable(),
    misses: z.number().int().nonnegative().max(2147483647)
  })
  .strict();
export const putDeckProgressSchema = deckProgressSchema.omit({ cardId: true });
export const deckProgressListSchema = z
  .object({ progress: z.array(deckProgressSchema) })
  .strict();
export type CreateDeck = z.infer<typeof createDeckSchema>;
export type CreateTeamDeck = z.infer<typeof createTeamDeckSchema>;
export type Deck = z.infer<typeof deckSchema>;
