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
  .strict()
  .superRefine((assignment, context) => {
    if (
      JSON.stringify(assignment.effective) !==
      JSON.stringify(assignment.override ?? assignment.automatic)
    )
      context.addIssue({
        code: "custom",
        message: "Effective repository identity must match the assignment"
      });
  });
export type RepositoryAssignment = z.infer<typeof repositoryAssignmentSchema>;
export const effectiveRepositoryIdentity = (
  assignment: Pick<RepositoryAssignment, "automatic" | "override">
) => assignment.override ?? assignment.automatic;

export const createRepositoryAssignment = (
  assignment: Omit<RepositoryAssignment, "effective">
): RepositoryAssignment =>
  repositoryAssignmentSchema.parse({
    ...assignment,
    effective: effectiveRepositoryIdentity(assignment)
  });
