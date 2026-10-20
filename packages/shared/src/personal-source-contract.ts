import { z } from "zod";
import { repositoryIdentitySchema } from "./repository-identity.js";
import { normalizeRecordedProjectDirectory } from "./recorded-directory.js";

export const personalIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
export const personalOwnerIdSchema = z.string().uuid().toLowerCase();
const owned = { ownerUserId: personalOwnerIdSchema };

export const personalProjectReferenceSchema = z
  .object({
    ...owned,
    projectId: personalIdentifierSchema
  })
  .strict();
export const personalFolderReferenceSchema = z
  .object({
    ...owned,
    folderId: personalIdentifierSchema,
    originatingDeploymentId: personalIdentifierSchema,
    originatingDeviceId: personalIdentifierSchema,
    originatingProfileId: personalIdentifierSchema,
    directoryIncarnationId: personalIdentifierSchema
  })
  .strict();

/** Bind only from native provenance or verified source transport, never a replica Session row. */
export const personalSourceReferenceSchema = z
  .object({
    ...owned,
    originatingDeploymentId: personalIdentifierSchema,
    originatingDeviceId: personalIdentifierSchema,
    logicalSessionId: z
      .string()
      .min(1)
      .max(512)
      .refine(
        (value) =>
          [...value].every(
            (character) =>
              character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
          ),
        "Logical Conversation identity cannot contain control characters"
      )
  })
  .strict();

/** Named groupings and non-Git directories cannot be Git source context. */
export const personalGitContextSchema = z.discriminatedUnion("kind", [
  repositoryIdentitySchema.options[0],
  repositoryIdentitySchema.options[1]
]);
export type PersonalGitContext = z.infer<typeof personalGitContextSchema>;
export const personalFolderContextSchema = z
  .object({
    reference: personalFolderReferenceSchema,
    normalizedPath: z.string().min(1).max(8192),
    capturedPath: z.string().min(1).max(8192)
  })
  .strict();
export type PersonalFolderContext = z.infer<typeof personalFolderContextSchema>;

const unresolved = z
  .object({
    state: z.literal("unresolved"),
    reason: z.enum([
      "historical_unresolved",
      "missing",
      "unreliable",
      "explicit_unresolved",
      "source_context_pending",
      "source_context_conflict"
    ])
  })
  .strict();
const gitFact = z.discriminatedUnion("state", [
  z
    .object({ state: z.literal("known"), value: personalGitContextSchema })
    .strict(),
  unresolved
]);
const folderFact = z.discriminatedUnion("state", [
  z
    .object({ state: z.literal("known"), value: personalFolderContextSchema })
    .strict(),
  unresolved
]);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const assignment = <T extends z.ZodType>(fact: T) =>
  z
    .object({
      revision,
      original: fact,
      correction: z.discriminatedUnion("state", [
        z.object({ state: z.literal("original") }).strict(),
        z
          .object({
            state: z.literal("corrected"),
            value: fact,
            revisionId: personalIdentifierSchema
          })
          .strict()
      ])
    })
    .strict();

export const personalGitAssignmentSchema = assignment(gitFact);
export type PersonalGitAssignment = z.infer<typeof personalGitAssignmentSchema>;
export const personalFolderAssignmentSchema = assignment(folderFact);
export type PersonalFolderAssignment = z.infer<
  typeof personalFolderAssignmentSchema
>;

/** Source-time evidence. Capture authentication supplies the owner separately. */
export const personalFolderObservationSchema = personalFolderContextSchema
  .omit({ reference: true })
  .extend({
    identity: personalFolderReferenceSchema.omit({ ownerUserId: true }),
    observedAt: z.string().datetime({ offset: true })
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      normalizeRecordedProjectDirectory(value.capturedPath) !==
        value.normalizedPath ||
      normalizeRecordedProjectDirectory(value.normalizedPath) !==
        value.normalizedPath
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Folder evidence requires an exact normalized absolute directory"
      });
  });
export type PersonalFolderObservation = z.infer<
  typeof personalFolderObservationSchema
>;

export const personalSourceContextSchema = z
  .object({
    version: z.literal(1),
    source: personalSourceReferenceSchema,
    git: personalGitAssignmentSchema,
    folder: personalFolderAssignmentSchema
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const fact of [
      value.folder.original,
      ...(value.folder.correction.state === "corrected"
        ? [value.folder.correction.value]
        : [])
    ]) {
      if (
        fact.state === "known" &&
        fact.value.reference.ownerUserId !== value.source.ownerUserId
      )
        ctx.addIssue({
          code: "custom",
          message: "Folder context belongs to another owner"
        });
    }
  });

/** An explicit unresolved correction suppresses the original until an explicit reset. */
export const effectivePersonalSourceFact = <T>(assignment: {
  original: T;
  correction: { state: "original" } | { state: "corrected"; value: T };
}): T =>
  assignment.correction.state === "corrected"
    ? assignment.correction.value
    : assignment.original;

export type PersonalProjectReference = z.infer<
  typeof personalProjectReferenceSchema
>;
export type PersonalFolderReference = z.infer<
  typeof personalFolderReferenceSchema
>;
/** A presentation/routing key; authorization still compares the full reference. */
export const personalFolderScopeId = (
  input: PersonalFolderReference
): string => {
  const folder = personalFolderReferenceSchema.parse(input);
  return `folder:${[
    folder.ownerUserId,
    folder.originatingDeploymentId,
    folder.originatingDeviceId,
    folder.originatingProfileId,
    folder.directoryIncarnationId,
    folder.folderId
  ].join(":")}`;
};
export type PersonalSourceReference = z.infer<
  typeof personalSourceReferenceSchema
>;
export type PersonalSourceContext = z.infer<typeof personalSourceContextSchema>;
