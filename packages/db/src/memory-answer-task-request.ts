import {
  repositoryIdentitySchema,
  repositoryRecallContextSchema,
  repositoryScopeId,
  requirePortableTeamRepositoryContext
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
  teamWorkspaceId: string | null | undefined
) =>
  repositoryScopeId(
    teamWorkspaceId
      ? requirePortableTeamRepositoryContext(snapshot.repository_context)
      : repositoryRecallContextSchema.parse(snapshot.repository_context)
  );

/** Validate pinned routing before a request enters the durable queue. */
export const validateMemoryAnswerTaskRequest = (
  request: unknown,
  teamWorkspaceId?: string
) => {
  const snapshot = inputFrom(request);
  if (!snapshot) return;
  if (
    snapshot.search_domain === "project" &&
    snapshot.project_id !== projectScope(snapshot, teamWorkspaceId)
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
      ? projectScope(snapshot, teamWorkspaceId)
      : snapshot.project_id;
  if ((project ?? null) !== (question.projectId ?? null))
    throw new Error("Final Memory Question project does not match task");
};
