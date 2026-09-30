import type {
  StudioTeamDraft,
  StudioTeamDraftAuthority
} from "./studio-collaboration-client";
import type {
  CollaborationDurableSend,
  CollaborationMessage,
  CollaborationSendReceipt
} from "@koed/shared/collaboration";

export const mayPersistTeamDraft = (input: {
  authorityKey: string | null;
  hydratedAuthorityKey: string | null;
}): boolean =>
  Boolean(
    input.authorityKey && input.authorityKey === input.hydratedAuthorityKey
  );

export const mayCompleteDraftHydration = (input: {
  active: boolean;
  revoked: boolean;
}): boolean => input.active && !input.revoked;

export const teamDraftForHydration = (
  stored: StudioTeamDraft | null
): StudioTeamDraft => stored ?? { text: "", pendingSend: null };

export const teamDraftAfterReplyHydration = (
  stored: StudioTeamDraft | null,
  current: StudioTeamDraft | undefined
): StudioTeamDraft => {
  const saved = teamDraftForHydration(stored);
  if (!current) return saved;
  const storedPendingWasAcknowledged =
    current.receiptAckPending?.clientMessageId ===
    saved.pendingSend?.clientMessageId;
  return {
    ...saved,
    ...current,
    text: current.text,
    pendingSend:
      current.pendingSend ??
      (storedPendingWasAcknowledged ? null : (saved.pendingSend ?? null)),
    receiptAckPending:
      current.receiptAckPending ?? saved.receiptAckPending ?? null
  };
};

export const pendingSendAfterReceiptResolution = (
  draft: Pick<StudioTeamDraft, "pendingSend"> | undefined,
  fallback: NonNullable<StudioTeamDraft["pendingSend"]>,
  confirmed: boolean
): StudioTeamDraft["pendingSend"] =>
  confirmed
    ? (draft?.pendingSend ?? null)
    : draft
      ? draft.pendingSend
      : fallback;

export const teamDraftAfterAcceptedSendResult = (
  current: StudioTeamDraft | undefined,
  accepted: NonNullable<StudioTeamDraft["pendingSend"]>,
  acceptedMessageId: string,
  acknowledgedMessageId: string | null
): StudioTeamDraft => {
  if (acknowledgedMessageId === acceptedMessageId) {
    if (!current) return { text: "", pendingSend: null };
    return {
      ...current,
      ...(current.pendingSend?.clientMessageId === accepted.clientMessageId
        ? { pendingSend: null }
        : {}),
      ...(current.receiptAckPending?.clientMessageId ===
      accepted.clientMessageId
        ? { receiptAckPending: null }
        : {})
    };
  }
  if (current?.pendingSend?.clientMessageId === accepted.clientMessageId)
    return current;
  return {
    text: current?.text ?? "",
    pendingSend: accepted,
    receiptAckPending: current?.receiptAckPending ?? null
  };
};

export const teamDraftForReplyAttempt = (
  current: StudioTeamDraft | undefined,
  pendingSend: NonNullable<StudioTeamDraft["pendingSend"]>,
  retryingExistingSend: boolean,
  currentComposerText: string
): StudioTeamDraft => ({
  text: retryingExistingSend ? (current?.text ?? currentComposerText) : "",
  pendingSend,
  receiptAckPending: retryingExistingSend
    ? (current?.receiptAckPending ?? null)
    : null
});

export const teamDraftAfterReplyTextChange = (
  current: StudioTeamDraft | undefined,
  text: string,
  fallbackPendingSend: StudioTeamDraft["pendingSend"]
): StudioTeamDraft => ({
  ...current,
  text,
  pendingSend: current ? current.pendingSend : fallbackPendingSend,
  receiptAckPending: current?.receiptAckPending ?? null
});

export const threadReceiptMayUpdatePane = (input: {
  draftAuthority: StudioTeamDraftAuthority;
  currentAuthorityKey: string | null;
  openRoot: { id: string; teamId: string | null; threadId: string } | null;
}): boolean => {
  const { rootMessageId, editMessageId, ...baseAuthority } =
    input.draftAuthority;
  return Boolean(
    rootMessageId &&
    !editMessageId &&
    input.currentAuthorityKey === JSON.stringify(baseAuthority) &&
    input.openRoot?.id === rootMessageId &&
    input.openRoot.teamId === input.draftAuthority.teamId &&
    input.openRoot.threadId === input.draftAuthority.threadId
  );
};

