import { personalFolderScopeId } from "./personal-source-contract.js";
import { z } from "zod";
import { repositoryIdentitySchema } from "./repository-identity.js";
import {
  repositoryRecallContextSchema,
  repositoryScopeId
} from "./repository-recall.js";
import { personalOwnerIdSchema } from "./personal-source-contract.js";
import { personalSelectionSchema } from "./personal-selection-contract.js";

/** Version zero preserves pre-membership assignment semantics until the caller migrates. */
export const legacyPersonalSelectionSchema = z
  .object({
    version: z.literal(0),
    ownerUserId: personalOwnerIdSchema,
    target: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("legacy_project"),
          repository: repositoryRecallContextSchema
        })
        .strict(),
      z
        .object({
          kind: z.literal("legacy_session"),
          sessionId: z.string().uuid().toLowerCase()
        })
        .strict(),
      z.object({ kind: z.literal("global") }).strict()
    ]),
    callerRepositoryContext: repositoryIdentitySchema.nullable()
  })
  .strict();

export const personalSelectionSnapshotSchema = z.union([
  legacyPersonalSelectionSchema,
  personalSelectionSchema
]);
export type PersonalSelectionSnapshot = z.infer<
  typeof personalSelectionSnapshotSchema
>;

export const personalSelectionCompatibilityError = (message: string): Error =>
  Object.assign(new Error(message), {
    statusCode: 400,
    memoryAnswerTaskErrorCode: "personal_selection_incompatible",
    retryable: false
  });

const pinnedLegacyInputSchema = z.object({
  search_domain: z.enum(["project", "session", "global"]),
  project_id: z.string().min(1).optional(),
  session_id: z.string().uuid().optional(),
  repository_context: repositoryIdentitySchema.nullable().optional()
});

/** No discovery or defaults are allowed here: the adapter already pinned the request. */
export const snapshotPinnedPersonalSelection = (
  ownerUserId: string,
  value: unknown
): PersonalSelectionSnapshot => {
  const input = pinnedLegacyInputSchema.parse(value);
  if (input.search_domain === "project") {
    const repository = repositoryRecallContextSchema.parse(
      input.repository_context
    );
    if (input.project_id !== repositoryScopeId(repository))
      throw personalSelectionCompatibilityError(
        "Project selection does not match its pinned repository context"
      );
    return legacyPersonalSelectionSchema.parse({
      version: 0,
      ownerUserId,
      target: { kind: "legacy_project", repository },
      callerRepositoryContext: null
    });
  }
  if (input.search_domain === "session") {
    if (!input.session_id)
      throw personalSelectionCompatibilityError(
        "Conversation selection requires its pinned Session identity"
      );
    return legacyPersonalSelectionSchema.parse({
      version: 0,
      ownerUserId,
      target: { kind: "legacy_session", sessionId: input.session_id },
      callerRepositoryContext: null
    });
  }
  if (input.repository_context === undefined)
    throw personalSelectionCompatibilityError(
      "Global selection requires pinned caller context or explicit null"
    );
  return legacyPersonalSelectionSchema.parse({
    version: 0,
    ownerUserId,
    target: { kind: "global" },
    callerRepositoryContext: input.repository_context
  });
};

/** Compatibility transport projection while the remaining target adapters migrate. */
export const personalSelectionLegacyScope = (
  value: PersonalSelectionSnapshot
): {
  searchDomain: "global" | "project" | "session";
  projectId?: string;
  sessionId?: string;
  repositoryContext?: z.infer<typeof repositoryIdentitySchema> | null;
} => {
  const selection = personalSelectionSnapshotSchema.parse(value);
  if (selection.target.kind === "global")
    return {
      searchDomain: "global",
      repositoryContext: selection.callerRepositoryContext
    };
  if (selection.version === 0) {
    if (selection.target.kind === "legacy_session")
      return { searchDomain: "session", sessionId: selection.target.sessionId };
    return {
      searchDomain: "project",
      projectId: repositoryScopeId(selection.target.repository),
      repositoryContext: selection.target.repository
    };
  }
  if (selection.target.kind === "project")
    return {
      searchDomain: "project",
      projectId: selection.target.project.projectId
    };
  if (selection.target.kind === "folder")
    return {
      searchDomain: "project",
      projectId: personalFolderScopeId(selection.target.folder)
    };
  if (selection.target.kind === "repository")
    return {
      searchDomain: "project",
      projectId: repositoryScopeId(selection.target.repository),
      repositoryContext: selection.target.repository
    };
  throw personalSelectionCompatibilityError(
    `Personal ${selection.target.kind} selection is not available in this caller version`
  );
};

/** Check owner scope even for Global and Git targets, whose target carries no owner field. */
export const authorizedPersonalSelectionSnapshot = (
  value: unknown,
  ownerUserId: string
): PersonalSelectionSnapshot => {
  const selection = personalSelectionSnapshotSchema.safeParse(value);
  if (!selection.success)
    throw personalSelectionCompatibilityError(
      "Unsupported Personal selection version or invalid selection"
    );
  if (selection.data.ownerUserId !== ownerUserId)
    throw Object.assign(
      new Error("Personal selection belongs to another owner"),
      { statusCode: 403, retryable: false }
    );
  return selection.data;
};

export const assertPersonalSelectionInput = (
  selection: PersonalSelectionSnapshot,
  value: unknown
): void => {
  const input = pinnedLegacyInputSchema.parse(value);
  const scope = personalSelectionLegacyScope(selection);
  if (
    input.search_domain !== scope.searchDomain ||
    (scope.searchDomain === "project" &&
      input.project_id !== scope.projectId) ||
    (scope.searchDomain === "session" &&
      input.session_id?.toLowerCase() !== scope.sessionId) ||
    (scope.searchDomain === "global" &&
      JSON.stringify(input.repository_context) !==
        JSON.stringify(scope.repositoryContext))
  )
    throw personalSelectionCompatibilityError(
      "Memory Answer input does not match its accepted Personal selection"
    );
};

/** A missing version means the original legacy task contract, not an invitation to rediscover context. */
export const personalSelectionFromTaskRequest = (request: {
  requestVersion?: unknown;
  selection?: unknown;
  input: unknown;
}): PersonalSelectionSnapshot | undefined => {
  if (request.requestVersion === undefined && request.selection === undefined)
    return undefined;
  if (request.requestVersion !== 1 || request.selection === undefined)
    throw personalSelectionCompatibilityError(
      "Unsupported Personal Memory Answer request version"
    );
  const parsed = personalSelectionSnapshotSchema.safeParse(request.selection);
  if (!parsed.success)
    throw personalSelectionCompatibilityError(
      "Unsupported Personal selection version or invalid selection"
    );
  assertPersonalSelectionInput(parsed.data, request.input);
  return parsed.data;
};
