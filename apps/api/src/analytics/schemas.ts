import { z } from "zod";

export const activationAnalyticsEventSchema = z.enum([
  "signup_completed",
  "desktop_connected",
  "mcp_setup_started",
  "mcp_setup_completed",
  "capture_hook_setup_started",
  "capture_hook_setup_completed",
  "first_capture_completed",
  "first_memory_answer_completed",
  "first_recall_completed",
  "team_created",
  "workspace_created",
  "invite_sent",
  "invite_accepted",
  "session_shared",
  "paid_conversion_started",
  "paid_conversion_completed"
]);

export const analyticsSurfaceSchema = z.enum([
  "desktop",
  "koed_server",
  "mcp_server",
  "capture_hook",
  "api"
]);

export const deploymentProfileSchema = z.enum([
  "developer",
  "local_personal",
  "private_vps",
  "team_self_hosted",
  "koed_managed_cloud"
]);

const analyticsMetadataValueSchema = z.union([
  z.string().trim().max(200),
  z.number().finite(),
  z.boolean(),
  z.null()
]);

const analyticsMetadataStringKeys = new Set([
  "clientVersion",
  "dependencyMode",
  "deploymentMode",
  "errorCode",
  "os",
  "platform",
  "provider",
  "reasonCode",
  "releaseVersion",
  "result",
  "runtime",
  "setupPath",
  "source",
  "step",
  "version"
]);

const analyticsMetadataBooleanKeys = new Set(["repaired"]);

const analyticsMetadataDurationKeys = new Set(["durationMs", "elapsedMs"]);

const analyticsMetadataCountKeys = new Set([
  "count",
  "memberCount",
  "retryCount",
  "seatCount",
  "workspaceCount"
]);

const analyticsMetadataAllowedKeys = new Set([
  ...analyticsMetadataStringKeys,
  ...analyticsMetadataBooleanKeys,
  ...analyticsMetadataDurationKeys,
  ...analyticsMetadataCountKeys
]);

const analyticsMetadataTokenPattern = /^[A-Za-z0-9_.:/@+-]{1,80}$/;

const addMetadataIssue = (
  context: z.RefinementCtx,
  key: string,
  message: string
) => {
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["metadata", key],
    message
  });
};

export const activationAnalyticsEventBodySchema = z
  .object({
    event: activationAnalyticsEventSchema,
    surface: analyticsSurfaceSchema,
    deploymentProfile: deploymentProfileSchema.optional(),
    teamId: z.string().uuid().optional(),
    teamWorkspaceId: z.string().uuid().optional(),
    sessionId: z.string().uuid().optional(),
    metadata: z
      .record(z.string().trim().min(1).max(80), analyticsMetadataValueSchema)
      .optional()
  })
  .strict()
  .superRefine((input, context) => {
    const entries = Object.entries(input.metadata ?? {});
    if (entries.length > 20) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["metadata"],
        message: "metadata must contain at most 20 keys"
      });
    }

    for (const [key, value] of entries) {
      if (!analyticsMetadataAllowedKeys.has(key)) {
        addMetadataIssue(
          context,
          key,
          "metadata key is not allowed for activation analytics"
        );
        continue;
      }

      if (analyticsMetadataStringKeys.has(key)) {
        if (
          typeof value !== "string" ||
          !analyticsMetadataTokenPattern.test(value)
        ) {
          addMetadataIssue(
            context,
            key,
            "metadata string value must be a short token, not free-form text"
          );
        }
        continue;
      }

      if (analyticsMetadataBooleanKeys.has(key)) {
        if (typeof value !== "boolean") {
          addMetadataIssue(context, key, "metadata value must be a boolean");
        }
        continue;
      }

      if (analyticsMetadataDurationKeys.has(key)) {
        if (typeof value !== "number" || value < 0) {
          addMetadataIssue(
            context,
            key,
            "metadata duration must be a non-negative number"
          );
        }
        continue;
      }

      if (analyticsMetadataCountKeys.has(key)) {
        if (
          typeof value !== "number" ||
          value < 0 ||
          !Number.isInteger(value)
        ) {
          addMetadataIssue(
            context,
            key,
            "metadata count must be a non-negative integer"
          );
        }
      }
    }
  });

export type ActivationAnalyticsEventBody = z.infer<
  typeof activationAnalyticsEventBodySchema
>;

const optionalIsoDateSchema = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value))
  .optional();

export const activationAnalyticsFunnelQuerySchema = z
  .object({
    teamId: z.string().uuid().optional(),
    teamWorkspaceId: z.string().uuid().optional(),
    since: optionalIsoDateSchema,
    until: optionalIsoDateSchema
  })
  .strict()
  .refine(
    (input) =>
      !input.since ||
      !input.until ||
      input.since.getTime() <= input.until.getTime(),
    {
      path: ["until"],
      message: "until must be after since"
    }
  );
