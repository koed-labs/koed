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
