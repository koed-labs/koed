import { CURATED_MEMORY_REVIEW_MAX_EVIDENCE } from "@koed/shared";
import { z } from "zod";
import { memoryAnswerRetrievalHintsSchema } from "./memory-answer-request.js";

export const searchDomainSchema = z.enum(["global", "project", "session"]);
export const memoryAnswerResponseDetailSchema = z.enum([
  "answer_only",
  "with_citations",
  "with_evidence"
]);
export const uuidSchema = z.string().uuid();

export const memoryAccessCheckInputSchema = z.object({
  include_notes: z.boolean().optional().default(true)
});

export const memoryAnswerInputSchema = z
  .object({
    query: z.string().trim().min(1).max(32_000),
    retrieval_hints: memoryAnswerRetrievalHintsSchema,
    response_detail: memoryAnswerResponseDetailSchema.default("answer_only"),
    search_domain: searchDomainSchema.default("project"),
    project_id: z.string().trim().min(1).max(4096).optional(),
    session_id: uuidSchema.optional(),
    team_workspace_id: uuidSchema.optional(),
    recent_days: z.number().int().positive().max(36500).optional(),
    source_after: z.string().datetime().optional(),
    source_before: z.string().datetime().optional(),
    limit: z.number().int().positive().max(50).default(10),
    include_evidence: z.boolean().default(false)
  })
  .strict()
  .refine(
    (input) =>
      input.recent_days === undefined || input.source_after === undefined,
    "recent_days and source_after cannot be combined"
  )
  .refine(
    (input) =>
      input.search_domain !== "session" || input.session_id !== undefined,
    "session_id is required for session search"
  );

export const memoryIntakeProposeInputSchema = z
  .object({
    proposed_claim: z.string().trim().min(1).max(4000),
    proposed_topic: z.string().trim().min(1).max(500).optional(),
    rationale: z.string().trim().max(4000).optional(),
    tags: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
    sensitivity_hint: z
      .enum(["normal", "sensitive", "review_required"])
      .default("normal"),
    expires_at: z.string().datetime({ offset: true }).optional(),
    evidence_conversation_item_ids: z
      .array(uuidSchema)
      .max(CURATED_MEMORY_REVIEW_MAX_EVIDENCE)
      .default([]),
    evidence_memory_event_ids: z
      .array(uuidSchema)
      .max(CURATED_MEMORY_REVIEW_MAX_EVIDENCE)
      .default([]),
    evidence_exact_quote: z.string().trim().min(1).max(16_000).optional(),
    operation: z
      .enum(["store", "merge", "supersede", "conflict"])
      .default("store"),
    target_assertion_id: uuidSchema.optional(),
    source_project_id: z.string().trim().min(1).max(4096).optional(),
    source_session_id: uuidSchema.optional()
  })
  .strict()
  .refine(
    (input) =>
      input.evidence_conversation_item_ids.length +
        input.evidence_memory_event_ids.length <=
      CURATED_MEMORY_REVIEW_MAX_EVIDENCE,
    `At most ${CURATED_MEMORY_REVIEW_MAX_EVIDENCE} total evidence sources are allowed`
  );

export const memorySearchInputSchema = z
  .object({
    query: z.string().trim().min(1).max(32_000),
    search_domain: searchDomainSchema.default("project"),
    project_id: z.string().trim().min(1).max(4096).optional(),
    session_id: uuidSchema.optional(),
    recent_days: z.number().int().positive().max(36500).optional(),
    source_after: z.string().datetime().optional(),
    source_before: z.string().datetime().optional(),
    limit: z.number().int().positive().max(50).default(10)
  })
  .strict();

export const memoryExpandInputSchema = z
  .object({ nodeId: uuidSchema })
  .strict();

export type MemoryAnswerToolInput = z.infer<typeof memoryAnswerInputSchema>;
export type MemoryIntakeProposeToolInput = z.infer<
  typeof memoryIntakeProposeInputSchema
>;
