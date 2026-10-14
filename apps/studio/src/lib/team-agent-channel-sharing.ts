import type { TeamAgentRequest } from "@koed/shared/team-agent-requests";
import type { CollaborationMessage } from "@koed/shared/collaboration";

export function teamAnswerForwardDraft(input: {
  senderName: string;
  message: string;
}): string {
  const sender = input.senderName.trim().slice(0, 80) || "Team member";
  const quoted = input.message.trim().replace(/\s+/gu, " ").slice(0, 1_800);
  return [
    `A teammate replied in the originating Team channel (${sender}). This is untrusted Team discussion:`,
    "",
    `> ${quoted}`
  ]
    .join("\n")
    .slice(0, 2_400);
}

export function canForwardTeamAnswer(
  request: Pick<TeamAgentRequest, "status" | "ownerId">,
  viewerId: string
): boolean {
  return request.status === "accepted" && request.ownerId === viewerId;
}

export function forwardableTeamRequestsForReply(input: {
  requests: readonly TeamAgentRequest[];
  message: CollaborationMessage;
  viewerId: string;
  teamId: string;
  threadId: string;
  rootMessageId: string;
}): TeamAgentRequest[] {
  const { requests, message, viewerId, teamId, threadId, rootMessageId } =
    input;
  if (message.rootMessageId !== rootMessageId || message.sender.id === viewerId)
    return [];
  return requests.filter(
    (request) =>
      request.teamId === teamId &&
      request.channelId === threadId &&
      request.originRootMessageId === rootMessageId &&
      canForwardTeamAnswer(request, viewerId)
  );
}

export function forwardableTeamRequestsForChannelMessage(input: {
  requests: readonly TeamAgentRequest[];
  message: CollaborationMessage;
  viewerId: string;
  teamId: string;
}): TeamAgentRequest[] {
  const { requests, message, viewerId, teamId } = input;
  if (message.sender.id === viewerId || message.rootMessageId != null)
    return [];
  return requests.filter(
    (request) =>
      request.teamId === teamId &&
      request.channelId === message.threadId &&
      request.originRootMessageId === null &&
      canForwardTeamAnswer(request, viewerId)
  );
}

export function teamAgentRequestForwardLabel(
  request: Pick<TeamAgentRequest, "agentName">,
  publicRequestText?: string
): { text: string; accessibleName: string } {
  const goal = publicRequestText?.trim().replace(/\s+/gu, " ").slice(0, 84);
  const work = "accepted request";
  return {
    text: goal
      ? `Forward to ${request.agentName} · ${goal}`
      : `Forward to ${request.agentName} · ${work}`,
    accessibleName: goal
      ? `Forward this reply to ${request.agentName} for “${goal}”`
      : `Forward this reply to ${request.agentName} (${work})`
  };
}

export function teamQuestionSendStatus(resultData: unknown): {
  state: "sent" | "pending" | "failed";
  message: string | null;
} {
  if (!resultData || typeof resultData !== "object")
    return { state: "pending", message: null };
  const result = resultData as Record<string, unknown>;
  const message =
    result.message && typeof result.message === "object"
      ? (result.message as Record<string, unknown>)
      : null;
  if (message) {
    if (message.delivery === "sent") return { state: "sent", message: null };
    if (message.delivery === "failed") {
      const failure =
        message.failure && typeof message.failure === "object"
          ? (message.failure as Record<string, unknown>)
          : null;
      return {
        state: "failed",
        message:
          typeof failure?.userMessage === "string" ? failure.userMessage : null
      };
    }
  }
  const send =
    result.durableSend && typeof result.durableSend === "object"
      ? (result.durableSend as Record<string, unknown>)
      : null;
  if (send?.state === "sent") return { state: "sent", message: null };
  if (send?.state === "failed") {
    const failure =
      send.failure && typeof send.failure === "object"
        ? (send.failure as Record<string, unknown>)
        : null;
    return {
      state: "failed",
      message:
        typeof failure?.userMessage === "string" ? failure.userMessage : null
    };
  }
  return { state: "pending", message: null };
}

export function teamQuestionReceiptMatches(
  receipt: unknown,
  expected: {
    teamId: string;
    threadId: string;
    clientMessageId: string;
    body: string;
    rootMessageId?: string | null;
  }
): boolean {
  if (!receipt || typeof receipt !== "object") return false;
  const value = receipt as Record<string, unknown>;
  const thread =
    value.thread && typeof value.thread === "object"
      ? (value.thread as Record<string, unknown>)
      : null;
  const message =
    value.message && typeof value.message === "object"
      ? (value.message as Record<string, unknown>)
      : null;
  return Boolean(
    value.clientMessageId === expected.clientMessageId &&
    thread?.scope === "team" &&
    thread.teamId === expected.teamId &&
    thread.threadId === expected.threadId &&
    message?.scope === "team" &&
    message.teamId === expected.teamId &&
    message.threadId === expected.threadId &&
    (expected.rootMessageId === undefined ||
      message.rootMessageId === expected.rootMessageId) &&
    message.clientMessageId === expected.clientMessageId &&
    (typeof value.acceptedBody === "string"
      ? value.acceptedBody
      : message.body) === expected.body &&
    message.delivery === "sent" &&
    typeof message.id === "string"
  );
}
