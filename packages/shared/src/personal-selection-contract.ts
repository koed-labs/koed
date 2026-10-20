import { z } from "zod";
import { repositoryIdentitySchema } from "./repository-identity.js";
import {
  repositoryIdentityMatches,
  repositoryScopeId
} from "./repository-recall.js";
import {
  personalFolderReferenceSchema,
  personalGitContextSchema,
  personalOwnerIdSchema,
  personalProjectReferenceSchema,
  personalSourceReferenceSchema,
  type PersonalSourceReference
} from "./personal-source-contract.js";
import type { PersonalMembershipReason } from "./personal-membership-contract.js";

export const PERSONAL_SELECTION_CONTRACT_VERSION = 1;
export const personalRecallTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("project"),
      project: personalProjectReferenceSchema
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
    .strict(),
  z
    .object({
      kind: z.literal("session"),
      source: personalSourceReferenceSchema
    })
    .strict(),
  z.object({ kind: z.literal("global") }).strict()
]);
export type PersonalRecallTarget = z.infer<typeof personalRecallTargetSchema>;

/** Compare identity fields only. Display context and object key order are not identity. */
export const personalRecallTargetsEqual = (
  left: PersonalRecallTarget,
  right: PersonalRecallTarget
): boolean => {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "global":
      return true;
    case "repository":
      return (
        right.kind === "repository" &&
        repositoryIdentityMatches(left.repository, right.repository)
      );
    case "project":
      return (
        right.kind === "project" &&
        left.project.ownerUserId === right.project.ownerUserId &&
        left.project.projectId === right.project.projectId
      );
    case "folder":
      return (
        right.kind === "folder" &&
        Object.entries(left.folder).every(
          ([key, value]) =>
            right.folder[key as keyof typeof right.folder] === value
        )
      );
    case "session":
      return (
        right.kind === "session" &&
        Object.entries(left.source).every(
          ([key, value]) =>
            right.source[key as keyof typeof right.source] === value
        )
      );
  }
};

/** Caller provenance never chooses or broadens the explicit target. */
export const personalSelectionSchema = z
  .object({
    version: z.literal(PERSONAL_SELECTION_CONTRACT_VERSION),
    ownerUserId: personalOwnerIdSchema,
    target: personalRecallTargetSchema,
    callerRepositoryContext: personalGitContextSchema.nullable()
  })
  .strict()
  .superRefine((value, ctx) => {
    const target = value.target;
    const owner =
      target.kind === "project"
        ? target.project.ownerUserId
        : target.kind === "folder"
          ? target.folder.ownerUserId
          : target.kind === "session"
            ? target.source.ownerUserId
            : value.ownerUserId;
    if (owner !== value.ownerUserId)
      ctx.addIssue({
        code: "custom",
        message: "Selection target belongs to another owner"
      });
  });
export type PersonalSelection = z.infer<typeof personalSelectionSchema>;

const boundaryInputSchema = z
  .object({
    recall_target: personalRecallTargetSchema.optional(),
    search_domain: z.enum(["project", "session", "global"]).optional(),
    project_id: z.string().min(1).max(8192).optional(),
    session_id: z.string().uuid().optional(),
    repository_context: repositoryIdentitySchema.nullable().optional()
  })
  .strict();

export type PersonalSelectionResolution = {
  /** Trusted association lookup. Resolve exact aliases only; never probe a worker's cwd. */
  project?: (id: string) => PersonalRecallTarget | undefined;
  session?: (id: string) => PersonalSourceReference | undefined;
  /** Resolve from trusted caller context before acceptance. No named Project redirect. */
  defaultTarget?: Extract<
    PersonalRecallTarget,
    { kind: "repository" | "folder" }
  >;
};