export const teamDraftAfterTextChange = (input: {
  callbackAuthorityKey: string | null;
  currentAuthorityKey: string | null;
  hydratedAuthorityKey: string | null;
  latest: StudioTeamDraft;
  text: string;
}): StudioTeamDraft | null => {
  if (
    !input.callbackAuthorityKey ||
    input.callbackAuthorityKey !== input.currentAuthorityKey ||
    input.callbackAuthorityKey !== input.hydratedAuthorityKey
  )
    return null;
  return { ...input.latest, text: input.text };
};

export const teamDraftForAcceptedReceipt = (input: {
  authority: {
    teamId: string;
    threadId: string;
    rootMessageId?: string | null;
    editMessageId?: string | null;
  };
  draft: StudioTeamDraft;
  receipt: CollaborationSendReceipt;
}): StudioTeamDraft | null => {
  const { authority, draft, receipt } = input;
  if (
    receipt.thread.scope !== "team" ||
    receipt.thread.teamId !== authority.teamId ||
    receipt.thread.threadId !== authority.threadId ||
    receipt.message.scope !== "team" ||
    receipt.message.teamId !== authority.teamId ||
    receipt.message.threadId !== authority.threadId ||
    (authority.rootMessageId !== undefined &&
      receipt.message.rootMessageId !== authority.rootMessageId) ||
    authority.editMessageId !== undefined ||
    receipt.message.delivery !== "sent" ||
    receipt.message.clientMessageId !== receipt.clientMessageId ||
    draft.pendingSend?.clientMessageId !== receipt.clientMessageId ||
    draft.pendingSend.body !==
      (typeof receipt.acceptedBody === "string"
        ? receipt.acceptedBody
        : receipt.message.body)
  )
    return null;
  const settled = resolvePendingSend(
    draft,
    receipt.clientMessageId,
    "accepted",
    draft.pendingSend.body
  );
  return {
    ...settled,
    receiptAckPending: {
      clientMessageId: receipt.clientMessageId,
      messageId: receipt.message.id
    }
  };
};

export const teamDraftWithoutReceiptAck = (
  draft: StudioTeamDraft,
  clientMessageId: string,
  messageId: string
): StudioTeamDraft =>
  draft.receiptAckPending?.clientMessageId === clientMessageId &&
  draft.receiptAckPending.messageId === messageId
    ? { ...draft, receiptAckPending: null }
    : draft;

export const acknowledgedReceiptMessageId = (input: {
  requestedAuthorityKey: string;
  receiptAuthorityKey: string;
  requestedClientMessageId: string;
  receiptClientMessageId: string;
  completion: { messageId: string; acknowledged: boolean } | undefined;
}): string | null =>
  input.requestedAuthorityKey === input.receiptAuthorityKey &&
  input.requestedClientMessageId === input.receiptClientMessageId &&
  input.completion?.acknowledged &&
  input.completion.messageId.trim().length > 0
    ? input.completion.messageId
    : null;

export const saveAcceptedReceiptBeforeAcknowledging = async (input: {
  authority: { teamId: string; threadId: string };
  draft: StudioTeamDraft;
  receipt: CollaborationSendReceipt;
  saveDraft: (draft: StudioTeamDraft) => Promise<void>;
  acknowledge: () => Promise<void>;
}): Promise<StudioTeamDraft | null> => {
  const settled = teamDraftForAcceptedReceipt(input);
  if (!settled) return null;
  await input.saveDraft(settled);
  await input.acknowledge();
  return settled;
};

export const draftAfterCompletedReceiptWrite = (input: {
  latest: StudioTeamDraft;
  candidate: StudioTeamDraft;
  clientMessageId: string;
  messageId: string;
  acknowledged: boolean;
}): StudioTeamDraft => {
  const { latest, candidate, clientMessageId, messageId, acknowledged } = input;
  const completionMarker = acknowledged ? null : { clientMessageId, messageId };
  const settle = (draft: StudioTeamDraft): StudioTeamDraft => ({
    ...resolvePendingSend(
      draft,
      clientMessageId,
      "accepted",
      draft.pendingSend?.body ?? ""
    ),
    receiptAckPending: completionMarker
  });
  if (latest.pendingSend?.clientMessageId === clientMessageId)
    return settle(latest);
  if (candidate.pendingSend?.clientMessageId === clientMessageId) {
    if (latest.pendingSend) return latest;
    return settle({ ...latest, pendingSend: candidate.pendingSend });
  }
  return candidate;
};

