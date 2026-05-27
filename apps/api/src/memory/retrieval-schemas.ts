import { z } from "zod";

export const retrievalScopeSchema = z.literal("personal");

export const memoryQuestionRetrievalScopeSchema = z.literal("personal");

export const searchDomainSchema = z.enum(["global", "project", "session"]);