/** Adapter-only decoder. Existing callers stay on their current contract until migrated. */
export const normalizePersonalSelection = (
  value: unknown,
  ownerUserId: string,
  resolution: PersonalSelectionResolution = {}
): PersonalSelection => {
  const input = boundaryInputSchema.parse(value);
  const finish = (target: PersonalRecallTarget) =>
    personalSelectionSchema.parse({
      version: PERSONAL_SELECTION_CONTRACT_VERSION,
      ownerUserId,
      target,
      callerRepositoryContext:
        input.repository_context == null ||
        input.repository_context.kind === "unresolved"
          ? null
          : personalGitContextSchema.parse(input.repository_context)
    });
  if (input.recall_target) {
    if (
      input.search_domain !== undefined ||
      input.project_id !== undefined ||
      input.session_id !== undefined
    )
      throw new TypeError(
        "Explicit recall_target cannot be combined with legacy selectors"
      );
    return finish(input.recall_target);
  }
  const domain = input.search_domain ?? "project";
  if (domain === "global") {
    if (input.project_id !== undefined || input.session_id !== undefined)
      throw new TypeError(
        "Global selection cannot contain a Project or Conversation selector"
      );
    return finish({ kind: "global" });
  }
  if (domain === "session") {
    if (!input.session_id || input.project_id !== undefined)
      throw new TypeError(
        "Conversation selection requires exactly one session_id"
      );
    const source = resolution.session?.(input.session_id);
    if (!source)
      throw new TypeError("Conversation source binding is unresolved");
    return finish({ kind: "session", source });
  }
  if (input.session_id !== undefined)
    throw new TypeError(
      "Project selection cannot contain a Conversation selector"
    );
  const context = input.repository_context;
  if (context === null || context?.kind === "unresolved")
    throw new TypeError(
      "Legacy Project selection requires resolved source context"
    );
  if (
    context?.kind === "local_project" ||
    context?.kind === "non_git_project"
  ) {
    const id = input.project_id ?? repositoryScopeId(context);
    const target = resolution.project?.(id);
    const expectedKind =
      context.kind === "local_project" ? "project" : "folder";
    // Both the explicit alias and pinned legacy context must resolve to the same target.
    const pinned = resolution.project?.(repositoryScopeId(context));
    if (
      !target ||
      target.kind !== expectedKind ||
      !pinned ||
      !personalRecallTargetsEqual(target, pinned)
    )
      throw new TypeError(
        "Legacy context requires an exact established identity mapping"
      );
    // Legacy source/group context is not Git caller provenance.
    return personalSelectionSchema.parse({
      version: 1,
      ownerUserId,
      target,
      callerRepositoryContext: null
    });
  }
  if (input.project_id !== undefined) {
    const target =
      resolution.project?.(input.project_id) ??
      (context &&
      (input.project_id === repositoryScopeId(context) ||
        input.project_id === context.root)
        ? { kind: "repository" as const, repository: context }
        : undefined);
    if (!target || target.kind === "global" || target.kind === "session")
      throw new TypeError("Unknown or unsupported legacy Project selector");
    if (
      context &&
      (target.kind !== "repository" ||
        !repositoryIdentityMatches(context, target.repository))
    )
      throw new TypeError(
        "Legacy Project selector conflicts with its pinned context"
      );
    return finish(target);
  }
  if (context) return finish({ kind: "repository", repository: context });
  if (!resolution.defaultTarget)
    throw new TypeError("Trusted Git or exact Folder context is required");
  return finish(resolution.defaultTarget);
};

/** All consumers use an owner-authorized boundary, before candidate limits and again on expansion.
 * Implementations must apply eligibility, deletion and time bounds as well as target membership.
 * This interface establishes no Team authority and performs no synthesis.
 */
export interface PersonalSelectionBoundary {
  resolveSource(
    selection: PersonalSelection,
    source: PersonalSourceReference
  ): Promise<
    | { state: "denied" | "pending" }
    | {
        state: "selected";
        source: PersonalSourceReference;
        reasons: PersonalMembershipReason[];
      }
  >;
}
