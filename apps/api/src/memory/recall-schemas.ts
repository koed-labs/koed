import { z } from "zod";
import { queryBooleanSchema } from "./common-schemas.js";
import {
  retrievalScopeSchema,
  searchDomainSchema
} from "./retrieval-schemas.js";

export const searchMemorySchema = z
  .object({
    query: z.string().min(1),
    retrieval_scope: retrievalScopeSchema.default("personal"),
    search_domain: searchDomainSchema.default("global"),
    session_id: z.string().uuid().optional(),
    workspace_id: z.string().min(1).optional(),
    limit: z.coerce.number().int().positive().max(50).default(10),
    recent_days: z.coerce.number().int().positive().max(36500).optional(),
    source_after: z.coerce.date().optional(),
    source_before: z.coerce.date().optional(),
    retrieval_stage: z
      .enum([
        "score_scan",
        "rollup_search",
        "scoped_leaf_search",
        "leaf_search",
        "fresh_pending_search",
        "raw_fallback_search",
        "lexical_search"
      ])
      .optional(),
    parent_node_ids: z.array(z.string().uuid()).max(20).optional(),
    strict_limit: queryBooleanSchema.optional()
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
    if (
      input.recent_days !== undefined &&
      (input.source_after !== undefined || input.source_before !== undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recent_days"],
        message:
          "recent_days cannot be combined with explicit source_after/source_before bounds"
      });
    }
    if (
      input.source_after !== undefined &&
      input.source_before !== undefined &&
      input.source_after.getTime() >= input.source_before.getTime()
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source_after"],
        message: "source_after must be earlier than source_before"
      });
    }
  });
