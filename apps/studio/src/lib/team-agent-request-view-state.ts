import type { TeamAgentRequest } from "@koed/shared/team-agent-requests";

export function teamAgentRequestCardActions(
  request: TeamAgentRequest,
  viewerId: string
) {
  return {
    canReview: request.status === "awaiting_owner" && request.canReview,
    canOpenPrivateChat:
      request.status === "accepted" && request.ownerId === viewerId,
    canViewWork: request.status === "accepted" && Boolean(request.jobId)
  };
}

export function teamAgentRequestStatusLabel(request: TeamAgentRequest): string {
  if (request.status === "awaiting_owner") return "Awaiting owner";
  if (request.status !== "accepted") {
    return request.status === "unavailable"
      ? "No longer available"
      : request.status[0]!.toUpperCase() + request.status.slice(1);
  }

  const state = request.executionStatus ?? request.jobStatus;
  if (state === "queued") return "Accepted · queued";
  if (state === "running") return "Accepted · working";
  if (state === "waiting") return "Accepted · waiting for input";
  if (state === "succeeded") return "Completed";
  if (state === "failed") return "Failed";
  if (state === "canceled") return "Canceled";
  if (state === "interrupted") return "Interrupted";
  if (state === "offline") return "Accepted · runner offline";
  if (state === "unknown") return "Accepted · status unavailable";
  return request.jobId
    ? "Accepted · waiting to start"
    : "Accepted · status unavailable";
}

export function teamAgentRequestHasTerminalOutcome(
  request: Pick<TeamAgentRequest, "status" | "executionStatus" | "jobStatus">
): boolean {
  return (
    request.status === "accepted" &&
    ["succeeded", "failed", "canceled", "interrupted"].includes(
      request.executionStatus ?? request.jobStatus ?? ""
    )
  );
}

export function teamAgentRequestCanAccept(input: {
  request: Pick<TeamAgentRequest, "status">;
  review: {
    executionId: string | null;
    privateGoal: string;
  };
  goal: string;
  executionId: string | null;
}): boolean {
  return (
    input.request.status === "awaiting_owner" &&
    Boolean(input.executionId) &&
    Boolean(input.goal.trim()) &&
    input.review.executionId === input.executionId &&
    input.review.privateGoal === input.goal
  );
}

export function teamAgentRequestReviewHref(input: {
  request: Pick<TeamAgentRequest, "id" | "teamId" | "agentId" | "version">;
  review: Pick<TeamAgentRequest, "version"> & { executionId: string | null };
  projectId: string;
  draft?: string;
}): string {
  const query = new URLSearchParams({
    chat: "1",
    agent: input.request.agentId,
    project: input.projectId,
    teamRequest: input.request.id,
    teamRequestTeam: input.request.teamId
  });
  query.set("teamRequestVersion", String(input.request.version));
  query.set("teamReviewVersion", String(input.review.version));
  if (input.review.executionId)
    query.set("execution", input.review.executionId);
  if (input.draft) query.set("draft", input.draft.slice(0, 2_400));
  return `/?${query.toString()}`;
}