export const draftTextAfterSendPreflight = (input: {
  textBeforePreflight: string;
  latestText: string;
}): string =>
  input.latestText === input.textBeforePreflight ? "" : input.latestText;

export const teamDraftWriteMayApply = (input: {
  capturedGeneration: number;
  currentGeneration: number;
  invalidated: boolean;
}): boolean =>
  !input.invalidated && input.capturedGeneration === input.currentGeneration;

export const deleteTeamDraftAfterQueuedWrite = async (input: {
  queuedWrite: Promise<unknown> | null;
  deleteDraft: () => Promise<void>;
}): Promise<void> => {
  await input.queuedWrite?.catch(() => undefined);
  await input.deleteDraft();
};

export const confirmedPendingSend = (
  draft: StudioTeamDraft,
  confirmedClientMessageId: string
): StudioTeamDraft =>
  draft.pendingSend?.clientMessageId === confirmedClientMessageId
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
    text:
      outcome === "not-sent" && draft.text.length === 0
        ? originalBody
        : draft.text,
    pendingSend: null
  };
};

export const retainPendingSendAfterUncertainOutcome = (
  draft: StudioTeamDraft,
  pendingSend: NonNullable<StudioTeamDraft["pendingSend"]>
): StudioTeamDraft =>
  draft.pendingSend &&
  draft.pendingSend.clientMessageId !== pendingSend.clientMessageId
    ? draft
    : { ...draft, pendingSend };

export const visibleReadMayAdvance = (input: {
  messageId: string;
  sequence: number;
  senderId: string;
  principalUserId: string;
  focused: boolean;
  lastReportedSequence: number;
}): boolean =>
  Boolean(
    input.focused &&
    input.messageId &&
    input.senderId !== input.principalUserId &&
    Number.isSafeInteger(input.sequence) &&
    input.sequence > input.lastReportedSequence
  );

export const readSequenceFor = (
  positions: ReadonlyMap<string, number>,
  authorityKey: string
): number => positions.get(authorityKey) ?? 0;

export const rememberReadSequence = (
  positions: Map<string, number>,
  authorityKey: string,
  sequence: number
): number => {
  const next = Math.max(readSequenceFor(positions, authorityKey), sequence);
  positions.set(authorityKey, next);
  return next;
};

export const readCompletionMayApply = (
  capturedAuthorityKey: string,
  currentAuthorityKey: string | null
): boolean => capturedAuthorityKey === currentAuthorityKey;

export const realtimeUpdateMayAcknowledge = (input: {
  eventTeamId: string;
  eventThreadId: string | null;
  currentTeamId: string;
  currentThreadId: string;
  historyApplied: boolean;
  snapshotApplied: boolean;
}): boolean =>
  input.eventTeamId === input.currentTeamId &&
  input.snapshotApplied &&
  (input.historyApplied ||
    (input.eventThreadId !== null &&
      input.currentThreadId !== input.eventThreadId));

export const mergeTeamMessages = (
  current: CollaborationMessage[],
  incoming: CollaborationMessage[],
  limit = 250
): CollaborationMessage[] => {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) {
    const previous = byId.get(message.id);
    if (
      previous &&
      (message.version < previous.version ||
        (message.version === previous.version &&
          Date.parse(message.updatedAt) < Date.parse(previous.updatedAt)))
    )
      continue;
    byId.set(message.id, message);
  }
  return [...byId.values()]
    .sort((left, right) => left.sequence - right.sequence)
    .slice(-limit);
};

export type RootedChannelMessage = {
  id: string;
  rootMessageId?: string | null;
  sequence: number;
};

export const channelRootMessages = <T extends RootedChannelMessage>(
  messages: readonly T[]
): T[] => messages.filter((message) => message.rootMessageId == null);

export const threadMessagesForRoot = <T extends RootedChannelMessage>(
  root: T,
  replies: readonly T[]
): T[] => {
  const byId = new Map<string, T>([[root.id, root]]);
  for (const message of replies) {
    if (message.rootMessageId === root.id && message.id !== root.id)
      byId.set(message.id, message);
  }
  return [...byId.values()].sort(
    (left, right) => left.sequence - right.sequence
  );
};

