import { z } from "zod";

/** Owner-facing results; suppression receipts and User statements stay server-side. */
export const managedMemoryActionSchema = z
  .object({
    id: z.uuid(),
    executionId: z.uuid(),
    actionKind: z.enum(["forget", "correct"]),
    state: z.enum(["pending", "completed", "rejected"]),
    outcome: z
      .enum([
        "forgotten",
        "proposal_created",
        "offer_chat_forget",
        "ask_owner",
        "ask_reference",
        "unavailable",
        "undone"
      ])
      .nullable(),
    message: z.string().max(4096),
    assertionId: z.uuid().optional(),
    sourceSessionId: z.uuid().optional(),
    proposalId: z.uuid().optional(),
    createdAt: z.iso.datetime({ offset: true }),
    completedAt: z.iso.datetime({ offset: true }).nullable()
  })
  .strict();
export type ManagedMemoryAction = z.infer<typeof managedMemoryActionSchema>;
