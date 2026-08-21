import {
  LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
  structuredLcmSummarySchema
} from "@koed/core";
import { z } from "zod";

const compatibilityHashSchema = z
  .string()
  .regex(
    /^(?:[0-9a-f]{64}|[A-Za-z0-9_-]{43})$/,
    "Expected a SHA-256 compatibility hash"
  );

const pdsLcmContractSchema = z
  .object({
    artifactClass: z.literal("lcm_node/v1"),
    nodeKind: z.enum(["leaf", "rollup"]),
    lcmAlgorithmVersion: z.string().min(1).max(240),
    summaryPromptVersion: z.string().min(1).max(240),
    summaryModel: z.string().min(1).max(240),
    structuredOutputSchema: z.string().min(1).max(240),
    sourceSelectionPolicy: z.string().min(1).max(240)
  })
  .strict();

export const lcmSummaryClaimRequestSchema = z
  .object({
    limit: z.coerce.number().int().positive().max(50).default(10),
    claimantId: z.string().trim().min(1).max(200),
    compatibilityContractHash: compatibilityHashSchema,
    pdsContracts: z
      .object({
        leaf: pdsLcmContractSchema.extend({
          nodeKind: z.literal("leaf")
        }),
        rollup: pdsLcmContractSchema.extend({
          nodeKind: z.literal("rollup")
        })
      })
      .strict()
      .optional(),
    leaseMs: z.coerce.number().int().min(30_000).max(3_600_000).default(300_000)
  })
  .strict();

export const lcmSummaryClaimParamsSchema = z.object({
  claimId: z.string().uuid()
});

export const renewLcmSummaryClaimSchema = z
  .object({
    claimToken: z.string().uuid(),
    claimGeneration: z.coerce.number().int().positive(),
    leaseMs: z.coerce.number().int().min(30_000).max(3_600_000)
  })
  .strict();

export const nodeIdParamsSchema = z.object({ nodeId: z.string().uuid() });

export const sessionIdParamsSchema = z.object({
  sessionId: z.string().uuid()
});

export const pendingSessionTitlesQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(25).default(5),
  min_user_events: z.coerce.number().int().positive().max(50).default(3)
});

export const submitSessionTitleSchema = z.object({
  title: z.string().trim().min(1).max(120),
  titleModel: z.string().min(1),
  titlePromptVersion: z.string().min(1)
});

export const submitLcmSummarySchema = z
  .object({
    summaryText: z.string().trim().min(1),
    summaryModel: z.string().min(1),
    summaryPromptVersion: z.string().min(1),
    summaryTokenEstimate: z.coerce.number().int().nonnegative(),
    summaryStructuredJson: structuredLcmSummarySchema,
    summaryStructuredSchemaVersion: z.literal(
      LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION
    ),
    claimId: z.string().uuid(),
    claimToken: z.string().uuid(),
    claimGeneration: z.coerce.number().int().positive(),
    inputRevisionHash: z.string().regex(/^[0-9a-f]{64}$/),
    compatibilityContractHash: compatibilityHashSchema
  })
  .superRefine((value, context) => {
    if (value.summaryText !== value.summaryStructuredJson.summary_text) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "summaryText must match summaryStructuredJson.summary_text",
        path: ["summaryText"]
      });
    }
  });
