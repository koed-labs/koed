import { z } from "zod";
import {
  memoryQuestionRetrievalScopeSchema,
  searchDomainSchema
} from "./retrieval-schemas.js";

export const memoryQuestionWorkerConfigSchema = z
  .object({
    provider: z.literal("codex").optional(),
    model: z.string().trim().min(1).optional(),
    reasoning_effort: z.string().trim().min(1).optional(),
    timeout_ms: z.coerce.number().int().min(1000).max(600000).optional(),
    max_attempts: z.coerce.number().int().min(1).max(25).optional()
  })
  .strict();

export const memoryQuestionSchema = z
  .object({
    query: z.string().min(1),
    retrieval_scope: memoryQuestionRetrievalScopeSchema.default("personal"),
    search_domain: searchDomainSchema.default("global"),
    workspace_id: z.string().min(1).optional(),
    project_name: z.string().min(1).optional(),
    project_path: z.string().min(1).optional(),
    session_id: z.string().uuid().optional(),
    thread_id: z.string().min(1).optional(),
    thread_name: z.string().min(1).optional(),
    local_memory_worker_config: memoryQuestionWorkerConfigSchema.optional()
  })
  .superRefine((input, context) => {
    if (input.search_domain === "session" && !input.session_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["session_id"],
        message: "session_id is required when search_domain is session"
      });
    }
    if (input.search_domain === "project" && !input.workspace_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workspace_id"],
        message: "workspace_id is required when search_domain is project"
      });
    }
  });

export const memoryQuestionsQuerySchema = z.object({
  query: z.string().min(1).optional(),
  search_domain: searchDomainSchema.optional(),
  status: z.enum(["pending", "answered", "error"]).optional(),
  workspace_id: z.string().min(1).optional(),
  session_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
  offset: z.coerce.number().int().nonnegative().default(0)
});

export const memoryQuestionParamsSchema = z.object({
  questionId: z.string().uuid()
});

export const claimMemoryQuestionsSchema = z.object({
  question_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(10).default(1),
  lease_seconds: z.coerce.number().int().positive().max(3600).default(180)
});

export const updateMemoryQuestionSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("answered"),
    answer_markdown: z.string().min(1),
    attempt_count: z.number().int().positive().optional(),
    response: z.record(z.string(), z.unknown()).optional(),
    evidence: z.array(z.unknown()).optional(),
    citations: z.array(z.unknown()).optional(),
    retrieval: z.record(z.string(), z.unknown()).optional(),
    local_memory_worker: z.record(z.string(), z.unknown()).optional()
  }),
  z.object({
    status: z.literal("error"),
    error_message: z.string().min(1),
    attempt_count: z.number().int().positive().optional(),
    response: z.record(z.string(), z.unknown()).optional(),
    retrieval: z.record(z.string(), z.unknown()).optional(),
    local_memory_worker: z.record(z.string(), z.unknown()).optional()
  }),
  z.object({
    status: z.literal("pending"),
    last_error_message: z.string().min(1),
    attempt_count: z.number().int().positive().optional(),
    response: z.record(z.string(), z.unknown()).optional(),
    evidence: z.array(z.unknown()).optional(),
    citations: z.array(z.unknown()).optional(),
    retrieval: z.record(z.string(), z.unknown()).optional(),
    local_memory_worker: z.record(z.string(), z.unknown()).optional()
  })
]);