export const messageReactionMayStart = (input: {
  message: Pick<
    CollaborationMessage,
    "scope" | "teamId" | "threadId" | "rootMessageId"
  >;
  teamId: string;
  threadId: string;
  openRootMessageId: string | null;
}): boolean =>
  input.message.scope === "team" &&
  input.message.teamId === input.teamId &&
  input.message.threadId === input.threadId &&
  (input.message.rootMessageId === null ||
    input.message.rootMessageId === input.openRootMessageId);

export const messageReactionMayUpdateOpenPane = (input: {
  message: Pick<CollaborationMessage, "id" | "rootMessageId">;
  openRootMessageId: string | null;
}): boolean =>
  Boolean(
    input.openRootMessageId &&
    (input.message.id === input.openRootMessageId ||
      input.message.rootMessageId === input.openRootMessageId)
  );

export const repliesForChannelRoot = <T extends RootedChannelMessage>(
  messages: readonly T[],
  rootMessageId: string
): T[] =>
  messages
    .filter((message) => message.rootMessageId === rootMessageId)
    .slice()
    .sort((left, right) => left.sequence - right.sequence);

export const visibleReplyReadMayAdvance = (input: {
  rootMessageId: string;
  replyMessageId: string;
  sequence: number;
  senderId: string;
  principalUserId: string;
  focused: boolean;
  rootPaneVisible: boolean;
  lastReportedSequence: number;
}): boolean =>
  Boolean(
    input.rootMessageId &&
    input.replyMessageId &&
    input.focused &&
    input.rootPaneVisible &&
    input.senderId !== input.principalUserId &&
    Number.isSafeInteger(input.sequence) &&
    input.sequence > input.lastReportedSequence
  );

export const threadReplyVisibleRatio = (input: {
  element: { top: number; right: number; bottom: number; left: number };
  container: { top: number; right: number; bottom: number; left: number };
  viewport: { top: number; right: number; bottom: number; left: number };
}): number => {
  const top = Math.max(
    input.element.top,
    input.container.top,
    input.viewport.top
  );
  const right = Math.min(
    input.element.right,
    input.container.right,
    input.viewport.right
  );
  const bottom = Math.min(
    input.element.bottom,
    input.container.bottom,
    input.viewport.bottom
  );
  const left = Math.max(
    input.element.left,
    input.container.left,
    input.viewport.left
  );
  const width = Math.max(0, input.element.right - input.element.left);
  const height = Math.max(0, input.element.bottom - input.element.top);
  const area = width * height;
  return area > 0
    ? (Math.max(0, right - left) * Math.max(0, bottom - top)) / area
    : 0;
};

export const visibleReplyPrefix = <T extends { id: string }>(
  repliesInOrder: readonly T[],
  visibleReplyIds: ReadonlySet<string>
): T[] => {
  const prefix: T[] = [];
  for (const reply of repliesInOrder) {
    if (!visibleReplyIds.has(reply.id)) break;
    prefix.push(reply);
  }
  return prefix;
};

export const editDraftAfterConflict = <
  T extends {
    text: string;
    edit?: {
      expectedVersion: number;
      baseBodyText: string;
      conflict?: { latestVersion: number; latestBodyText: string };
    };
  }
>(
  draft: T,
  latest: { version: number; bodyText: string }
): T => {
  if (
    !draft.edit ||
    !Number.isSafeInteger(latest.version) ||
    latest.version <= draft.edit.expectedVersion
  )
    return draft;
  return {
    ...draft,
    edit: {
      ...draft.edit,
      conflict: {
        latestVersion: latest.version,
        latestBodyText: latest.bodyText
      }
    }
  };
};

export const editDraftAfterConflictReview = <
  T extends {
    text: string;
    edit?: {
      expectedVersion: number;
      baseBodyText: string;
      conflict?: { latestVersion: number; latestBodyText: string };
    };
  }
>(
  draft: T
): T => {
  if (!draft.edit?.conflict) return draft;
  const { conflict, ...edit } = draft.edit;
  return {
    ...draft,
    edit: {
      ...edit,
      expectedVersion: conflict.latestVersion,
      baseBodyText: conflict.latestBodyText
    }
  };
};

export const studioSelectionMatches = (
  captured: { teamId: string; threadId: string },
  current: { teamId: string; threadId: string }
): boolean =>
  captured.teamId === current.teamId && captured.threadId === current.threadId;

