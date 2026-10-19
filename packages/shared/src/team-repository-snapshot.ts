import { z } from "zod";
import {
  repositoryAssignmentSchema,
  effectiveRepositoryIdentity,
  type RepositoryAssignment
} from "./repository-assignment.js";
import { repositoryRecallContextSchema } from "./repository-recall.js";
import type { RepositoryIdentity } from "./repository-identity.js";

/** Team routing never contains a checkout path, device identity, or suppressed automatic anchor. */
export const teamRepositorySnapshotSchema = z.discriminatedUnion(
  "classification",
  [
    z
      .object({
        version: z.literal(1),
        classification: z.literal("portable_repository"),
        fingerprint: z.string().min(1).max(512),
        label: z.string().min(1).max(512).nullable(),
        branchObservation: z.string().min(1).max(512).nullable()
      })
      .strict(),
    z
      .object({
        version: z.literal(1),
        classification: z.literal("unresolved"),
        fingerprint: z.null(),
        label: z.null(),
        branchObservation: z.null()
      })
      .strict()
  ]
);
export type TeamRepositorySnapshot = z.infer<
  typeof teamRepositorySnapshotSchema
>;
export const teamRepositorySnapshotReviewSchema = z
  .object({
    shareGrantId: z.uuid(),
    teamId: z.uuid(),
    teamWorkspaceId: z.uuid(),
    grantVersion: z.number().int().positive(),
    sourceRevision: z.number().int().nonnegative(),
    representationId: z.uuid(),
    representationVersion: z.number().int().positive(),
    assignmentVersion: z.number().int().positive(),
    sourceContextHash: z.string().regex(/^[a-f0-9]{64}$/),
    currentSnapshot: teamRepositorySnapshotSchema
  })
  .strict();
export type TeamRepositorySnapshotReview = z.infer<
  typeof teamRepositorySnapshotReviewSchema
>;
export const unresolvedTeamRepositorySnapshot = (): TeamRepositorySnapshot => ({
  version: 1,
  classification: "unresolved",
  fingerprint: null,
  label: null,
  branchObservation: null
});

/** Labels must have already passed the representation's disclosure/privacy policy. */
export const createTeamRepositorySnapshot = (
  input: RepositoryAssignment,
  provenance: {
    permittedLabel?: string | null;
    capturedBranchObservation?: string | null;
  } = {}
): TeamRepositorySnapshot => {
  const assignment = repositoryAssignmentSchema.parse(input);
  const effective = effectiveRepositoryIdentity(assignment);
  if (effective?.kind !== "portable_repository")
    return unresolvedTeamRepositorySnapshot();
  return teamRepositorySnapshotSchema.parse({
    version: 1,
    classification: "portable_repository",
    fingerprint: effective.key,
    label: provenance.permittedLabel ?? null,
    branchObservation:
      assignment.automatic?.kind === "portable_repository" &&
      assignment.automatic.key === effective.key
        ? (provenance.capturedBranchObservation ?? null)
        : null
  });
};

export const requirePortableTeamRepositoryContext = (
  value: unknown
): Extract<RepositoryIdentity, { kind: "portable_repository" }> => {
  const parsed = repositoryRecallContextSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.kind !== "portable_repository" ||
    !parsed.data.key
  )
    throw Object.assign(
      new Error("Team Project recall requires a resolved portable repository"),
      {
        statusCode: 400,
        memoryAnswerTaskErrorCode: "invalid_project_scope",
        retryable: false
      }
    );
  return parsed.data;
};

export const portableTeamFingerprintForScope = (
  projectId: string | undefined
): string => {
  try {
    if (!projectId?.startsWith("repository:")) throw new Error();
    return z
      .object({
        kind: z.literal("portable_repository"),
        key: z.string().min(1).max(512),
        device: z.null()
      })
      .strict()
      .parse(JSON.parse(projectId.slice("repository:".length))).key;
  } catch {
    throw Object.assign(
      new Error("Team Project recall requires a resolved portable repository"),
      {
        statusCode: 400,
        memoryAnswerTaskErrorCode: "invalid_project_scope",
        retryable: false
      }
    );
  }
};
