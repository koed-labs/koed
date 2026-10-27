import { personalProjectDefaultIdentity } from "./personal-project-default.js";
import {
  personalProjectSourceTargetSchema,
  personalProjectSourceSelectorKey
} from "./personal-project-source-target.js";
import { z } from "zod";
import {
  personalFolderReferenceSchema,
  personalGitContextSchema,
  personalIdentifierSchema,
  personalProjectReferenceSchema,
  personalSourceReferenceSchema
} from "./personal-source-contract.js";

export const personalInclusionSelectorSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("session"),
      source: personalSourceReferenceSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("repository"),
      repository: personalGitContextSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("folder"),
      folder: personalFolderReferenceSchema
    })
    .strict()
]);

/** Immutable revision; replaces is the exact reviewed frontier, including retained removals. */
export const personalMembershipRevisionSchema = z
  .object({
    version: z.literal(1),
    project: personalProjectReferenceSchema,
    entityId: personalIdentifierSchema,
    revisionId: personalIdentifierSchema,
    authorDeviceId: personalIdentifierSchema,
    automaticDefault: z
      .object({
        sourceKey: z.string().regex(/^source_default_[a-f0-9]{64}$/),
        target: personalProjectSourceTargetSchema
      })
      .strict()
      .optional(),
    automaticRetirement: z
      .object({
        sourceKey: z.string().regex(/^source_default_[a-f0-9]{64}$/),
        target: personalProjectSourceTargetSchema
      })
      .strict()
      .optional(),
    replaces: z.array(personalIdentifierSchema).max(1024),
    operation: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("set_project"),
          name: z.string().trim().min(1).max(160)
        })
        .strict(),
      z.object({ kind: z.literal("delete_project") }).strict(),
      z
        .object({
          kind: z.literal("include"),
          selector: personalInclusionSelectorSchema
        })
        .strict(),
      z.object({ kind: z.literal("remove_inclusion") }).strict(),
      z
        .object({
          kind: z.literal("exclude"),
          source: personalSourceReferenceSchema
        })
        .strict(),
      z.object({ kind: z.literal("clear_exclusion") }).strict()
    ])
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      new Set(value.replaces).size !== value.replaces.length ||
      value.replaces.includes(value.revisionId)
    )
      ctx.addIssue({
        code: "custom",
        message: "Invalid reviewed revision frontier"
      });
    const op = value.operation;
    if (value.automaticDefault) {
      const initial = value.automaticDefault,
        identity = personalProjectDefaultIdentity(initial.target);
      if (
        value.replaces.length ||
        (op.kind !== "set_project" && op.kind !== "include") ||
        identity.sourceKey !== initial.sourceKey ||
        identity.projectIdentity !== value.project.projectId ||
        (initial.target.kind === "folder" &&
          initial.target.folder.ownerUserId !== value.project.ownerUserId) ||
        (op.kind === "include" &&
          (op.selector.kind === "session" ||
            personalProjectSourceSelectorKey(op.selector) !==
              personalProjectSourceSelectorKey(initial.target)))
      )
        ctx.addIssue({
          code: "custom",
          message:
            "Automatic default provenance must identify an initial Project or seed rule for the same canonical source"
        });
    }

    if (
      (op.kind === "delete_project" ||
        op.kind === "remove_inclusion" ||
        op.kind === "clear_exclusion") &&
      value.replaces.length === 0
    )
      ctx.addIssue({
        code: "custom",
        message: "Removal requires reviewed revisions"
      });
    if (
      (op.kind === "set_project" || op.kind === "delete_project") &&
      value.entityId !== value.project.projectId
    )
      ctx.addIssue({
        code: "custom",
        message: "Project revision must address its Project identity"
      });
    if (value.automaticRetirement) {
      const source = value.automaticRetirement,
        identity = personalProjectDefaultIdentity(source.target);
      if (
        value.automaticDefault ||
        !value.replaces.length ||
        op.kind !== "delete_project" ||
        identity.sourceKey !== source.sourceKey ||
        identity.projectIdentity !== value.project.projectId ||
        (source.target.kind === "folder" &&
          source.target.folder.ownerUserId !== value.project.ownerUserId)
      )
        ctx.addIssue({
          code: "custom",
          message:
            "Automatic retirement must retain a reviewed default Project source"
        });
    }
    const reference =
      op.kind === "exclude"
        ? op.source
        : op.kind === "include"
          ? op.selector.kind === "session"
            ? op.selector.source
            : op.selector.kind === "folder"
              ? op.selector.folder
              : null
          : null;
    if (reference && reference.ownerUserId !== value.project.ownerUserId)
      ctx.addIssue({
        code: "custom",
        message: "Membership reference belongs to another owner"
      });
  });

export const personalMembershipReasonSchema = z
  .object({
    inclusionId: personalIdentifierSchema,
    revisionId: personalIdentifierSchema,
    kind: z.enum(["session", "repository", "folder"])
  })
  .strict();

/** Missing source references are pending; they are never synthesized into source rows. */
export const personalSourceBindingSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("pending"),
      source: personalSourceReferenceSchema
    })
    .strict(),
  z
    .object({
      state: z.literal("available"),
      source: personalSourceReferenceSchema,
      localSessionId: z.string().uuid()
    })
    .strict()
]);

export type PersonalMembershipRevision = z.infer<
  typeof personalMembershipRevisionSchema
>;
/** User-authored heads supersede unobserved automatic roots. Real concurrent User
 * heads still conflict. Every original revision and causal head remains retained. */
export const selectPersonalMembershipHead = (
  heads: PersonalMembershipRevision[]
): PersonalMembershipRevision | null => {
  if (!heads.length) return null;
  const userHeads = heads.filter(
    (head) => !head.automaticDefault && !head.automaticRetirement
  );
  if (userHeads.length) return userHeads.length === 1 ? userHeads[0]! : null;
  const sourceKey = (heads[0]!.automaticDefault ??
    heads[0]!.automaticRetirement)!.sourceKey;
  if (
    heads.some(
      (head) =>
        (head.automaticDefault ?? head.automaticRetirement)?.sourceKey !==
        sourceKey
    )
  )
    return null;
  const retired = heads.filter((head) => head.automaticRetirement);
  return [...(retired.length ? retired : heads)].sort((a, b) =>
    a.revisionId < b.revisionId ? -1 : a.revisionId > b.revisionId ? 1 : 0
  )[0]!;
};

export type PersonalMembershipReason = z.infer<
  typeof personalMembershipReasonSchema
>;
export type PersonalSourceBinding = z.infer<typeof personalSourceBindingSchema>;

/** Metadata for an exclusion that may not yet have a native source/view row. */
export const personalMembershipExclusionSyncSchema = z
  .object({
    entityId: personalIdentifierSchema,
    state: z.enum(["pending", "available", "conflict"]),
    heads: z.array(personalIdentifierSchema).max(1024),
    blocked: z.boolean()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.state === "available" && value.heads.length !== 1) ||
      (value.state === "conflict" && value.heads.length < 2) ||
      (value.state !== "available" && !value.blocked) ||
      new Set(value.heads).size !== value.heads.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Exclusion state does not match its retained frontier"
      });
  });
