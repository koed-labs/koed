import { z } from "zod";

import {
  highRiskActionGrantCreateRequestSchema,
  highRiskActionGrantRemoteStatusSchema
} from "./action-grant-protocol.js";

const uuidSchema = z.uuid();

export const createHighRiskActionGrantSchema =
  highRiskActionGrantCreateRequestSchema;

export const highRiskActionGrantParamsSchema = z
  .object({ clientRequestId: uuidSchema })
  .strict();

export const highRiskBrowserActivationParamsSchema = z
  .object({ selector: uuidSchema })
  .strict();

export const decideHighRiskBrowserActivationSchema = z
  .object({ decision: z.enum(["approve", "deny"]) })
  .strict();

export const decideNativeActionReviewSchema = z
  .object({ decision: z.literal("approve") })
  .strict();

export const highRiskBrowserActivationEnvelopeSchema = z
  .object({
    status: highRiskActionGrantRemoteStatusSchema,
    confirmation: z
      .object({
        action: z.string().regex(/^[A-Za-z0-9_.:-]+$/),
        operationFamily: z.enum([
          "admin",
          "share_grant_management",
          "source_download",
          "managed_execution"
        ]),
        teamId: uuidSchema.nullable(),
        targetId: uuidSchema.nullable()
      })
      .strict()
  })
  .strict();

export type HighRiskBrowserActivation = z.infer<
  typeof highRiskBrowserActivationEnvelopeSchema
>;
