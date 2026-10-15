import { isConversationDirectory } from "./conversation-directory.js";
import {
  repositoryIdentitySchema,
  CURATED_MEMORY_REVIEW_MAX_EVIDENCE
} from "@koed/shared";
import { z } from "zod";
import { memoryAnswerRetrievalHintsSchema } from "./memory-answer-request.js";
import { MEMORY_ANSWER_DELIVERY_MODES } from "../integrations/pi/memory-answer-delivery-policy.mjs";

export const searchDomainSchema = z.enum(["global", "project", "session"]);
export const memoryAnswerResponseDetailSchema = z.enum([
  "answer_only",
  "with_citations",
  "with_evidence"
]);
export const uuidSchema = z.string().uuid().toLowerCase();

export const memoryWorkspacesInputSchema = z
  .object({
    team_backend_id: z.string().trim().min(1).max(160).optional()
  })
  .strict();

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
    repository_context: repositoryIdentitySchema.nullable().optional(),
    session_id: uuidSchema.optional(),
    team_workspace_id: uuidSchema.optional(),
    team_backend_id: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .optional()
      .describe(
        "Backend id from memory_workspaces. Use with team_workspace_id to select Team Memory."
      ),
    recent_days: z.number().int().positive().max(36500).optional(),
    source_after: z.string().datetime().optional(),
    source_before: z.string().datetime().optional(),
    limit: z.number().int().positive().max(50).default(10),
    include_evidence: z.boolean().default(false)
  })
  .strict()
  .refine(
    (input) =>
      input.search_domain !== "project" ||
      input.repository_context === undefined ||
      (input.repository_context !== null &&
        input.repository_context.kind !== "unresolved"),
    "Project recall requires a resolved repository context"
  )
  .refine(
    (input) =>
      input.team_backend_id === undefined ||
      input.team_workspace_id !== undefined,
    "team_workspace_id is required with team_backend_id"
  )
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

// The runtime and durable worker retain the strict execution schema above.
export const memoryAnswerAdapterInputSchema =
  memoryAnswerInputSchema.safeExtend({
    conversation_cwd: z
      .string()
      .min(1)
      .max(4096)
      .refine(isConversationDirectory, {
        message: "conversation_cwd must be an absolute conversation directory"
      })
      .optional()
      .describe(
        "Current conversation directory, supplied automatically by the client integration. Overrides the MCP process directory, without changing an explicit Project target."
      ),
    delivery_mode: z
      .enum(MEMORY_ANSWER_DELIVERY_MODES)
      .optional()
      .describe(
        "Use non-blocking by default. Set delivery_mode=non_blocking for those memory_answer calls. Blocking is an option only when you absolutely cannot start any work until you have checked for relevant memory."
      )
  });

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
    repository_context: repositoryIdentitySchema.nullable().optional(),
    session_id: uuidSchema.optional(),
    recent_days: z.number().int().positive().max(36500).optional(),
    source_after: z.string().datetime().optional(),
    source_before: z.string().datetime().optional(),
    limit: z.number().int().positive().max(50).default(10)
  })
  .strict();

export const memoryExpandInputSchema = z
  .object({
    nodeId: uuidSchema,
    search_domain: searchDomainSchema.default("project"),
    project_id: z.string().trim().min(1).max(4096).optional(),
    repository_context: repositoryIdentitySchema.nullable().optional(),
    session_id: uuidSchema.optional(),
    recent_days: z.number().int().positive().max(36500).optional(),
    source_after: z.string().datetime().optional(),
    source_before: z.string().datetime().optional()
  })
  .strict();

export type MemoryAnswerToolInput = z.infer<typeof memoryAnswerInputSchema>;
export type MemoryIntakeProposeToolInput = z.infer<
  typeof memoryIntakeProposeInputSchema
>;
