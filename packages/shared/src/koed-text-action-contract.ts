import { z } from "zod";

const uuid = z.uuid();
const name = z.string().trim().min(1).max(160);

// The AI Client selects an action; these arguments never authorize a write.
// Koed resolves targets against the owning User's current records and the
// original leased User turn before it offers a review or applies an action.
export const koedTextActionInputSchemas = {
  koed_project_create: z
    .object({ name, folderPath: z.string().min(1).max(2048).optional() })
    .strict(),
  koed_project_move_chats: z
    .object({
      projectId: uuid,
      sessionIds: z
        .array(uuid)
        .min(1)
        .max(50)
        .refine(
          (ids) => new Set(ids).size === ids.length,
          "Conversation IDs must be unique"
        )
    })
    .strict(),
  koed_project_delete: z.object({ projectId: uuid }).strict(),
  koed_chat_create: z.object({ projectId: uuid.optional() }).strict(),
  koed_chat_move: z
    .object({ sessionId: uuid, projectId: uuid.optional() })
    .strict(),
  koed_chat_delete: z.object({ sessionId: uuid }).strict(),
  koed_todo_add: z
    .object({
      projectId: uuid,
      title: name,
      goal: z.string().trim().max(20_000).optional(),
      dueOn: z.iso.date().optional()
    })
    .strict(),
  koed_todo_send: z
    .object({ projectId: uuid, workItemId: uuid, agentId: uuid })
    .strict(),
  koed_hq_open: z.object({ projectId: uuid }).strict(),
  koed_settings_open: z
    .object({
      section: z
        .enum(["general", "agents", "teams", "services", "deleted", "about"])
        .optional()
    })
    .strict(),
  koed_settings_set_theme: z
    .object({ theme: z.enum(["light", "dark", "system"]) })
    .strict()
} as const;

export type KoedTextActionName = keyof typeof koedTextActionInputSchemas;
export const koedTextActionNames = Object.keys(
  koedTextActionInputSchemas
) as KoedTextActionName[];

// Later ticket owners may expose these only after their services and approval
// contracts exist. An unsupported request must never look like success.
export const koedTextActionFutureNames = [
  "koed_project_share",
  "koed_invite_accept",
  "koed_project_leave",
  "koed_workspace_leave",
  "koed_job_create",
  "koed_job_run",
  "koed_job_pause",
  "koed_deck_make",
  "koed_deck_open"
] as const;

export const koedTextActionReceipt = (name: KoedTextActionName) =>
  `Koed ${name} request v1: {"status":"requested"}`;

export const koedTextActionReviewSchema = z
  .object({
    actionId: uuid,
    expectedRevision: z.number().int().positive(),
    decision: z.enum(["approve", "decline"])
  })
  .strict();

export const koedTextActionDeliverySchema = z
  .object({
    name: z.enum(
      koedTextActionNames as [KoedTextActionName, ...KoedTextActionName[]]
    ),
    arguments: z.record(z.string(), z.unknown()),
    executionGeneration: z.number().int().positive(),
    commandId: uuid,
    leaseToken: z.string().min(16).max(512),
    providerTurnId: z.string().min(1).max(512),
    toolCallId: z.string().min(1).max(512)
  })
  .strict();

export const parseKoedTextActionArguments = (
  name: KoedTextActionName,
  value: unknown
): Record<string, unknown> =>
  koedTextActionInputSchemas[name].parse(value) as Record<string, unknown>;

export const koedTextActionProjectionSchema = z
  .object({
    id: uuid,
    ownerUserId: uuid,
    logicalSessionId: uuid,
    executionId: uuid,
    commandId: uuid,
    executionGeneration: z.number().int().positive(),
    providerTurnId: z.string().min(1).max(512),
    toolCallId: z.string().min(1).max(512),
    name: z.enum(
      koedTextActionNames as [KoedTextActionName, ...KoedTextActionName[]]
    ),
    arguments: z.record(z.string(), z.unknown()),
    snapshot: z.record(z.string(), z.unknown()),
    state: z.enum([
      "awaiting_review",
      "ready",
      "claimed",
      "applied",
      "declined",
      "uncertain",
      "unavailable"
    ]),
    revision: z.number().int().positive(),
    reviewKind: z.enum(["none", "ask_first", "native"]),
    effectKey: uuid,
    uiOutcome: z.literal("opened_composer").optional(),
    createdAt: z.iso.datetime(),
    decidedAt: z.iso.datetime().nullable()
  })
  .strict();

export type KoedTextActionProjection = z.infer<
  typeof koedTextActionProjectionSchema
>;
