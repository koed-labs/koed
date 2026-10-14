import { z } from "zod";
import { repositoryIdentitySchema } from "./repository-identity.js";

export const repositoryAssignmentSchema = z
  .object({
    state: z.enum(["recorded", "historical_unresolved"]),
    version: z.number().int().positive(),
    automatic: repositoryIdentitySchema.nullable(),
    override: repositoryIdentitySchema.nullable(),
    effective: repositoryIdentitySchema.nullable()
  })
  .strict();
export type RepositoryAssignment = z.infer<typeof repositoryAssignmentSchema>;
export const effectiveRepositoryIdentity = (
  assignment: Pick<RepositoryAssignment, "automatic" | "override">
) => assignment.override ?? assignment.automatic;