export const selectedTeamSnapshotMayStartSubscription = (input: {
  active: boolean;
  currentTeamId: string;
  expectedBackendId: string;
  expectedPrincipalId: string;
  teamId: string;
  selectedSnapshot: {
    connection: { backendId: string | null };
    navigation: { teamPrincipal: { id: string } | null };
    selectionTeamId: string | null;
  } | null;
}): boolean =>
  Boolean(
    input.active &&
    input.currentTeamId === input.teamId &&
    input.selectedSnapshot &&
    input.selectedSnapshot.connection.backendId === input.expectedBackendId &&
    input.selectedSnapshot.navigation.teamPrincipal?.id ===
      input.expectedPrincipalId &&
    input.selectedSnapshot.selectionTeamId === input.teamId
  );

export const studioRequestMayApply = (input: {
  capturedGeneration: number;
  currentGeneration: number;
  mounted: boolean;
}): boolean =>
  input.mounted && input.capturedGeneration === input.currentGeneration;

export const directMessageAttemptKey = (
  teamId: string,
  principalUserId: string,
  participantUserIds: string[]
): string =>
  `${teamId}:${principalUserId}:${[...new Set(participantUserIds)].sort().join(",")}`;

export const directMessageParticipantsAreEligible = (input: {
  principalUserId: string;
  participantUserIds: string[];
  enabledMemberIds: ReadonlySet<string>;
}): boolean =>
  input.participantUserIds.length > 0 &&
  new Set(input.participantUserIds).size === input.participantUserIds.length &&
  input.participantUserIds.every(
    (userId) =>
      userId !== input.principalUserId && input.enabledMemberIds.has(userId)
  );

export const directMessageThreadMatchesRequest = (input: {
  requestedTeamId: string;
  principalUserId: string;
  participantUserIds: string[];
  thread: unknown;
}): boolean => {
  if (!input.thread || typeof input.thread !== "object") return false;
  const thread = input.thread as {
    scope?: unknown;
    teamId?: unknown;
    kind?: unknown;
    participants?: unknown;
  };
  if (
    !Array.isArray(thread.participants) ||
    !thread.participants.every(
      (participant) =>
        participant &&
        typeof participant === "object" &&
        "id" in participant &&
        typeof participant.id === "string"
    )
  )
    return false;
  const expectedParticipants = [
    input.principalUserId,
    ...input.participantUserIds
  ];
  const expectedSet = new Set(expectedParticipants);
  const returnedIds = thread.participants.map(
    (participant) => participant.id as string
  );
  const returnedSet = new Set(returnedIds);
  const expectedKind =
    input.participantUserIds.length === 1 ? "dm" : "group_dm";
  return (
    input.participantUserIds.length > 0 &&
    expectedSet.size === expectedParticipants.length &&
    thread.scope === "team" &&
    thread.teamId === input.requestedTeamId &&
    thread.kind === expectedKind &&
    returnedSet.size === returnedIds.length &&
    returnedSet.size === expectedSet.size &&
    [...expectedSet].every((participantId) => returnedSet.has(participantId))
  );
};

export const durableSendMatchesAuthority = (
  send: Pick<CollaborationDurableSend, "authority">,
  authorityKey: string | null
): boolean => {
  if (!authorityKey || send.authority.scope !== "team") return false;
  return (
    JSON.stringify({
      backendId: send.authority.backendId,
      principalUserId: send.authority.principalUserId,
      teamId: send.authority.teamId,
      threadId: send.authority.threadId
    }) === authorityKey
  );
};

export const durableSendStatus = (
  send: Pick<CollaborationDurableSend, "state" | "failure">
): string | null => {
  if (send.state === "queued") return "Sending…";
  if (send.state === "manual_retry")
    return send.failure?.userMessage ?? "Send is queued for retry.";
  if (send.state === "failed")
    return send.failure?.userMessage ?? "Message could not be sent.";
  return null;
};

export const durableSendFailureDisposition = (
  failureCode: string | null
): "authority_lost" | "not_sent" =>
  failureCode === "access_revoked" ||
  failureCode === "permission_denied" ||
  failureCode === "not_available"
    ? "authority_lost"
    : "not_sent";

export const describeStudioCommandFailure = (
  failure: unknown
): {
  revoked: boolean;
  message: string;
} => {
  const value =
    failure && typeof failure === "object"
      ? (failure as { code?: unknown; message?: unknown })
      : null;
  return {
    revoked: value?.code === "access_revoked",
    message:
      typeof value?.message === "string" && value.message.length > 0
        ? value.message
        : "Team channel could not be loaded. Try again."
  };
};
