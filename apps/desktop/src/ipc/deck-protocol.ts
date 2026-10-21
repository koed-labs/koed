import { z } from "zod";
import {
  deckListSchema,
  deckSchema,
  deckProgressListSchema,
  deckProgressSchema
} from "@koed/shared/flashcard-deck-contract";

export const deckCommandChannel = "koed:decks:command";
const identity = z.object({ projectId: z.uuid() }).strict();
export const deckRequestSchema = z.discriminatedUnion("operation", [
  identity.extend({ operation: z.literal("list") }).strict(),
  identity.extend({ operation: z.literal("open"), deckId: z.uuid() }).strict(),
  identity
    .extend({ operation: z.literal("progress"), deckId: z.uuid() })
    .strict(),
  identity
    .extend({
      operation: z.literal("learning"),
      deckId: z.uuid(),
      cardId: z.uuid()
    })
    .strict(),
  identity
    .extend({
      operation: z.literal("grade"),
      deckId: z.uuid(),
      cardId: z.uuid(),
      rating: z.enum(["again", "good", "easy"]),
      expectedBox: z.number().int().nonnegative(),
      expectedMisses: z.number().int().nonnegative(),
      expectedDeckVersion: z.number().int().positive(),
      expectedCardVersion: z.number().int().positive()
    })
    .strict()
]);
export type DeckRequest = z.infer<typeof deckRequestSchema>;
export const deckResultSchema = z.discriminatedUnion("operation", [
  identity
    .extend({ operation: z.literal("list"), value: deckListSchema })
    .strict(),
  identity
    .extend({
      operation: z.literal("open"),
      deckId: z.uuid(),
      value: deckSchema
    })
    .strict(),
  identity
    .extend({
      operation: z.literal("progress"),
      deckId: z.uuid(),
      value: deckProgressListSchema
    })
    .strict(),
  identity
    .extend({
      operation: z.literal("learning"),
      deckId: z.uuid(),
      cardId: z.uuid(),
      status: z.enum([
        "projection_pending",
        "pending",
        "stored",
        "merged",
        "superseded",
        "conflicted",
        "skipped",
        "retry_needed"
      ])
    })
    .strict(),
  identity
    .extend({
      operation: z.literal("grade"),
      deckId: z.uuid(),
      cardId: z.uuid(),
      value: deckProgressSchema,
      learningStatus: z.enum([
        "projection_pending",
        "pending",
        "stored",
        "merged",
        "superseded",
        "conflicted",
        "skipped",
        "not_applicable",
        "retry_needed"
      ])
    })
    .strict()
]);
export type DeckResult = z.infer<typeof deckResultSchema>;
export interface DeckDesktopApi {
  list(projectId: string): Promise<z.infer<typeof deckListSchema>>;
  open(projectId: string, deckId: string): Promise<z.infer<typeof deckSchema>>;
  progress(
    projectId: string,
    deckId: string
  ): Promise<z.infer<typeof deckProgressListSchema>>;
  learning(
    projectId: string,
    deckId: string,
    cardId: string
  ): Promise<
    | "projection_pending"
    | "pending"
    | "stored"
    | "merged"
    | "superseded"
    | "conflicted"
    | "skipped"
    | "retry_needed"
  >;
  grade(
    projectId: string,
    deckId: string,
    cardId: string,
    rating: "again" | "good" | "easy",
    expectedBox: number,
    expectedMisses: number,
    expectedDeckVersion: number,
    expectedCardVersion: number
  ): Promise<{
    progress: z.infer<typeof deckProgressSchema>;
    learningStatus:
      | "projection_pending"
      | "pending"
      | "stored"
      | "merged"
      | "superseded"
      | "conflicted"
      | "skipped"
      | "not_applicable"
      | "retry_needed";
  }>;
}
