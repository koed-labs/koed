import { z } from "zod";
import { koedTextActionProjectionSchema } from "@koed/shared/koed-text-action-contract";

export const managedTextActionChannel = "koed:managed-text-action:command";
export const managedTextActionRequestSchema = z.discriminatedUnion(
  "operation",
  [
    z.object({ operation: z.literal("list"), executionId: z.uuid() }).strict(),
    z
      .object({
        operation: z.literal("get"),
        executionId: z.uuid(),
        actionId: z.uuid()
      })
      .strict(),
    z
      .object({
        operation: z.literal("review"),
        executionId: z.uuid(),
        actionId: z.uuid(),
        expectedRevision: z.number().int().positive(),
        decision: z.enum(["approve", "decline"])
      })
      .strict(),
    z
      .object({
        operation: z.literal("claim"),
        executionId: z.uuid(),
        actionId: z.uuid(),
        expectedRevision: z.number().int().positive()
      })
      .strict(),
    z
      .object({
        operation: z.literal("complete"),
        executionId: z.uuid(),
        actionId: z.uuid(),
        expectedRevision: z.number().int().positive()
      })
      .strict(),
    z
      .object({
        operation: z.literal("apply-team-todo-add"),
        executionId: z.uuid(),
        actionId: z.uuid(),
        expectedRevision: z.number().int().positive()
      })
      .strict(),
    z
      .object({
        operation: z.literal("apply-deck-make"),
        executionId: z.uuid(),
        actionId: z.uuid(),
        expectedRevision: z.number().int().positive()
      })
      .strict(),
    z
      .object({
        operation: z.literal("deck-result"),
        executionId: z.uuid(),
        actionId: z.uuid()
      })
      .strict()
  ]
);
export type ManagedTextActionRequest = z.infer<
  typeof managedTextActionRequestSchema
>;
export const managedTextActionResultSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("list"),
      executionId: z.uuid(),
      actions: z.array(koedTextActionProjectionSchema).max(100)
    })
    .strict(),
  z
    .object({
      operation: z.literal("get"),
      executionId: z.uuid(),
      action: koedTextActionProjectionSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("review"),
      executionId: z.uuid(),
      action: koedTextActionProjectionSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("claim"),
      executionId: z.uuid(),
      action: koedTextActionProjectionSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("complete"),
      executionId: z.uuid(),
      action: koedTextActionProjectionSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("apply-team-todo-add"),
      executionId: z.uuid(),
      action: koedTextActionProjectionSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("apply-deck-make"),
      executionId: z.uuid(),
      action: koedTextActionProjectionSchema,
      result: z.object({ projectId: z.uuid(), deckId: z.uuid() }).strict()
    })
    .strict(),
  z
    .object({
      operation: z.literal("deck-result"),
      executionId: z.uuid(),
      state: koedTextActionProjectionSchema.shape.state,
      result: z
        .object({ projectId: z.uuid(), deckId: z.uuid() })
        .strict()
        .nullable()
    })
    .strict()
]);
export type ManagedTextActionResult = z.infer<
  typeof managedTextActionResultSchema
>;

export interface ManagedTextActionDesktopApi {
  list(
    executionId: string
  ): Promise<z.infer<typeof koedTextActionProjectionSchema>[]>;
  get(
    executionId: string,
    actionId: string
  ): Promise<z.infer<typeof koedTextActionProjectionSchema>>;
  review(
    executionId: string,
    actionId: string,
    expectedRevision: number,
    decision: "approve" | "decline"
  ): Promise<z.infer<typeof koedTextActionProjectionSchema>>;
  claim(
    executionId: string,
    actionId: string,
    expectedRevision: number
  ): Promise<z.infer<typeof koedTextActionProjectionSchema>>;
  complete(
    executionId: string,
    actionId: string,
    expectedRevision: number
  ): Promise<z.infer<typeof koedTextActionProjectionSchema>>;
  applyTeamTodoAdd(
    executionId: string,
    actionId: string,
    expectedRevision: number
  ): Promise<z.infer<typeof koedTextActionProjectionSchema>>;
  applyDeckMake?(
    executionId: string,
    actionId: string,
    expectedRevision: number
  ): Promise<{
    action: z.infer<typeof koedTextActionProjectionSchema>;
    result: { projectId: string; deckId: string };
  }>;
  deckResult?(
    executionId: string,
    actionId: string
  ): Promise<{
    state: z.infer<typeof koedTextActionProjectionSchema>["state"];
    result: { projectId: string; deckId: string } | null;
  }>;
}
