import type { StudioTeamDraft } from "./studio-collaboration-client";
import type { CollaborationMessage } from "@koed/shared/collaboration";

export const mayPersistTeamDraft = (input: {
  authorityKey: string | null;
  hydratedAuthorityKey: string | null;
}): boolean => Boolean(input.authorityKey && input.authorityKey === input.hydratedAuthorityKey);

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
