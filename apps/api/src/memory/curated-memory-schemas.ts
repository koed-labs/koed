import { z } from "zod";
import { CURATED_MEMORY_REVIEW_MAX_EVIDENCE } from "@koed/shared";
import { queryBooleanSchema } from "./common-schemas.js";
import { searchDomainSchema } from "./retrieval-schemas.js";

const sensitivitySchema = z.enum(["normal", "sensitive", "review_required"]);
const operationSchema = z.enum(["store", "merge", "supersede", "conflict"]);

export const curatedMemoryProposalSchema = z
  .object({
    proposed_claim: z.string().trim().min(1).max(4000),
    proposed_topic: z.string().trim().min(1).max(500).optional(),
    rationale: z.string().trim().max(4000).optional(),
    tags: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
    sensitivity_hint: sensitivitySchema.optional(),
    expires_at: z.string().datetime({ offset: true }).optional(),
    evidence_conversation_item_ids: z
      .array(z.string().uuid())
      .max(CURATED_MEMORY_REVIEW_MAX_EVIDENCE)
      .default([]),
    evidence_memory_event_ids: z
      .array(z.string().uuid())
      .max(CURATED_MEMORY_REVIEW_MAX_EVIDENCE)
      .default([]),
    evidence_exact_quote: z.string().trim().min(1).max(16_000).optional(),
    operation: operationSchema.default("store"),
    target_assertion_id: z.string().uuid().optional(),
    source_project_id: z.string().trim().min(1).optional(),
    source_session_id: z.string().uuid().optional(),
    created_by_model: z.string().trim().max(200).optional(),
    created_by_prompt_version: z.string().trim().max(200).optional()
  })
  .superRefine((input, context) => {
    if (
      input.evidence_conversation_item_ids.length === 0 &&
      input.evidence_memory_event_ids.length === 0 &&
      !input.source_project_id &&
      !input.source_session_id
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence_conversation_item_ids"],
        message: "Evidence IDs or a source Project/session scope is required"
      });
    }
    if (
      input.evidence_conversation_item_ids.length +
        input.evidence_memory_event_ids.length >
      CURATED_MEMORY_REVIEW_MAX_EVIDENCE
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence_conversation_item_ids"],
        message: `At most ${CURATED_MEMORY_REVIEW_MAX_EVIDENCE} total evidence sources are allowed`
      });
    }
    if (
      input.evidence_conversation_item_ids.length === 0 &&
      input.evidence_memory_event_ids.length === 0 &&
      !input.source_session_id &&
      !input.evidence_exact_quote
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence_exact_quote"],
        message:
          "An exact user quote is required when evidence IDs and source_session_id are omitted"
      });
    }
  });

export const curatedMemoryClaimSchema = z.object({
  proposal_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(20).default(5),
  lease_seconds: z.coerce.number().int().min(30).max(3600).default(180)
});

const evidenceRevisionSchema = z.object({
  source_type: z.enum(["conversation_item", "memory_event"]),
  source_id: z.string().uuid(),
  source_hash: z.string().min(1).max(500)
});

const reviewLeaseSchema = z.object({
  attempt_count: z.number().int().positive(),
  evidence_revisions: z
    .array(evidenceRevisionSchema)
    .max(CURATED_MEMORY_REVIEW_MAX_EVIDENCE)
    .default([]),
  candidate_assertion_ids: z.array(z.string().uuid()).max(20).default([]),
  worker_result: z.record(z.string(), z.unknown()).optional()
});

export const curatedMemoryReviewResultSchema = z.discriminatedUnion("outcome", [
  reviewLeaseSchema.extend({
    outcome: z.literal("accepted"),
    selected_evidence_ids: z
      .array(z.string().uuid())
      .min(1)
      .max(CURATED_MEMORY_REVIEW_MAX_EVIDENCE),
    operation: operationSchema,
    target_assertion_id: z.string().uuid().nullable().optional(),
    assertion_text: z.string().trim().min(1).max(4000),
    topic_title: z.string().trim().min(1).max(500).nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
    sensitivity: sensitivitySchema.default("normal"),
    confidence: z.number().int().min(0).max(100).default(80),
    expires_at: z.string().datetime({ offset: true }).nullable().optional(),
    decision_reason: z.string().trim().min(1).max(2000),
    reviewer_model: z.string().trim().min(1).max(200),
    reviewer_prompt_version: z.string().trim().min(1).max(200)
  }),
  reviewLeaseSchema.extend({
    outcome: z.literal("rejected"),
    selected_evidence_ids: z
      .array(z.string().uuid())
      .max(CURATED_MEMORY_REVIEW_MAX_EVIDENCE)
      .default([]),
    decision_reason: z.string().trim().min(1).max(2000)
  }),
  z.object({
    outcome: z.literal("retry"),
    attempt_count: z.number().int().positive(),
    error_message: z.string().trim().min(1).max(2000)
  })
]);

export const curatedMemoryProposalParamsSchema = z.object({
  proposalId: z.string().uuid()
});

export const curatedMemoryProposalQuerySchema = z.object({
  status: z
    .enum([
      "pending",
      "stored",
      "merged",
      "superseded",
      "conflicted",
      "skipped"
    ])
    .optional(),
  limit: z.coerce.number().int().positive().max(250).default(50)
});

export const curatedMemoryListQuerySchema = z.object({
  status: z
    .enum(["current", "superseded", "conflicting", "suppressed"])
    .optional(),
  topic_id: z.string().uuid().optional(),
  include_sources: queryBooleanSchema.default(false),
  limit: z.coerce.number().int().positive().max(250).default(50)
});

export const curatedMemorySearchQuerySchema = z
  .object({
    query: z.string().trim().min(1).max(4000),
    search_domain: searchDomainSchema.default("global"),
    session_id: z.string().uuid().optional(),
    project_id: z.string().trim().min(1).optional(),
    current_only: queryBooleanSchema.default(true),
    limit: z.coerce.number().int().positive().max(50).default(10)
  })
  .superRefine((input, context) => {
    if (input.search_domain === "session" && !input.session_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["session_id"],
        message: "session_id is required when search_domain is session"
      });
    }
    if (input.search_domain === "project" && !input.project_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["project_id"],
        message: "project_id is required when search_domain is project"
      });
    }
  });

export const curatedMemoryAssertionParamsSchema = z.object({
  assertionId: z.string().uuid()
});

export const curatedMemorySuppressSchema = z.object({
  status: z.literal("suppressed").default("suppressed"),
  reason: z.string().trim().max(1000).optional()
});

export const curatedMemoryReconcileSchema = z.object({
  limit: z.coerce.number().int().positive().max(250).default(100)
});
