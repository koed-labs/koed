import type { StudioTeamDraft } from "./studio-collaboration-client";
import type { CollaborationMessage } from "@koed/shared/collaboration";

export const mayPersistTeamDraft = (input: {
  authorityKey: string | null;
  hydratedAuthorityKey: string | null;
}): boolean => Boolean(input.authorityKey && input.authorityKey === input.hydratedAuthorityKey);

export const mayCompleteDraftHydration = (input: { active: boolean; revoked: boolean }): boolean =>
  input.active && !input.revoked;

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
