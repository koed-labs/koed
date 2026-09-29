import type { StudioTeamDraft } from "./studio-collaboration-client";
import type { CollaborationDurableSend, CollaborationMessage } from "@koed/shared/collaboration";

export const mayPersistTeamDraft = (input: {
  authorityKey: string | null;
  hydratedAuthorityKey: string | null;
}): boolean => Boolean(input.authorityKey && input.authorityKey === input.hydratedAuthorityKey);

export const mayCompleteDraftHydration = (input: { active: boolean; revoked: boolean }): boolean =>
  input.active && !input.revoked;

export const teamDraftForHydration = (stored: StudioTeamDraft | null): StudioTeamDraft =>
  stored ?? { text: "", pendingSend: null };

export const confirmedPendingSend = (
  draft: StudioTeamDraft,
  confirmedClientMessageId: string
): StudioTeamDraft => draft.pendingSend?.clientMessageId === confirmedClientMessageId
  ? { ...draft, pendingSend: null }
  : draft;

export const resolvePendingSend = (
  draft: StudioTeamDraft,
  pendingSendId: string,
  outcome: "accepted" | "not-sent",
  originalBody: string
): StudioTeamDraft => {
  if (draft.pendingSend?.clientMessageId !== pendingSendId) return draft;
  return {
    ...draft,
    text: outcome === "not-sent" && draft.text.length === 0 ? originalBody : draft.text,
    pendingSend: null
  };
};

export const retainPendingSendAfterUncertainOutcome = (
  draft: StudioTeamDraft,
  pendingSend: NonNullable<StudioTeamDraft["pendingSend"]>
): StudioTeamDraft => draft.pendingSend && draft.pendingSend.clientMessageId !== pendingSend.clientMessageId
  ? draft
  : { ...draft, pendingSend };

export const visibleReadMayAdvance = (input: {
  messageId: string;
  sequence: number;
  senderId: string;
  principalUserId: string;
  focused: boolean;
  lastReportedSequence: number;
}): boolean => Boolean(
  input.focused && input.messageId && input.senderId !== input.principalUserId &&
  Number.isSafeInteger(input.sequence) && input.sequence > input.lastReportedSequence
);

export const readSequenceFor = (positions: ReadonlyMap<string, number>, authorityKey: string): number =>
  positions.get(authorityKey) ?? 0;

export const rememberReadSequence = (positions: Map<string, number>, authorityKey: string, sequence: number): number => {
  const next = Math.max(readSequenceFor(positions, authorityKey), sequence);
  positions.set(authorityKey, next);
  return next;
};

export const readCompletionMayApply = (capturedAuthorityKey: string, currentAuthorityKey: string | null): boolean =>
  capturedAuthorityKey === currentAuthorityKey;

export const realtimeUpdateMayAcknowledge = (input: {
  eventTeamId: string;
  eventThreadId: string | null;
  currentTeamId: string;
  currentThreadId: string;
  historyApplied: boolean;
  snapshotApplied: boolean;
}): boolean => input.eventTeamId === input.currentTeamId &&
  input.snapshotApplied &&
  (input.historyApplied || (input.eventThreadId !== null && input.currentThreadId !== input.eventThreadId));

export const mergeTeamMessages = (
  current: CollaborationMessage[],
  incoming: CollaborationMessage[],
  limit = 250
): CollaborationMessage[] => [...current, ...incoming]
  .filter((message, index, all) => all.findIndex((other) => other.id === message.id) === index)
  .sort((left, right) => left.sequence - right.sequence)
  .slice(-limit);

export const studioSelectionMatches = (
  captured: { teamId: string; threadId: string },
  current: { teamId: string; threadId: string }
): boolean => captured.teamId === current.teamId && captured.threadId === current.threadId;

export const studioRequestMayApply = (input: {
  capturedGeneration: number;
  currentGeneration: number;
  mounted: boolean;
}): boolean => input.mounted && input.capturedGeneration === input.currentGeneration;

export const directMessageAttemptKey = (teamId: string, principalUserId: string, participantUserIds: string[]): string =>
  `${teamId}:${principalUserId}:${[...new Set(participantUserIds)].sort().join(",")}`;

export const directMessageParticipantsAreEligible = (input: {
  principalUserId: string;
  participantUserIds: string[];
  enabledMemberIds: ReadonlySet<string>;
}): boolean => input.participantUserIds.length > 0 &&
  new Set(input.participantUserIds).size === input.participantUserIds.length &&
  input.participantUserIds.every((userId) => userId !== input.principalUserId && input.enabledMemberIds.has(userId));

export const directMessageThreadMatchesRequest = (input: {
  requestedTeamId: string;
  principalUserId: string;
  participantUserIds: string[];
  thread: unknown;
}): boolean => {
  if (!input.thread || typeof input.thread !== "object") return false;
  const thread = input.thread as { scope?: unknown; teamId?: unknown; kind?: unknown; participants?: unknown };
  if (!Array.isArray(thread.participants) || !thread.participants.every((participant) =>
    participant && typeof participant === "object" && "id" in participant && typeof participant.id === "string"
  )) return false;
  const expectedParticipants = [input.principalUserId, ...input.participantUserIds];
  const expectedSet = new Set(expectedParticipants);
  const returnedIds = thread.participants.map((participant) => participant.id as string);
  const returnedSet = new Set(returnedIds);
  const expectedKind = input.participantUserIds.length === 1 ? "dm" : "group_dm";
  return input.participantUserIds.length > 0 &&
    expectedSet.size === expectedParticipants.length &&
    thread.scope === "team" &&
    thread.teamId === input.requestedTeamId &&
    thread.kind === expectedKind &&
    returnedSet.size === returnedIds.length &&
    returnedSet.size === expectedSet.size &&
    [...expectedSet].every((participantId) => returnedSet.has(participantId));
};

export const durableSendMatchesAuthority = (
  send: Pick<CollaborationDurableSend, "authority">,
  authorityKey: string | null
): boolean => {
  if (!authorityKey || send.authority.scope !== "team") return false;
  return JSON.stringify({
    backendId: send.authority.backendId,
    principalUserId: send.authority.principalUserId,
    teamId: send.authority.teamId,
    threadId: send.authority.threadId
  }) === authorityKey;
};

export const durableSendStatus = (
  send: Pick<CollaborationDurableSend, "state" | "failure">
): string | null => {
  if (send.state === "queued") return "Sending…";
  if (send.state === "manual_retry") return send.failure?.userMessage ?? "Send is queued for retry.";
  if (send.state === "failed") return send.failure?.userMessage ?? "Message could not be sent.";
  return null;
};

export const durableSendFailureDisposition = (failureCode: string | null): "authority_lost" | "not_sent" =>
  failureCode === "access_revoked" || failureCode === "permission_denied" || failureCode === "not_available"
    ? "authority_lost"
    : "not_sent";

export const describeStudioCommandFailure = (failure: unknown): {
  revoked: boolean;
  message: string;
} => {
  const value = failure && typeof failure === "object" ? failure as { code?: unknown; message?: unknown } : null;
  return {
    revoked: value?.code === "access_revoked",
    message: typeof value?.message === "string" && value.message.length > 0
      ? value.message
      : "Team channel could not be loaded. Try again."
  };
};
