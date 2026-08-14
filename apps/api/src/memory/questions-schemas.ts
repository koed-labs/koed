import { z } from "zod";
import {
  memoryQuestionRetrievalScopeSchema,
  searchDomainSchema
} from "./retrieval-schemas.js";

const finalMemoryQuestionBaseSchema = z.object({
  idempotency_key: z.string().trim().min(1).max(500),
  query: z.string().min(1),
  origin: z.literal("mcp_memory_answer"),
  retrieval_scope: memoryQuestionRetrievalScopeSchema.default("personal"),
  team_workspace_id: z.string().uuid().optional(),
  search_domain: searchDomainSchema.default("global"),
  project_id: z.string().min(1).optional(),
  project_name: z.string().min(1).optional(),
  project_path: z.string().min(1).optional(),
  session_id: z.string().uuid().optional(),
  thread_id: z.string().min(1).optional(),
  thread_name: z.string().min(1).optional(),
  attempt_count: z.number().int().positive().optional(),
  response: z.record(z.string(), z.unknown()).optional(),
  retrieval: z.record(z.string(), z.unknown()).optional(),
  local_memory_worker: z.record(z.string(), z.unknown()).optional()
});

export const finalMemoryQuestionSchema = z
  .discriminatedUnion("status", [
    finalMemoryQuestionBaseSchema.extend({
      status: z.literal("answered"),
      answer_markdown: z.string().min(1),
      evidence: z.array(z.unknown()).optional(),
      citations: z.array(z.unknown()).optional()
    }),
    finalMemoryQuestionBaseSchema.extend({
      status: z.literal("error"),
      error_message: z.string().min(1)
    })
  ])
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

export const memoryQuestionsQuerySchema = z.object({
  query: z.string().min(1).optional(),
  search_domain: searchDomainSchema.optional(),
  status: z.enum(["answered", "error"]).optional(),
  project_id: z.string().min(1).optional(),
  session_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
  offset: z.coerce.number().int().nonnegative().default(0)
});

export const memoryQuestionParamsSchema = z.object({
  questionId: z.string().uuid()
});
