import {
  authorizedPersonalSelectionSnapshot,
  personalSelectionFromTaskRequest,
  snapshotPinnedPersonalSelection,
  repositoryIdentitySchema,
  personalSelectionLegacyScope,
  repositoryRecallContextSchema,
  repositoryScopeId,
  requirePortableTeamRepositoryContext,
  type PersonalSelectionSnapshot
} from "@koed/shared";
import type { CreateFinalMemoryQuestionInput } from "./memory-question-repository.js";

const inputFrom = (request: unknown): Record<string, unknown> | null => {
  if (
    !request ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    !("input" in request)
  )
    return null;
  const input = request.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  return Object.fromEntries(Object.entries(input));
};
const projectScope = (
  snapshot: Record<string, unknown>,
  teamWorkspaceId: string | null | undefined,
  selection?: PersonalSelectionSnapshot
) =>
  !teamWorkspaceId &&
  selection?.version === 1 &&
  (selection.target.kind === "project" || selection.target.kind === "folder")
    ? personalSelectionLegacyScope(selection).projectId!
    : repositoryScopeId(
        teamWorkspaceId
          ? requirePortableTeamRepositoryContext(snapshot.repository_context)
          : repositoryRecallContextSchema.parse(snapshot.repository_context)
      );

/** The database binds the encrypted request to its authenticated owner before acceptance. */
export const pinMemoryAnswerTaskSelection = (
  request: Record<string, unknown>,
  ownerUserId: string,
  teamWorkspaceId?: string
): Record<string, unknown> => {
  validateMemoryAnswerTaskRequest(request, teamWorkspaceId);
  if (teamWorkspaceId) {
    if (request.selection !== undefined || request.requestVersion !== undefined)
      throw new Error(
        "Personal selection contracts are not supported for Team tasks"
      );
    return request;
  }
  const input = inputFrom(request);
  if (!input) throw new Error("Memory Answer requires a pinned input");
  const supplied = personalSelectionFromTaskRequest({ ...request, input });
  const selection = supplied
    ? authorizedPersonalSelectionSnapshot(supplied, ownerUserId)
    : snapshotPinnedPersonalSelection(ownerUserId, input);
  return { ...request, requestVersion: 1, selection };
};

/** Validate pinned routing before a request enters the durable queue. */
export const validateMemoryAnswerTaskRequest = (
  request: unknown,
  teamWorkspaceId?: string
) => {
  const snapshot = inputFrom(request);
  if (!snapshot) return;
  const selection =
    request && typeof request === "object" && !Array.isArray(request)
      ? personalSelectionFromTaskRequest({ ...request, input: snapshot })
      : undefined;
  if (
    snapshot.search_domain === "project" &&
    snapshot.project_id !== projectScope(snapshot, teamWorkspaceId, selection)
  )
    throw new Error(
      "Project task target must match its pinned repository context"
    );
  if (!teamWorkspaceId && snapshot.search_domain === "global") {
    if (snapshot.repository_context === undefined)
      throw new Error(
        "Global task requires its pinned repository context or explicit null"
      );
    if (snapshot.repository_context !== null)
      repositoryIdentitySchema.parse(snapshot.repository_context);
  }
  if ((snapshot.team_workspace_id ?? null) !== (teamWorkspaceId ?? null))
    throw new Error("Memory Answer request scope does not match task");
};

/** Bind a completed question to the original request, never the worker's current cwd. */
export const validateMemoryAnswerTaskCompletion = (
  request: unknown,
  teamWorkspaceId: string | null,
  question: Pick<
    CreateFinalMemoryQuestionInput,
    | "query"
    | "teamWorkspaceId"
    | "retrievalScope"
    | "searchDomain"
    | "sessionId"
    | "projectId"
  >
) => {
  validateMemoryAnswerTaskRequest(request, teamWorkspaceId ?? undefined);
  if (
    (question.teamWorkspaceId ?? null) !== teamWorkspaceId ||
    (question.retrievalScope ?? "personal") !== "personal"
  )
    throw new Error("Final Memory Question scope does not match task");
  const snapshot = inputFrom(request);
  if (
    !snapshot ||
    typeof snapshot.query !== "string" ||
    snapshot.query.trim() !== question.query.trim()
  )
    throw new Error("Final Memory Question query does not match task");
  if (
    (snapshot.search_domain !== undefined &&
      snapshot.search_domain !== question.searchDomain) ||
    (snapshot.session_id ?? null) !== (question.sessionId ?? null)
  )
    throw new Error("Final Memory Question search scope does not match task");
  const project =
    snapshot.search_domain === "project"
      ? projectScope(
          snapshot,
          teamWorkspaceId,
          request && typeof request === "object" && !Array.isArray(request)
            ? personalSelectionFromTaskRequest({ ...request, input: snapshot })
            : undefined
        )
      : snapshot.project_id;
  if ((project ?? null) !== (question.projectId ?? null))
    throw new Error("Final Memory Question project does not match task");
};
