import { z } from "zod";
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
    if (input.search_domain === "project" && !input.workspace_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workspace_id"],
        message: "workspace_id is required when search_domain is project"
      });
    }
  });
