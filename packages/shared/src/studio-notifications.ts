import { z } from "zod";

/**
 * Renderer-to-main reference only. The desktop process must re-read the
 * referenced Home or Team overview item before displaying or navigating.
 * Notification copy and classification are never accepted from the renderer.
 */
export const studioNotificationSourceSchema = z.enum(["home", "team_overview"]);
export type StudioNotificationSource = z.infer<
  typeof studioNotificationSourceSchema
>;

export const studioNotificationIntentSchema = z
  .object({
    version: z.literal(1),
    source: studioNotificationSourceSchema,
    accountScope: z.string().min(1).max(256),
    backendId: z.string().min(1).max(256).nullable(),
    sourceEventId: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[A-Za-z0-9._:-]+$/u),
    sourceRevision: z.string().min(1).max(256),
    messageId: z.uuid().optional()
  })
  .strict()
  .superRefine((intent, context) => {
    if (intent.source === "team_overview" && !intent.messageId) {
      context.addIssue({
        code: "custom",
        message: "Team notification references require a message ID.",
        path: ["messageId"]
      });
    }
  });
export type StudioNotificationIntent = z.infer<
  typeof studioNotificationIntentSchema
>;

export const studioNotificationClassificationSchema = z.enum([
  "agent_input",
  "agent_approval",
  "agent_job_failed",
  "direct_message",
  "mention"
]);
export type StudioNotificationClassification = z.infer<
  typeof studioNotificationClassificationSchema
>;

export interface StudioNotificationSourceItem {
  source: string;
  kind: string;
  state: string;
}

/** Classify only structured Home fields. Intervention and job outcomes are quiet. */
export const classifyHomeNotification = (
  item: StudioNotificationSourceItem
): StudioNotificationClassification | null => {
  if (item.source === "pull_request_review") return null;
  if (item.state !== "blocked" && item.state !== "review") return null;
  if (item.kind === "question") return "agent_input";
  if (item.kind === "approval") return "agent_approval";
  // The Home repository maps only failed Personal Agent Jobs to an
  // intervention in the needs-you feed; completed jobs are job_review.
  if (item.source === "personal_agent_job" && item.kind === "intervention")
    return "agent_job_failed";
  return null;
};

/** Team overview only identifies a candidate. Message-page authority is required. */
export const isTeamMessageNotificationCandidate = (
  item: StudioNotificationSourceItem
): boolean =>
  item.source === "message_attention" &&
  item.kind === "message" &&
  (item.state === "blocked" || item.state === "recent");

export const studioNotificationCopy = (
  classification: StudioNotificationClassification
): { title: string; body: string } => {
  switch (classification) {
    case "agent_input":
      return { title: "Koed Studio", body: "An Agent needs your input." };
    case "agent_approval":
      return { title: "Koed Studio", body: "An Agent needs your approval." };
    case "agent_job_failed":
      return { title: "Koed Studio", body: "An Agent Job failed." };
    case "direct_message":
      return { title: "Koed Studio", body: "You received a direct message." };
    case "mention":
      return { title: "Koed Studio", body: "You were mentioned." };
  }
};

export const studioNotificationNavigationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("execution"), executionId: z.uuid() }).strict(),
  z
    .object({
      kind: z.literal("team_thread"),
      teamId: z.uuid(),
      threadId: z.uuid(),
      rootMessageId: z.uuid().nullable(),
      messageId: z.uuid()
    })
    .strict()
]);
export type StudioNotificationNavigation = z.infer<
  typeof studioNotificationNavigationSchema
>;
