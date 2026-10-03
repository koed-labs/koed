"use client";

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Settings, User } from "lucide-react";
import {
  collaborationMessagePageSchema,
  type CollaborationMessage,
  type CollaborationMessagePage,
  type CollaborationRendererCommand,
  type CollaborationSelection,
  type CollaborationSendReceipt,
  type CollaborationSnapshot,
  type CollaborationThread
} from "@koed/shared/collaboration";
import {
  ChatComposer,
  type ChatComposerSelection
} from "@/components/ChatComposer";
import { SharedChatUI } from "@/components/SharedChatUI";
import { CreateChannelModal } from "@/components/CreateChannelModal";
import { CreateProjectModal } from "@/components/CreateProjectModal";
import { ChannelHeader } from "@/components/ChannelView";
import {
  TeamMessageThreadPane,
  type ThreadEditDraft
} from "@/components/TeamMessageThreadPane";
import {
  TeamDirectMessageBubble,
  directMessageTitle
} from "@/components/TeamDirectMessage";
import { TeamShell } from "@/components/TeamShell";
import { TeamChannelMessageContent } from "@/components/TeamChannelMessageContent";
import { TeamChannelNavigation } from "@/components/TeamSidebar";
import { registerStudioNotificationViewedChat } from "@/lib/studio-notification-viewed-chat";
import { findAuthorizedStudioNotificationDestination } from "@/lib/studio-notification-destination";
import { findStudioNotificationRoot } from "@/lib/studio-notification-root-search";
import type { StudioNotificationNavigation } from "@koed/shared/studio-notifications";
import { PublicSquare } from "@/components/PublicSquare";
import { TeamChannelAgentRequests } from "@/components/TeamAgentRequestViews";
import { SidebarProvider } from "@/components/SidebarContext";
import type {
  StudioTeamDraft,
  StudioTeamDraftAuthority
} from "@/lib/studio-collaboration-client";
import { StudioCollaborationClient } from "@/lib/studio-collaboration-client";
import {
  deleteTeamDraftAfterQueuedWrite,
  describeStudioCommandFailure,
  directMessageAttemptKey,
  directMessageParticipantsAreEligible,
  directMessageThreadMatchesRequest,
  draftAfterCompletedReceiptWrite,
  draftTextAfterSendPreflight,
  durableSendFailureDisposition,
  durableSendMatchesAuthority,
  durableSendStatus,
  mayCompleteDraftHydration,
  mayPersistTeamDraft,
  mergeTeamMessages,
  editDraftAfterConflict,
  editDraftAfterConflictReview,
  acknowledgedReceiptMessageId,
  pendingSendAfterReceiptResolution,
  teamDraftAfterAcceptedSendResult,
  teamDraftAfterReplyTextChange,
  teamDraftAfterReplyHydration,
  teamDraftForReplyAttempt,
  messageReactionMayStart,
  messageReactionMayUpdateOpenPane,
  readCompletionMayApply,
  readSequenceFor,
  rememberReadSequence,
  resolvePendingSend,
  realtimeUpdateMayAcknowledge,
  retainPendingSendAfterUncertainOutcome,
  studioSelectionMatches,
  selectedTeamSnapshotMayStartSubscription,
  threadReceiptMayUpdatePane,
  teamDraftAfterTextChange,
  teamDraftForAcceptedReceipt,
  teamDraftWithoutReceiptAck,
  teamDraftWriteMayApply,
  visibleReadMayAdvance,
  visibleReplyReadMayAdvance
} from "@/lib/team-channel-state";
import {
  chooseLocalProjectFolder,
  listRegisteredLocalProjects,
  registerLocalProject
} from "@/lib/local-projects";
import { PublicSquareClient } from "@/lib/public-square-client";
import {
  TeamAgentRequestError,
  TeamAgentRequestsClient
} from "@/lib/team-agent-requests-client";
import { usePublicSquare } from "@/lib/use-public-square";
import { useTeamAgentMentions } from "@/lib/use-team-agent-mentions";
import {
  buildOwnedAgentHandoffDraft,
  privateAgentHandoffHref,
  teamMentionSelectionForScope,
  type ScopedTeamMentionSelection,
  type TeamAgentMention
} from "@/lib/team-agent-mentions";
import {
  canForwardTeamAnswer,
  teamAnswerForwardDraft,
  forwardableTeamRequestsForChannelMessage,
  forwardableTeamRequestsForReply
} from "@/lib/team-agent-channel-sharing";
import type { TeamAgentRequest } from "@koed/shared/team-agent-requests";
import type { TeamOverviewItem } from "@koed/shared/team-overview";
import { TeamAttentionView } from "@/components/TeamAttentionView";
import { useTeamOverview } from "@/lib/use-team-overview";
import { toTeamChatMessages } from "@/lib/team-chat-messages";

type DraftAuthority = StudioTeamDraftAuthority;

type DraftStore = {
  loadDraft(authority: DraftAuthority): Promise<StudioTeamDraft | null>;
  saveDraft(authority: DraftAuthority, draft: StudioTeamDraft): Promise<void>;
  deleteDraft(authority: DraftAuthority): Promise<void>;
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const receiptWaitExpired = Symbol("receipt-wait-expired");
const teamChannels = (snapshot: CollaborationSnapshot, teamId: string) =>
  snapshot.navigation.teams.find((team) => team.id === teamId)?.channels ?? [];
const projectChannels = (snapshot: CollaborationSnapshot, teamId: string) =>
  snapshot.navigation.teams.find((team) => team.id === teamId)
    ?.sharedProjects ?? [];
const teamSelectionForWorkspace = (
  snapshot: CollaborationSnapshot,
  teamId: string,
  preferredThreadId: string
): CollaborationSelection | null => {
  const team = snapshot.navigation.teams.find(
    (candidate) => candidate.id === teamId
  );
  if (!team) return null;
  const thread =
    [
      ...team.channels,
      ...team.sharedProjects.map((project) => project.thread),
      ...team.directMessages
    ].find((candidate) => candidate.id === preferredThreadId) ??
    team.channels.find((candidate) => candidate.name === "general") ??
    team.channels[0] ??
    team.sharedProjects[0]?.thread;
  if (!thread) return { kind: "team_people", teamId };
  if (thread.kind === "team_project_channel") {
    return {
      kind: "team_project_channel",
      teamId,
      teamProjectId: thread.teamProjectId,
      threadId: thread.id
    };
  }
  if (thread.kind === "dm" || thread.kind === "group_dm") {
    return { kind: "team_direct_message", teamId, threadId: thread.id };
  }
  return { kind: "team_channel", teamId, threadId: thread.id };
};

export function TeamChannelWorkspace({
  snapshot: initialSnapshot,
  client,
  drafts,
  onRefresh,
  notificationNavigation = null
}: {
  snapshot: CollaborationSnapshot;
  client: StudioCollaborationClient;
  drafts: DraftStore;
  onRefresh: () => void;
  notificationNavigation?: StudioNotificationNavigation | null;
}) {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<CollaborationSnapshot | null>(
    initialSnapshot
  );
  const teamAccessScopeKey = snapshot
    ? `${snapshot.connection.backendId ?? ""}:${snapshot.navigation.teamPrincipal?.id ?? ""}:${snapshot.navigation.teams
        .map((team) => team.id)
        .sort()
        .join(",")}`
    : null;
  const teamOverview = useTeamOverview({
    transport: "studio",
    identityKey: teamAccessScopeKey
  });
  const refreshTeamOverview = teamOverview.refresh;
  const [overviewTeamFilter, setOverviewTeamFilter] = useState("all");
  const [teamId, setTeamId] = useState(
    initialSnapshot.navigation.teams[0]?.id ?? ""
  );
  const [threadId, setThreadId] = useState(() => {
    const team = initialSnapshot.navigation.teams[0];
    return (
      team?.channels.find((thread) => thread.name === "general")?.id ??
      team?.channels[0]?.id ??
      team?.sharedProjects[0]?.thread.id ??
      ""
    );
  });
  const [previousAuthorityKey, setPreviousAuthorityKey] = useState<
    string | null
  >(null);
  const [squareOpen, setSquareOpen] = useState(false);
  const [focusSquareJobId, setFocusSquareJobId] = useState<string | null>(null);
  const [forYouOpen, setForYouOpen] = useState(false);
  useEffect(() => {
    if (forYouOpen) refreshTeamOverview();
  }, [forYouOpen, refreshTeamOverview]);
  const pendingAttentionItem = useRef<TeamOverviewItem | null>(null);
  const pendingNotificationDestination = useRef<{
    teamId: string;
    threadId: string;
    rootMessageId: string | null;
  } | null>(null);
  const handledNotificationMessage = useRef<string | null>(null);
  const [agentOfferRevision, setAgentOfferRevision] = useState(0);
  const [agentRequestRevision, setAgentRequestRevision] = useState(0);
  const [channelRequests, setChannelRequests] = useState<TeamAgentRequest[]>(
    []
  );
  const publicSquareClient = useMemo(
    () => new PublicSquareClient("studio"),
    []
  );
  const teamAgentRequestsClient = useMemo(
    () => new TeamAgentRequestsClient("studio"),
    []
  );
  const [localProjectsState, setLocalProjectsState] = useState<{
    owner: string;
    loaded: boolean;
    projects: Array<{ id: string; name: string }>;
  }>({ owner: "", loaded: false, projects: [] });
  const [messages, setMessages] = useState<CollaborationMessage[]>([]);
  const [openRootMessage, setOpenRootMessage] =
    useState<CollaborationMessage | null>(null);
  const [openRootAuthorityKey, setOpenRootAuthorityKey] = useState<
    string | null
  >(null);
  const [threadReplies, setThreadReplies] = useState<CollaborationMessage[]>(
    []
  );
  const [threadPage, setThreadPage] = useState<CollaborationMessagePage | null>(
    null
  );
  const [threadRequests, setThreadRequests] = useState<TeamAgentRequest[]>([]);
  const [threadDraftText, setThreadDraftText] = useState("");
  const [threadMentionUserIds, setThreadMentionUserIds] = useState<string[]>(
    []
  );
  const [threadPendingSend, setThreadPendingSend] =
    useState<StudioTeamDraft["pendingSend"]>(null);
  const [threadSendStatus, setThreadSendStatus] = useState<
    "pending" | "uncertain" | "retry_failed" | null
  >(null);
  const [threadEditDrafts, setThreadEditDrafts] = useState<
    Map<string, ThreadEditDraft>
  >(new Map());
  const threadSendInFlight = useRef(new Set<string>());
  const [messageSelection, setMessageSelection] = useState<{
    teamId: string;
    threadId: string;
  } | null>(null);
  const [page, setPage] = useState<CollaborationMessagePage | null>(null);
  const [draftText, setDraftText] = useState("");
  const [draftMentionUserIds, setDraftMentionUserIds] = useState<string[]>([]);
  const [teamMentionSelection, setTeamMentionSelection] =
    useState<ScopedTeamMentionSelection | null>(null);
  const [pendingSend, setPendingSend] =
    useState<StudioTeamDraft["pendingSend"]>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [channelError, setChannelError] = useState<string | null>(null);
  const [hydratedAuthorityKey, setHydratedAuthorityKey] = useState<
    string | null
  >(null);
  const [visibleReadState, setVisibleRead] = useState<{
    id: string;
    sequence: number;
    senderId: string;
    teamId: string;
    threadId: string;
  } | null>(null);
  const selectedRef = useRef({ teamId: "", threadId: "" });
  const selectedTeamIdRef = useRef(teamId);
  useLayoutEffect(() => {
    selectedTeamIdRef.current = teamId;
  }, [teamId]);
  const openRootRef = useRef<CollaborationMessage | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const readReported = useRef(new Map<string, number>());
  const readPending = useRef(new Map<string, number>());
  const threadReadReported = useRef(new Map<string, number>());
  const threadReadPending = useRef(new Map<string, number>());
  const saveSequence = useRef(0);
  const snapshotEpoch = useRef(0);
  const revokedRef = useRef(false);
  const draftByAuthority = useRef(new Map<string, StudioTeamDraft>());
  const draftWriteTails = useRef(new Map<string, Promise<void>>());
  const draftAuthorityGenerations = useRef(new Map<string, number>());
  const invalidDraftAuthorities = useRef(new Set<string>());
  const receiptCompletions = useRef(
    new Map<string, Map<string, { messageId: string; acknowledged: boolean }>>()
  );
  const clearRevokedViewRef = useRef<
    (authority?: DraftAuthority, invalidationQueued?: boolean) => void
  >(() => undefined);
  const sendLocks = useRef(new Set<string>());
  const projectRequestIds = useRef(
    new Map<string, { requestId: string; name: string }>()
  );
  const directMessageRequestIds = useRef(new Map<string, string>());
  const threadSelectionGeneration = useRef(0);
  const localProjectRegistrations = useRef(
    new Map<
      string,
      Promise<{ id: string; name: string; lastSeenAt: string | null }>
    >()
  );
  const activeTeam =
    snapshot?.navigation.teams.find((team) => team.id === teamId) ?? null;
  const activeTeamId = activeTeam?.id ?? null;
  const localProjectsOwner =
    snapshot?.connection.backendId && snapshot.navigation.teamPrincipal?.id
      ? `${snapshot.connection.backendId}:${snapshot.navigation.teamPrincipal.id}`
      : "";
  const localProjects =
    localProjectsState.owner === localProjectsOwner
      ? localProjectsState.projects
      : [];
  const loadingLocalProjects =
    !localProjectsOwner ||
    localProjectsState.owner !== localProjectsOwner ||
    !localProjectsState.loaded;
  const squareProjects = useMemo(
    () =>
      (activeTeam?.sharedProjects ?? []).map((project) => ({
        id: project.id,
        name: project.name
      })),
    [activeTeam?.sharedProjects]
  );
  const handleSquareAuthorizationLost = useCallback(() => {
    clearRevokedViewRef.current();
  }, []);
  const square = usePublicSquare({
    client: publicSquareClient,
    scope: {
      backendId: snapshot?.connection.backendId ?? "",
      principalUserId: snapshot?.navigation.teamPrincipal?.id ?? "",
      teamId
    },
    projects: squareProjects,
    localProjects,
    enabled: Boolean(snapshot && activeTeam),
    onAuthorizationLost: handleSquareAuthorizationLost
  });
  const teamAgentMentions = useTeamAgentMentions(
    teamAgentRequestsClient,
    teamId,
    snapshot?.navigation.teamPrincipal?.id ?? "",
    `${snapshot?.connection.backendId ?? ""}:${snapshot?.navigation.teamPrincipal?.id ?? ""}:${teamId}`,
    agentOfferRevision
  );
  const [pendingAgentMention, setPendingAgentMention] = useState<{
    agent: TeamAgentMention;
    text: string;
    idempotencyKey: string;
    sendClientMessageId: string;
    mentionUserIds: string[];
    rootMessageId?: string;
  } | null>(null);
  const [agentMentionBusy, setAgentMentionBusy] = useState(false);
  const openRequestReview = useCallback(
    async (request: TeamAgentRequest, draft?: string) => {
      const capturedEpoch = snapshotEpoch.current;
      const capturedSelectionGeneration = threadSelectionGeneration.current;
      const capturedSelectedTeamId = selectedTeamIdRef.current;
      const stillAuthorized = () =>
        !revokedRef.current &&
        snapshotEpoch.current === capturedEpoch &&
        threadSelectionGeneration.current === capturedSelectionGeneration &&
        selectedTeamIdRef.current === capturedSelectedTeamId &&
        selectedRef.current.teamId === capturedSelectedTeamId;
      try {
        const review = await teamAgentRequestsClient.getReview(
          teamId,
          request.id
        );
        const connection = await publicSquareClient.getConnection(
          teamId,
          request.teamProjectId
        );
        if (!stillAuthorized() || capturedSelectedTeamId !== teamId) return;
        if (!connection.localProjectId) {
          setStatus(
            "Connect this Team Project to a local Project in Public Square before reviewing its Agent request."
          );
          return;
        }
        const query = new URLSearchParams({
          chat: "1",
          agent: request.agentId,
          project: connection.localProjectId,
          teamRequest: request.id,
          teamRequestTeam: teamId
        });
        query.set("teamRequestVersion", String(request.version));
        query.set("teamReviewVersion", String(review.version));
        if (review.executionId) query.set("execution", review.executionId);
        if (draft) query.set("draft", draft.slice(0, 2_400));
        router.push(`/?${query.toString()}`);
      } catch (failure) {
        if (!stillAuthorized() || capturedSelectedTeamId !== teamId) return;
        setStatus(
          failure instanceof Error
            ? failure.message
            : "The private Agent review could not be opened."
        );
      }
    },
    [publicSquareClient, router, teamAgentRequestsClient, teamId]
  );
  const openRequestWork = useCallback(
    (request: import("@koed/shared/team-agent-requests").TeamAgentRequest) => {
      if (!request.jobId) return;
      setForYouOpen(false);
      setFocusSquareJobId(request.jobId);
      setSquareOpen(true);
    },
    []
  );
  const forwardChannelAnswer = useCallback(
    async (request: TeamAgentRequest, message: CollaborationMessage) => {
      const viewerId = snapshot?.navigation.teamPrincipal?.id ?? "";
      if (!canForwardTeamAnswer(request, viewerId)) return;
      try {
        const review = await teamAgentRequestsClient.getReview(
          teamId,
          request.id
        );
        if (
          !review.executionId ||
          revokedRef.current ||
          selectedRef.current.teamId !== teamId ||
          selectedRef.current.threadId !== message.threadId
        ) {
          setStatus(
            "The accepted private execution is unavailable for this Team reply."
          );
          return;
        }
        await openRequestReview(
          request,
          teamAnswerForwardDraft({
            senderName: message.sender.displayName,
            message: message.body
          })
        );
      } catch (failure) {
        if (!revokedRef.current)
          setStatus(
            failure instanceof Error
              ? failure.message
              : "The Team reply could not be opened privately."
          );
      }
    },
    [
      openRequestReview,
      snapshot?.navigation.teamPrincipal?.id,
      teamAgentRequestsClient,
      teamId
    ]
  );
  const refreshSquare = square.refresh;
  const threads = useMemo(
    () => [
      ...(snapshot ? teamChannels(snapshot, teamId) : []),
      ...(snapshot
        ? projectChannels(snapshot, teamId).map((project) => project.thread)
        : []),
      ...(snapshot?.navigation.teams.find((team) => team.id === teamId)
        ?.directMessages ?? [])
    ],
    [snapshot, teamId]
  );
  const fallbackThreadId =
    activeTeam?.channels.find((thread) => thread.name === "general")?.id ??
    activeTeam?.channels[0]?.id ??
    activeTeam?.sharedProjects[0]?.thread.id ??
    "";
  if (
    teamId &&
    !threads.some((thread) => thread.id === threadId) &&
    threadId !== fallbackThreadId
  )
    setVisibleRead(null);
  if (
    teamId &&
    !threads.some((thread) => thread.id === threadId) &&
    threadId !== fallbackThreadId
  )
    setThreadId(fallbackThreadId);
  const activeThread = threads.find((thread) => thread.id === threadId) ?? null;
  const activeThreadId = activeThread?.id ?? null;
  useEffect(() => {
    if (!teamId || !activeThreadId) return;
    return registerStudioNotificationViewedChat({
      kind: "team",
      teamId,
      threadId: activeThreadId
    });
  }, [activeThreadId, teamId]);
  const connectionState = snapshot?.connection.state;
  const visibleRead =
    visibleReadState &&
    visibleReadState.teamId === teamId &&
    visibleReadState.threadId === activeThread?.id
      ? visibleReadState
      : null;
  const activeDirectMessage =
    activeThread?.kind === "dm" || activeThread?.kind === "group_dm"
      ? activeThread
      : null;
  const activeDirectMessageTitle =
    activeDirectMessage && snapshot?.navigation.teamPrincipal
      ? directMessageTitle(
          activeDirectMessage,
          snapshot.navigation.teamPrincipal.id
        )
      : "";
  const authorityBackendId = snapshot?.connection.backendId;
  const authorityPrincipalUserId = snapshot?.navigation.teamPrincipal?.id;
  const authority = useMemo<DraftAuthority | null>(
    () =>
      authorityBackendId && authorityPrincipalUserId && teamId && threadId
        ? {
            backendId: authorityBackendId,
            principalUserId: authorityPrincipalUserId,
            teamId,
            threadId
          }
        : null,
    [authorityBackendId, authorityPrincipalUserId, teamId, threadId]
  );
  const authorityKey = authority ? JSON.stringify(authority) : null;
  if (previousAuthorityKey !== authorityKey) {
    setPreviousAuthorityKey(authorityKey);
    setHydratedAuthorityKey(null);
    setMessages([]);
    setMessageSelection(null);
    setPage(null);
    setDraftText("");
    setPendingSend(null);
    setOpenRootMessage(null);
    setOpenRootAuthorityKey(null);
    setThreadReplies([]);
    setThreadDraftText("");
    setThreadPendingSend(null);
    setThreadSendStatus(null);
    setThreadEditDrafts(new Map());
    setThreadRequests([]);
    setVisibleRead(null);
    setStatus((current) =>
      current === "Team access changed. Refresh to check your access."
        ? current
        : null
    );
  }
  const visibleOpenRoot =
    openRootMessage &&
    openRootAuthorityKey === authorityKey &&
    openRootMessage.teamId === activeTeam?.id &&
    openRootMessage.threadId === activeThread?.id
      ? openRootMessage
      : null;
  const teamMentionScopeKey = JSON.stringify({
    backendId: snapshot?.connection.backendId ?? "",
    principalId: snapshot?.navigation.teamPrincipal?.id ?? "",
    teamId,
    threadId: activeThread?.id ?? ""
  });
  const activeMentionAgentId = teamMentionSelectionForScope(
    teamMentionSelection,
    teamMentionScopeKey
  );
  const messagesMatchSelection = Boolean(
    activeThread &&
    messageSelection?.teamId === teamId &&
    messageSelection.threadId === activeThread.id
  );
  const visibleMessages = messagesMatchSelection ? messages : [];
  const visibleChannelMessages = activeDirectMessage
    ? visibleMessages
    : visibleMessages.filter((message) => message.rootMessageId == null);
  const sharedChannelMessages = toTeamChatMessages(
    visibleChannelMessages,
    snapshot?.navigation.teamPrincipal?.id ?? ""
  );
  const visiblePage = messagesMatchSelection ? page : null;
  const visibleDraftText =
    authorityKey && hydratedAuthorityKey === authorityKey ? draftText : "";
  const visiblePendingSend =
    authorityKey && hydratedAuthorityKey === authorityKey ? pendingSend : null;
  const authorityKeyRef = useRef<string | null>(authorityKey);
  useLayoutEffect(() => {
    authorityKeyRef.current = authorityKey;
    selectedRef.current = { teamId, threadId };
  }, [authorityKey, teamId, threadId]);

  const run = useCallback(
    async (
      command: CollaborationRendererCommand["command"],
      input: Record<string, unknown>,
      requestId?: string
    ) => client.run(command, input, requestId),
    [client]
  );

  const persistDraft = useCallback(
    (
      draftAuthority: DraftAuthority,
      candidate: StudioTeamDraft
    ): Promise<StudioTeamDraft> => {
      const key = JSON.stringify(draftAuthority);
      const capturedGeneration =
        draftAuthorityGenerations.current.get(key) ?? 0;
      if (
        !teamDraftWriteMayApply({
          capturedGeneration,
          currentGeneration: capturedGeneration,
          invalidated: invalidDraftAuthorities.current.has(key)
        })
      ) {
        return Promise.reject(
          new Error("This Team draft authority is no longer active.")
        );
      }
      const previous = draftWriteTails.current.get(key) ?? Promise.resolve();
      const operation = previous
        .catch(() => undefined)
        .then(async () => {
          if (
            !teamDraftWriteMayApply({
              capturedGeneration,
              currentGeneration:
                draftAuthorityGenerations.current.get(key) ?? 0,
              invalidated: invalidDraftAuthorities.current.has(key)
            })
          )
            throw new Error("This Team draft authority is no longer active.");
          const latest = draftByAuthority.current.get(key) ?? candidate;
          const completions = receiptCompletions.current.get(key);
          const latestCompletion = latest.pendingSend
            ? completions?.get(latest.pendingSend.clientMessageId)
            : undefined;
          const candidateCompletion = candidate.pendingSend
            ? completions?.get(candidate.pendingSend.clientMessageId)
            : undefined;
          const completion = latestCompletion
            ? {
                clientMessageId: latest.pendingSend!.clientMessageId,
                ...latestCompletion
              }
            : candidateCompletion
              ? {
                  clientMessageId: candidate.pendingSend!.clientMessageId,
                  ...candidateCompletion
                }
              : null;
          const value = completion
            ? draftAfterCompletedReceiptWrite({
                latest,
                candidate,
                ...completion
              })
            : candidate;
          await drafts.saveDraft(draftAuthority, value);
          if (
            !teamDraftWriteMayApply({
              capturedGeneration,
              currentGeneration:
                draftAuthorityGenerations.current.get(key) ?? 0,
              invalidated: invalidDraftAuthorities.current.has(key)
            })
          )
            throw new Error("This Team draft authority is no longer active.");
          if (completion && draftByAuthority.current.get(key) === latest) {
            draftByAuthority.current.set(key, value);
          }
          return value;
        });
      const tail = operation.then(
        () => undefined,
        () => undefined
      );
      draftWriteTails.current.set(key, tail);
      void tail.then(() => {
        if (draftWriteTails.current.get(key) === tail)
          draftWriteTails.current.delete(key);
      });
      return operation;
    },
    [drafts]
  );

  const invalidateDraftAuthority = useCallback(
    (draftAuthority: DraftAuthority): Promise<void> => {
      const key = JSON.stringify(draftAuthority);
      draftAuthorityGenerations.current.set(
        key,
        (draftAuthorityGenerations.current.get(key) ?? 0) + 1
      );
      invalidDraftAuthorities.current.add(key);
      draftByAuthority.current.delete(key);
      const previous = draftWriteTails.current.get(key) ?? null;
      const operation = deleteTeamDraftAfterQueuedWrite({
        queuedWrite: previous,
        deleteDraft: () => drafts.deleteDraft(draftAuthority)
      });
      const tail = operation.then(
        () => undefined,
        () => undefined
      );
      draftWriteTails.current.set(key, tail);
      void tail.then(() => {
        if (draftWriteTails.current.get(key) === tail)
          draftWriteTails.current.delete(key);
      });
      return operation;
    },
    [drafts]
  );

  const acknowledgeReceiptMarker = useCallback(
    async (
      draftAuthority: DraftAuthority,
      marker: NonNullable<StudioTeamDraft["receiptAckPending"]>
    ) => {
      const purgeRevokedDraft = async (code: string | null) => {
        if (durableSendFailureDisposition(code) !== "authority_lost") return;
        const key = JSON.stringify(draftAuthority);
        const deletion = invalidateDraftAuthority(draftAuthority);
        if (authorityKeyRef.current === key)
          clearRevokedViewRef.current(draftAuthority, true);
        await deletion.catch(() => undefined);
      };
      try {
        const result = await run("collaboration.acknowledge_send_receipt", {
          thread: {
            scope: "team",
            teamId: draftAuthority.teamId,
            threadId: draftAuthority.threadId
          },
          rootMessageId: draftAuthority.rootMessageId ?? null,
          clientMessageId: marker.clientMessageId,
          messageId: marker.messageId
        });
        if (!result.ok) {
          await purgeRevokedDraft(result.error.code);
          throw new Error(result.error.userMessage);
        }
        if (!("acknowledged" in result.data) || !result.data.acknowledged) {
          throw new Error("The send receipt is still waiting to be confirmed.");
        }
      } catch (failure) {
        const code =
          failure &&
          typeof failure === "object" &&
          "code" in failure &&
          typeof failure.code === "string"
            ? failure.code
            : null;
        await purgeRevokedDraft(code);
        throw failure;
      }
    },
    [invalidateDraftAuthority, run]
  );

  const clearSavedReceiptMarker = useCallback(
    async (
      draftAuthority: DraftAuthority,
      marker: NonNullable<StudioTeamDraft["receiptAckPending"]>
    ) => {
      const key = JSON.stringify(draftAuthority);
      const completions =
        receiptCompletions.current.get(key) ??
        new Map<string, { messageId: string; acknowledged: boolean }>();
      const completion = completions.get(marker.clientMessageId) ?? {
        messageId: marker.messageId,
        acknowledged: false
      };
      completions.set(marker.clientMessageId, completion);
      receiptCompletions.current.set(key, completions);
      await acknowledgeReceiptMarker(draftAuthority, marker);
      if (revokedRef.current) return;
      if (completion.messageId === marker.messageId)
        completion.acknowledged = true;
      const latest = draftByAuthority.current.get(key);
      if (!latest) return;
      const withoutMarker = teamDraftWithoutReceiptAck(
        latest,
        marker.clientMessageId,
        marker.messageId
      );
      if (withoutMarker === latest) return;
      try {
        await persistDraft(draftAuthority, withoutMarker);
      } catch (failure) {
        completion.acknowledged = false;
        throw failure;
      }
      if (revokedRef.current) return;
      const current = draftByAuthority.current.get(key) ?? withoutMarker;
      const normalizedCurrent = teamDraftWithoutReceiptAck(
        current,
        marker.clientMessageId,
        marker.messageId
      );
      draftByAuthority.current.set(key, normalizedCurrent);
      if (authorityKeyRef.current === key) {
        setDraftText(normalizedCurrent.text);
        setPendingSend(normalizedCurrent.pendingSend);
      }
    },
    [acknowledgeReceiptMarker, persistDraft]
  );

  const completeAcceptedReceipt = useCallback(
    async (
      draftAuthority: DraftAuthority,
      receipt: CollaborationSendReceipt
    ): Promise<boolean> => {
      if (revokedRef.current) return false;
      if (
        receipt.thread.scope !== "team" ||
        receipt.thread.teamId !== draftAuthority.teamId ||
        receipt.thread.threadId !== draftAuthority.threadId ||
        receipt.message.scope !== "team" ||
        receipt.message.teamId !== draftAuthority.teamId ||
        receipt.message.threadId !== draftAuthority.threadId ||
        receipt.message.clientMessageId !== receipt.clientMessageId ||
        receipt.message.delivery !== "sent" ||
        receipt.message.rootMessageId !== (draftAuthority.rootMessageId ?? null)
      )
        return false;
      const key = JSON.stringify(draftAuthority);
      const priorCompletion = receiptCompletions.current
        .get(key)
        ?.get(receipt.clientMessageId);
      if (
        priorCompletion?.acknowledged &&
        priorCompletion.messageId === receipt.message.id
      )
        return true;
      const latest = draftByAuthority.current.get(key);
      if (!latest) return false;
      const settled = teamDraftForAcceptedReceipt({
        authority: draftAuthority,
        draft: latest,
        receipt
      });
      if (!settled) return false;
      const marker = settled.receiptAckPending!;
      const completions =
        receiptCompletions.current.get(key) ??
        new Map<string, { messageId: string; acknowledged: boolean }>();
      completions.set(marker.clientMessageId, {
        messageId: marker.messageId,
        acknowledged: false
      });
      receiptCompletions.current.set(key, completions);
      saveSequence.current += 1;
      try {
        let saved = await persistDraft(draftAuthority, latest);
        if (revokedRef.current) return false;
        // If the user edited while IndexedDB was saving, save that newer text
        // with the same exact pending-send resolution before acknowledging.
        while (true) {
          const current = draftByAuthority.current.get(key) ?? saved;
          if (current.text !== saved.text) {
            saved = await persistDraft(draftAuthority, current);
            if (revokedRef.current) return false;
            continue;
          }
          if (
            current.pendingSend?.clientMessageId === receipt.clientMessageId
          ) {
            saved = await persistDraft(draftAuthority, current);
            if (revokedRef.current) return false;
            continue;
          }
          break;
        }
        const current = draftByAuthority.current.get(key) ?? saved;
        const committed =
          current.pendingSend?.clientMessageId === receipt.clientMessageId
            ? (teamDraftForAcceptedReceipt({
                authority: draftAuthority,
                draft: current,
                receipt
              }) ?? saved)
            : { ...current, receiptAckPending: marker };
        draftByAuthority.current.set(key, committed);
        if (authorityKeyRef.current === key) {
          setDraftText(committed.text);
          setPendingSend(committed.pendingSend);
          setStatus(null);
          setMessages((messagesNow) =>
            mergeTeamMessages(messagesNow, [receipt.message])
          );
        } else if (
          threadReceiptMayUpdatePane({
            draftAuthority,
            currentAuthorityKey: authorityKeyRef.current,
            openRoot: openRootRef.current
          })
        ) {
          setThreadDraftText(committed.text);
          setThreadPendingSend(committed.pendingSend);
          setThreadSendStatus(committed.pendingSend ? "pending" : null);
          setThreadReplies((messagesNow) =>
            mergeTeamMessages(messagesNow, [receipt.message])
          );
        }
        await clearSavedReceiptMarker(draftAuthority, marker);
        return true;
      } catch {
        if (!revokedRef.current && authorityKeyRef.current === key) {
          const current = draftByAuthority.current.get(key);
          if (
            current?.pendingSend?.clientMessageId !== receipt.clientMessageId
          ) {
            setStatus(
              "Message sent. Device confirmation is still being saved."
            );
          } else {
            setStatus(
              "The sent message is confirmed. Its local draft is still being saved."
            );
          }
        }
        return false;
      }
    },
    [clearSavedReceiptMarker, persistDraft]
  );

  const clearRevokedView = useCallback(
    (protectedAuthority?: DraftAuthority, invalidationQueued = false) => {
      let authorityToPurge = protectedAuthority ?? undefined;
      if (!authorityToPurge && authorityKeyRef.current) {
        try {
          authorityToPurge = JSON.parse(
            authorityKeyRef.current
          ) as DraftAuthority;
        } catch {
          authorityToPurge = undefined;
        }
      }
      if (authorityToPurge && !invalidationQueued)
        void invalidateDraftAuthority(authorityToPurge).catch(() => undefined);
      revokedRef.current = true;
      snapshotEpoch.current += 1;
      pendingNotificationDestination.current = null;
      selectedRef.current = { teamId: "", threadId: "" };
      setVisibleRead(null);
      setSnapshot(null);
      setTeamId("");
      setThreadId("");
      setMessages([]);
      openRootRef.current = null;
      setOpenRootMessage(null);
      setOpenRootAuthorityKey(null);
      setThreadReplies([]);
      setThreadDraftText("");
      setThreadPendingSend(null);
      setThreadSendStatus(null);
      setThreadEditDrafts(new Map());
      setThreadRequests([]);
      setMessageSelection(null);
      setPage(null);
      setDraftText("");
      setPendingSend(null);
      setLoading(false);
      setHydratedAuthorityKey(null);
      setVisibleRead(null);
      setStatus("Team access changed. Refresh to check your access.");
      setSquareOpen(false);
      setForYouOpen(false);
      setPendingAgentMention(null);
      setCreateChannelOpen(false);
      setCreateProjectOpen(false);
      draftByAuthority.current.clear();
      receiptCompletions.current.clear();
      saveSequence.current += 1;
      readReported.current.clear();
      readPending.current.clear();
    },
    [invalidateDraftAuthority]
  );
  useEffect(() => {
    clearRevokedViewRef.current = clearRevokedView;
  }, [clearRevokedView]);
  const recoverPendingReceipt = useCallback(
    async (
      draftAuthority: DraftAuthority,
      clientMessageId: string
    ): Promise<"recovered" | "missing" | "error"> => {
      const receiptAuthorityKey = JSON.stringify(draftAuthority);
      const applyAcknowledgedThreadReceipt = async () => {
        if (
          !threadReceiptMayUpdatePane({
            draftAuthority,
            currentAuthorityKey: authorityKeyRef.current,
            openRoot: openRootRef.current
          })
        )
          return;
        let latest = draftByAuthority.current.get(receiptAuthorityKey);
        if (latest?.pendingSend?.clientMessageId === clientMessageId) {
          latest = resolvePendingSend(
            latest,
            clientMessageId,
            "accepted",
            latest.pendingSend.body
          );
          draftByAuthority.current.set(receiptAuthorityKey, latest);
          try {
            await persistDraft(draftAuthority, latest);
          } catch {
            if (
              threadReceiptMayUpdatePane({
                draftAuthority,
                currentAuthorityKey: authorityKeyRef.current,
                openRoot: openRootRef.current
              })
            )
              setStatus(
                "Reply sent. The cleared device draft could not be saved."
              );
          }
        }
        if (
          !threadReceiptMayUpdatePane({
            draftAuthority,
            currentAuthorityKey: authorityKeyRef.current,
            openRoot: openRootRef.current
          })
        )
          return;
        latest = draftByAuthority.current.get(receiptAuthorityKey);
        setThreadPendingSend(latest?.pendingSend ?? null);
        setThreadSendStatus(latest?.pendingSend ? "pending" : null);
        if (latest) setThreadDraftText(latest.text);
      };
      const completion = receiptCompletions.current
        .get(receiptAuthorityKey)
        ?.get(clientMessageId);
      if (
        acknowledgedReceiptMessageId({
          requestedAuthorityKey: JSON.stringify(draftAuthority),
          receiptAuthorityKey,
          requestedClientMessageId: clientMessageId,
          receiptClientMessageId: clientMessageId,
          completion
        })
      ) {
        await applyAcknowledgedThreadReceipt();
        return "recovered";
      }
      const result = await run("collaboration.get_send_receipt", {
        thread: {
          scope: "team",
          teamId: draftAuthority.teamId,
          threadId: draftAuthority.threadId
        },
        rootMessageId: draftAuthority.rootMessageId ?? null,
        clientMessageId
      });
      if (!result.ok) {
        if (
          durableSendFailureDisposition(result.error.code) === "authority_lost"
        ) {
          if (authorityKeyRef.current === JSON.stringify(draftAuthority))
            clearRevokedView(draftAuthority);
          else
            void invalidateDraftAuthority(draftAuthority).catch(
              () => undefined
            );
        } else if (authorityKeyRef.current === JSON.stringify(draftAuthority))
          setStatus(result.error.userMessage);
        return "error";
      }
      if (!("receipt" in result.data) || !result.data.receipt) return "missing";
      const receipt = result.data.receipt;
      if (
        receipt.clientMessageId !== clientMessageId ||
        receipt.message.rootMessageId !== (draftAuthority.rootMessageId ?? null)
      )
        return "error";
      const recovered = await completeAcceptedReceipt(draftAuthority, receipt);
      if (recovered) await applyAcknowledgedThreadReceipt();
      return recovered ? "recovered" : "error";
    },
    [
      clearRevokedView,
      completeAcceptedReceipt,
      invalidateDraftAuthority,
      persistDraft,
      run
    ]
  );
  const refreshSnapshot = useCallback(async (): Promise<boolean> => {
    const epoch = snapshotEpoch.current;
    try {
      const result = await run("collaboration.load", {
        forceRemoteNavigation: true
      });
      if (epoch !== snapshotEpoch.current) return false;
      if (result.ok && "snapshot" in result.data) {
        revokedRef.current = false;
        setSnapshot(result.data.snapshot);
        return true;
      }
      if (!result.ok && result.error.code === "access_revoked")
        clearRevokedView();
      else if (!result.ok) setStatus(result.error.userMessage);
      return false;
    } catch (failure) {
      if (epoch !== snapshotEpoch.current || revokedRef.current) return false;
      const described = describeStudioCommandFailure(failure);
      if (described.revoked) clearRevokedView();
      else setStatus(described.message);
      return false;
    }
  }, [clearRevokedView, run]);
  const refreshSnapshotRef = useRef(refreshSnapshot);
  useLayoutEffect(() => {
    refreshSnapshotRef.current = refreshSnapshot;
  }, [refreshSnapshot]);

  const loadPage = useCallback(
    async (
      id: string,
      selectedTeamId: string,
      cursor: string | null = null
    ): Promise<boolean> => {
      if (!UUID.test(id) || !UUID.test(selectedTeamId)) return false;
      setLoading(true);
      try {
        const result = await run("collaboration.load_message_page", {
          thread: { scope: "team", teamId: selectedTeamId, threadId: id },
          direction: cursor === null ? "newer" : "older",
          cursor,
          limit: 50
        });
        const stillSelected =
          selectedRef.current.teamId === selectedTeamId &&
          selectedRef.current.threadId === id;
        if (stillSelected && result.ok && "page" in result.data) {
          const validated = collaborationMessagePageSchema.safeParse(
            result.data.page
          );
          if (validated.success && validated.data.threadId === id) {
            setPage(validated.data);
            setMessageSelection({ teamId: selectedTeamId, threadId: id });
            setMessages((current) => {
              if (cursor === null && current.length === 0)
                return validated.data.items;
              return mergeTeamMessages(current, validated.data.items);
            });
            return true;
          }
        }
        if (stillSelected) {
          if (!result.ok && result.error.code === "access_revoked")
            clearRevokedView();
          else setStatus(result.ok ? null : result.error.userMessage);
        }
        return false;
      } catch (failure) {
        const stillSelected =
          selectedRef.current.teamId === selectedTeamId &&
          selectedRef.current.threadId === id;
        if (stillSelected && !revokedRef.current) {
          const described = describeStudioCommandFailure(failure);
          if (described.revoked) clearRevokedView();
          else setStatus(described.message);
        }
        return false;
      } finally {
        if (
          selectedRef.current.teamId === selectedTeamId &&
          selectedRef.current.threadId === id
        )
          setLoading(false);
      }
    },
    [clearRevokedView, run]
  );
  const loadPageRef = useRef(loadPage);
  useLayoutEffect(() => {
    loadPageRef.current = loadPage;
  }, [loadPage]);

  const loadRootReplies = useCallback(
    async (root: CollaborationMessage, cursor: string | null = null) => {
      if (!UUID.test(root.id) || !activeThread || !activeTeam) return;
      const capturedAuthorityKey = authorityKey;
      try {
        const result = await run("collaboration.load_message_page", {
          thread: {
            scope: "team",
            teamId: activeTeam.id,
            threadId: activeThread.id
          },
          rootMessageId: root.id,
          direction: cursor === null ? "newer" : "older",
          cursor,
          limit: 50
        });
        if (!result.ok || !("page" in result.data)) return;
        const parsed = collaborationMessagePageSchema.safeParse(
          result.data.page
        );
        if (
          !parsed.success ||
          parsed.data.threadId !== root.threadId ||
          parsed.data.rootMessageId !== root.id
        )
          return;
        if (
          authorityKeyRef.current !== capturedAuthorityKey ||
          selectedRef.current.threadId !== root.threadId ||
          openRootRef.current?.id !== root.id
        )
          return;
        setThreadPage(parsed.data);
        setThreadReplies((current) =>
          cursor === null
            ? parsed.data.items.filter((item) => item.rootMessageId === root.id)
            : mergeTeamMessages(
                current,
                parsed.data.items.filter(
                  (item) => item.rootMessageId === root.id
                )
              )
        );
        const updatedRoot = messages.find((message) => message.id === root.id);
        if (updatedRoot) setOpenRootMessage(updatedRoot);
      } catch {
        // The pane keeps its current snapshot and retries on the next update/open.
      }
    },
    [activeTeam, activeThread, authorityKey, messages, run]
  );
  useLayoutEffect(() => {
    openRootRef.current = openRootMessage;
  }, [openRootMessage]);
  const threadDraftEditGeneration = useRef(0);
  const openMessageThread = useCallback(
    (root: CollaborationMessage) => {
      const capturedDraftGeneration = ++threadDraftEditGeneration.current;
      setOpenRootAuthorityKey(authorityKey);
      setThreadDraftText("");
      setOpenRootMessage(root);
      openRootRef.current = root;
      setThreadReplies([]);
      setThreadPage(null);
      setThreadPendingSend(null);
      setThreadSendStatus(null);
      setThreadEditDrafts(new Map());
      const capturedAuthority = authority;
      const capturedAuthorityKey = authorityKey;
      if (capturedAuthority) {
        const replyAuthority = { ...capturedAuthority, rootMessageId: root.id };
        const replyAuthorityKey = JSON.stringify(replyAuthority);
        const hydrationGeneration =
          draftAuthorityGenerations.current.get(replyAuthorityKey) ?? 0;
        const queuedWrite = draftWriteTails.current.get(replyAuthorityKey);
        void (async () => {
          await queuedWrite?.catch(() => undefined);
          return drafts.loadDraft(replyAuthority);
        })()
          .then((stored) => {
            if (
              authorityKeyRef.current !== capturedAuthorityKey ||
              openRootRef.current?.id !== root.id ||
              (draftAuthorityGenerations.current.get(replyAuthorityKey) ??
                0) !== hydrationGeneration
            )
              return;
            const current = draftByAuthority.current.get(replyAuthorityKey);
            if (
              threadDraftEditGeneration.current !== capturedDraftGeneration &&
              !current
            )
              return;
            let hydratedDraft = teamDraftAfterReplyHydration(stored, current);
            const pending = hydratedDraft.pendingSend;
            if (pending) {
              const completion = receiptCompletions.current
                .get(replyAuthorityKey)
                ?.get(pending.clientMessageId);
              const acknowledgedMessageId = acknowledgedReceiptMessageId({
                requestedAuthorityKey: replyAuthorityKey,
                receiptAuthorityKey: replyAuthorityKey,
                requestedClientMessageId: pending.clientMessageId,
                receiptClientMessageId: pending.clientMessageId,
                completion
              });
              if (acknowledgedMessageId) {
                hydratedDraft = resolvePendingSend(
                  hydratedDraft,
                  pending.clientMessageId,
                  "accepted",
                  pending.body
                );
                hydratedDraft = teamDraftWithoutReceiptAck(
                  hydratedDraft,
                  pending.clientMessageId,
                  acknowledgedMessageId
                );
              }
            }
            draftByAuthority.current.set(replyAuthorityKey, hydratedDraft);
            if (threadDraftEditGeneration.current === capturedDraftGeneration)
              setThreadDraftText(hydratedDraft.text);
            setThreadMentionUserIds(hydratedDraft.mentionUserIds ?? []);
            setThreadPendingSend(hydratedDraft.pendingSend);
            setThreadSendStatus(hydratedDraft.pendingSend ? "pending" : null);
            if (current)
              void persistDraft(replyAuthority, hydratedDraft).catch(() => {
                if (
                  authorityKeyRef.current === capturedAuthorityKey &&
                  openRootRef.current?.id === root.id
                )
                  setStatus(
                    "The encrypted reply draft could not be saved on this device."
                  );
              });
          })
          .catch(() => {
            if (
              authorityKeyRef.current === capturedAuthorityKey &&
              openRootRef.current?.id === root.id
            )
              setStatus("The encrypted reply draft could not be opened.");
          });
      }
      void loadRootReplies(root);
    },
    [authority, authorityKey, drafts, loadRootReplies, persistDraft]
  );
  const saveReplyDraft = useCallback(
    (rootMessageId: string, text: string, mentionUserIds?: string[]) => {
      if (
        !authority ||
        authorityKeyRef.current !== authorityKey ||
        openRootRef.current?.id !== rootMessageId ||
        openRootRef.current.teamId !== authority.teamId ||
        openRootRef.current.threadId !== authority.threadId
      )
        return;
      const replyAuthority = { ...authority, rootMessageId };
      const key = JSON.stringify(replyAuthority);
      const nextDraft = teamDraftAfterReplyTextChange(
        draftByAuthority.current.get(key),
        text,
        null
      );
      const draft =
        mentionUserIds === undefined
          ? nextDraft
          : { ...nextDraft, mentionUserIds };
      draftByAuthority.current.set(key, draft);
      void persistDraft(replyAuthority, draft).catch(() => {
        if (
          authorityKeyRef.current === authorityKey &&
          openRootRef.current?.id === rootMessageId
        )
          setStatus(
            "The encrypted reply draft could not be saved on this device."
          );
      });
    },
    [authority, authorityKey, persistDraft]
  );

  const sendThreadReply = useCallback(
    async (
      text: string,
      clientMessageId?: string,
      mentionUserIds: string[] = []
    ) => {
      const root = openRootMessage;
      if (!root || !authority || !activeTeamId || !text.trim()) return false;
      const identity =
        threadPendingSend?.body === text
          ? threadPendingSend
          : {
              clientMessageId: clientMessageId ?? crypto.randomUUID(),
              body: text,
              createdAt: new Date().toISOString(),
              mentionUserIds
            };
      const replyAuthority = { ...authority, rootMessageId: root.id };
      const replyAuthorityKey = JSON.stringify(replyAuthority);
      const sendKey = `${replyAuthorityKey}:${identity.clientMessageId}`;
      if (threadSendInFlight.current.has(sendKey)) return false;
      threadSendInFlight.current.add(sendKey);
      const existingDraft = draftByAuthority.current.get(replyAuthorityKey);
      const retryingExistingSend =
        existingDraft?.pendingSend?.clientMessageId ===
          identity.clientMessageId ||
        threadPendingSend?.clientMessageId === identity.clientMessageId;
      const pendingDraft = teamDraftForReplyAttempt(
        existingDraft,
        identity,
        retryingExistingSend,
        threadDraftText
      );
      setThreadPendingSend(identity);
      setThreadSendStatus("pending");
      setThreadDraftText(pendingDraft.text);
      setThreadMentionUserIds([]);
      draftByAuthority.current.set(
        JSON.stringify(replyAuthority),
        pendingDraft
      );
      try {
        try {
          await drafts.saveDraft(replyAuthority, pendingDraft);
        } catch {
          draftByAuthority.current.set(replyAuthorityKey, {
            text: identity.body,
            mentionUserIds: identity.mentionUserIds ?? [],
            pendingSend: null,
            receiptAckPending: null
          });
          if (
            authorityKeyRef.current === JSON.stringify(authority) &&
            openRootRef.current?.id === root.id
          ) {
            setThreadPendingSend(null);
            setThreadSendStatus(null);
            setThreadDraftText(identity.body);
            setThreadMentionUserIds(identity.mentionUserIds ?? []);
            setStatus(
              "The reply could not be saved on this device, so it was not sent."
            );
          }
          return false;
        }
        if (connectionState !== "live") {
          setStatus(
            "Pending · the reply is saved on this device until you reconnect."
          );
          return false;
        }
        const receiptRecovery = await recoverPendingReceipt(
          replyAuthority,
          identity.clientMessageId
        );
        if (receiptRecovery === "recovered") return true;
        if (receiptRecovery !== "missing") return false;
        if (
          authorityKeyRef.current !== JSON.stringify(authority) ||
          openRootRef.current?.id !== root.id
        )
          return false;
        const result = await run("collaboration.send_message", {
          thread: {
            scope: "team",
            teamId: root.teamId,
            threadId: root.threadId
          },
          rootMessageId: root.id,
          clientMessageId: identity.clientMessageId,
          body: identity.body,
          mentionUserIds: identity.mentionUserIds ?? []
        });
        if (
          result.ok &&
          "message" in result.data &&
          result.data.message.rootMessageId === root.id
        ) {
          const acceptedMessage = result.data.message;
          const priorCompletion = receiptCompletions.current
            .get(replyAuthorityKey)
            ?.get(identity.clientMessageId);
          const acknowledgedMessageId = acknowledgedReceiptMessageId({
            requestedAuthorityKey: replyAuthorityKey,
            receiptAuthorityKey: replyAuthorityKey,
            requestedClientMessageId: identity.clientMessageId,
            receiptClientMessageId: identity.clientMessageId,
            completion: priorCompletion
          });
          draftByAuthority.current.set(
            replyAuthorityKey,
            teamDraftAfterAcceptedSendResult(
              draftByAuthority.current.get(replyAuthorityKey),
              identity,
              acceptedMessage.id,
              acknowledgedMessageId
            )
          );
          const confirmed = await completeAcceptedReceipt(replyAuthority, {
            thread: {
              scope: "team",
              teamId: root.teamId ?? authority.teamId,
              threadId: root.threadId
            },
            clientMessageId: identity.clientMessageId,
            message: acceptedMessage,
            acceptedBody:
              "acceptedBody" in result.data &&
              typeof result.data.acceptedBody === "string"
                ? result.data.acceptedBody
                : acceptedMessage.body
          });
          const settled = draftByAuthority.current.get(replyAuthorityKey);
          if (
            authorityKeyRef.current === JSON.stringify(authority) &&
            openRootRef.current?.id === root.id
          ) {
            setThreadReplies((current) =>
              mergeTeamMessages(current, [acceptedMessage])
            );
            setThreadSendStatus(confirmed ? null : "uncertain");
            setThreadPendingSend(
              pendingSendAfterReceiptResolution(settled, identity, confirmed)
            );
            setThreadDraftText(settled?.text ?? "");
            setThreadMentionUserIds(settled?.mentionUserIds ?? []);
            setOpenRootMessage((current) =>
              current?.id === root.id
                ? { ...current, replyCount: current.replyCount + 1 }
                : current
            );
          }
          return confirmed;
        }
        if (result.ok && "durableSend" in result.data) {
          const completion = receiptCompletions.current
            .get(replyAuthorityKey)
            ?.get(identity.clientMessageId);
          if (
            acknowledgedReceiptMessageId({
              requestedAuthorityKey: replyAuthorityKey,
              receiptAuthorityKey: replyAuthorityKey,
              requestedClientMessageId: identity.clientMessageId,
              receiptClientMessageId: identity.clientMessageId,
              completion
            })
          )
            return true;
          if (
            authorityKeyRef.current === JSON.stringify(authority) &&
            openRootRef.current?.id === root.id
          ) {
            setThreadSendStatus(
              result.data.durableSend.state === "failed"
                ? "retry_failed"
                : "pending"
            );
            setStatus(durableSendStatus(result.data.durableSend));
          }
          return false;
        }
        if (!result.ok && result.error.code === "access_revoked")
          clearRevokedView();
        else if (
          !result.ok &&
          authorityKeyRef.current === JSON.stringify(authority) &&
          openRootRef.current?.id === root.id
        ) {
          setThreadSendStatus(
            result.error.retryable ? "uncertain" : "retry_failed"
          );
          setStatus(result.error.userMessage);
        } else if (
          result.ok &&
          authorityKeyRef.current === JSON.stringify(authority) &&
          openRootRef.current?.id === root.id
        ) {
          setThreadSendStatus("uncertain");
          setStatus(
            "Reply delivery is still being confirmed. Retry with the saved identity when connected."
          );
        }
        return false;
      } catch (failure) {
        if (
          authorityKeyRef.current === JSON.stringify(authority) &&
          openRootRef.current?.id === root.id
        ) {
          setThreadSendStatus("uncertain");
          setStatus(
            failure instanceof Error
              ? failure.message
              : "Reply delivery is being confirmed."
          );
        }
        return false;
      } finally {
        threadSendInFlight.current.delete(sendKey);
      }
    },
    [
      authority,
      clearRevokedView,
      completeAcceptedReceipt,
      drafts,
      openRootMessage,
      recoverPendingReceipt,
      run,
      connectionState,
      activeTeamId,
      threadDraftText,
      threadPendingSend
    ]
  );

  const startThreadEdit = useCallback(
    async (message: CollaborationMessage) => {
      if (!authority) return;
      const capturedRootId = openRootRef.current?.id;
      const capturedAuthorityKey = authorityKey;
      const editAuthority = { ...authority, editMessageId: message.id };
      const stored = await drafts.loadDraft(editAuthority).catch(() => null);
      if (
        authorityKeyRef.current !== capturedAuthorityKey ||
        openRootRef.current?.id !== capturedRootId
      )
        return;
      const edit: ThreadEditDraft = stored?.edit
        ? { text: stored.text, ...stored.edit }
        : {
            text: message.body,
            expectedVersion: message.version,
            baseBodyText: message.body
          };
      setThreadEditDrafts((current) => new Map(current).set(message.id, edit));
    },
    [authority, authorityKey, drafts]
  );

  const persistThreadEdit = useCallback(
    (message: CollaborationMessage, edit: ThreadEditDraft) => {
      if (!authority) return;
      setThreadEditDrafts((current) => new Map(current).set(message.id, edit));
      void drafts
        .saveDraft(
          { ...authority, editMessageId: message.id },
          {
            text: edit.text,
            pendingSend: null,
            receiptAckPending: null,
            edit: {
              expectedVersion: edit.expectedVersion,
              baseBodyText: edit.baseBodyText,
              ...(edit.conflict ? { conflict: edit.conflict } : {})
            }
          }
        )
        .catch(() =>
          setStatus(
            "The encrypted edit draft could not be saved on this device."
          )
        );
    },
    [authority, drafts]
  );

  const saveThreadEdit = useCallback(
    async (message: CollaborationMessage, edit: ThreadEditDraft) => {
      if (!activeTeam || !activeThread || snapshot?.connection.state !== "live")
        return;
      const capturedAuthorityKey = authorityKey;
      const capturedAuthority = authority;
      const capturedRootId = openRootMessage?.id;
      const result = await run("collaboration.edit_message", {
        thread: {
          scope: "team",
          teamId: activeTeam.id,
          threadId: activeThread.id
        },
        messageId: message.id,
        body: edit.text,
        expectedVersion: edit.expectedVersion
      });
      if (result.ok && "message" in result.data) {
        const updated = result.data.message;
        if (
          authorityKeyRef.current !== capturedAuthorityKey ||
          openRootRef.current?.id !== capturedRootId
        ) {
          if (capturedAuthority)
            await drafts
              .deleteDraft({ ...capturedAuthority, editMessageId: message.id })
              .catch(() => undefined);
          return;
        }
        setMessages((current) => mergeTeamMessages(current, [updated]));
        if (updated.rootMessageId !== null)
          setThreadReplies((current) => mergeTeamMessages(current, [updated]));
        setOpenRootMessage((current) =>
          current?.id === updated.id ? updated : current
        );
        setThreadEditDrafts((current) => {
          const next = new Map(current);
          next.delete(message.id);
          return next;
        });
        if (capturedAuthority)
          await drafts
            .deleteDraft({ ...capturedAuthority, editMessageId: message.id })
            .catch(() => undefined);
      } else if (!result.ok && result.error.code === "access_revoked")
        clearRevokedView();
      else if (!result.ok) {
        if (
          authorityKeyRef.current !== capturedAuthorityKey ||
          openRootRef.current?.id !== capturedRootId
        )
          return;
        let cursor: string | null = null;
        let latest: CollaborationMessage | undefined;
        while (!latest) {
          const latestPage = await run("collaboration.load_message_page", {
            thread: {
              scope: "team",
              teamId: activeTeam.id,
              threadId: activeThread.id
            },
            rootMessageId: message.rootMessageId ?? null,
            direction: cursor === null ? "newer" : "older",
            cursor,
            limit: 50
          });
          if (!latestPage.ok || !("page" in latestPage.data)) return;
          const parsed = collaborationMessagePageSchema.safeParse(
            latestPage.data.page
          );
          if (
            !parsed.success ||
            authorityKeyRef.current !== capturedAuthorityKey ||
            openRootRef.current?.id !== capturedRootId
          )
            return;
          latest = parsed.data.items.find((item) => item.id === message.id);
          if (latest || !parsed.data.hasOlder || !parsed.data.olderCursor)
            break;
          cursor = parsed.data.olderCursor;
        }
        if (latest) {
          const conflict = editDraftAfterConflict(
            { text: edit.text, edit },
            { version: latest.version, bodyText: latest.body }
          );
          if (conflict.edit)
            persistThreadEdit(message, { ...edit, ...conflict.edit });
          setMessages((current) => mergeTeamMessages(current, [latest]));
          if (latest.rootMessageId !== null)
            setThreadReplies((current) => mergeTeamMessages(current, [latest]));
        }
        if (
          authorityKeyRef.current === capturedAuthorityKey &&
          openRootRef.current?.id === capturedRootId
        )
          setStatus(result.error.userMessage);
      }
    },
    [
      activeTeam,
      activeThread,
      authority,
      authorityKey,
      clearRevokedView,
      drafts,
      openRootMessage?.id,
      persistThreadEdit,
      run,
      snapshot?.connection.state
    ]
  );

  const toggleThreadReaction = useCallback(
    async (message: CollaborationMessage, emoji: string) => {
      if (!activeTeam || !activeThread || snapshot?.connection.state !== "live")
        return;
      const capturedAuthorityKey = authorityKey;
      const capturedRoot = openRootRef.current;
      if (
        !capturedAuthorityKey ||
        !messageReactionMayStart({
          message,
          teamId: activeTeam.id,
          threadId: activeThread.id,
          openRootMessageId:
            capturedRoot?.teamId === activeTeam.id &&
            capturedRoot.threadId === activeThread.id
              ? capturedRoot.id
              : null
        })
      )
        return;
      const existing = message.reactions.find((item) => item.emoji === emoji);
      const result = await run("collaboration.set_message_reaction", {
        thread: {
          scope: "team",
          teamId: activeTeam.id,
          threadId: activeThread.id
        },
        messageId: message.id,
        emoji,
        active: !existing?.reacted
      });
      if (authorityKeyRef.current !== capturedAuthorityKey) return;
      if (result.ok && "message" in result.data) {
        const updated = result.data.message;
        setMessages((current) => mergeTeamMessages(current, [updated]));
        const currentRootId = openRootRef.current?.id ?? null;
        if (
          currentRootId &&
          currentRootId === capturedRoot?.id &&
          messageReactionMayUpdateOpenPane({
            message: updated,
            openRootMessageId: currentRootId
          }) &&
          updated.rootMessageId !== null
        )
          setThreadReplies((current) => mergeTeamMessages(current, [updated]));
        if (
          currentRootId &&
          currentRootId === capturedRoot?.id &&
          updated.id === currentRootId
        )
          setOpenRootMessage((current) =>
            current?.id === updated.id ? updated : current
          );
      } else if (!result.ok && result.error.code === "access_revoked")
        clearRevokedView();
    },
    [
      activeTeam,
      activeThread,
      authorityKey,
      clearRevokedView,
      run,
      snapshot?.connection.state
    ]
  );

  const markThreadReplyVisible = useCallback(
    (message: CollaborationMessage) => {
      const root = openRootRef.current;
      if (
        !authority ||
        !root ||
        message.rootMessageId !== root.id ||
        snapshot?.connection.state !== "live"
      )
        return;
      const key = JSON.stringify({ ...authority, rootMessageId: root.id });
      const lastReportedSequence = readSequenceFor(
        threadReadReported.current,
        key
      );
      if (
        threadReadPending.current.get(key) === message.sequence ||
        !visibleReplyReadMayAdvance({
          rootMessageId: root.id,
          replyMessageId: message.id,
          sequence: message.sequence,
          senderId: message.sender.id,
          principalUserId: authority.principalUserId,
          focused:
            document.visibilityState === "visible" && document.hasFocus(),
          rootPaneVisible: openRootRef.current?.id === root.id,
          lastReportedSequence
        })
      )
        return;
      threadReadPending.current.set(key, message.sequence);
      void run("collaboration.mark_read", {
        thread: {
          scope: "team",
          teamId: root.teamId ?? teamId,
          threadId: root.threadId
        },
        rootMessageId: root.id,
        messageId: message.id
      })
        .then((result) => {
          if (result.ok && authorityKeyRef.current === authorityKey) {
            rememberReadSequence(
              threadReadReported.current,
              key,
              message.sequence
            );
            void loadRootReplies(root);
          }
        })
        .finally(() => {
          if (threadReadPending.current.get(key) === message.sequence)
            threadReadPending.current.delete(key);
        });
    },
    [
      authority,
      authorityKey,
      loadRootReplies,
      run,
      snapshot?.connection.state,
      teamId
    ]
  );

  const replyRetryAttempted = useRef<string | null>(null);
  useEffect(() => {
    if (connectionState !== "live") {
      replyRetryAttempted.current = null;
      return;
    }
    if (
      !openRootMessage ||
      !threadPendingSend ||
      replyRetryAttempted.current === threadPendingSend.clientMessageId
    )
      return;
    replyRetryAttempted.current = threadPendingSend.clientMessageId;
    void sendThreadReply(
      threadPendingSend.body,
      threadPendingSend.clientMessageId
    );
  }, [openRootMessage, sendThreadReply, connectionState, threadPendingSend]);

  useEffect(() => {
    let active = true;
    if (!activeTeamId || revokedRef.current) {
      return () => {
        active = false;
      };
    }
    void listRegisteredLocalProjects()
      .then((projects) => {
        if (active)
          setLocalProjectsState({
            owner: localProjectsOwner,
            loaded: true,
            projects: projects.map((project) => ({
              id: project.id,
              name: project.name
            }))
          });
      })
      .catch(() => {
        if (active)
          setLocalProjectsState({
            owner: localProjectsOwner,
            loaded: true,
            projects: []
          });
      });
    return () => {
      active = false;
    };
  }, [activeTeamId, localProjectsOwner]);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | null = null;
    const expectedBackendId = snapshot?.connection.backendId ?? null;
    const expectedPrincipalId = snapshot?.navigation.teamPrincipal?.id ?? null;
    if (
      !teamId ||
      !expectedBackendId ||
      !expectedPrincipalId ||
      revokedRef.current
    ) {
      return () => {
        active = false;
      };
    }
    void (async () => {
      const refreshed = await refreshSnapshotRef.current();
      if (!active || !refreshed) return;
      const current = client.current();
      if (
        !current ||
        current.connection.backendId !== expectedBackendId ||
        current.navigation.teamPrincipal?.id !== expectedPrincipalId ||
        !current.navigation.teams.some((team) => team.id === teamId)
      )
        return;
      const selection = teamSelectionForWorkspace(
        current,
        teamId,
        selectedRef.current.threadId
      );
      if (!selection || selectedRef.current.teamId !== teamId) return;
      let selected;
      try {
        selected = await client.run("collaboration.select", {
          selection,
          navigationIntent: "foreground"
        });
      } catch {
        if (active)
          setStatus(
            "The selected Team is not available. Refresh to try again."
          );
        return;
      }
      if (!active || selectedRef.current.teamId !== teamId) return;
      if (!selected.ok) {
        if (selected.error.code === "access_revoked") clearRevokedView();
        else setStatus(selected.error.userMessage);
        return;
      }
      if (!("snapshot" in selected.data)) return;
      const selectedSnapshot = selected.data.snapshot;
      const selectedTeamId =
        "teamId" in selectedSnapshot.selection
          ? selectedSnapshot.selection.teamId
          : null;
      if (
        !selectedTeamSnapshotMayStartSubscription({
          active,
          currentTeamId: selectedRef.current.teamId,
          expectedBackendId,
          expectedPrincipalId,
          teamId,
          selectedSnapshot: {
            connection: selectedSnapshot.connection,
            navigation: selectedSnapshot.navigation,
            selectionTeamId: selectedTeamId
          }
        })
      )
        return;
      unsubscribe = client.subscribe(
        async (event) => {
          if (event.type === "update") {
            if (event.update.type === "public_square_invalidated") {
              const invalidation = event.update as { teamId: string };
              if (invalidation.teamId !== teamId) return true;
              await refreshSnapshotRef.current();
              await refreshSquare();
              // The invalidation was handled. Keep the durable event from hot-looping
              // when the authoritative read is temporarily unavailable; Retry remains visible.
              return true;
            }
            if (
              event.update.type === "team_agent_request_invalidated" &&
              event.update.teamId === teamId
            ) {
              if (event.update.kind === "offers") {
                setAgentOfferRevision((revision) => revision + 1);
                await refreshSquare();
              } else setAgentRequestRevision((revision) => revision + 1);
            }
            const selected = selectedRef.current;
            if (selected.teamId !== teamId) return false;
            if (
              event.resource.scope !== "team" ||
              event.resource.teamId !== teamId
            )
              return true;
            const changedThread = event.resource.threadId;
            if (
              (event.update.type === "message_created" ||
                event.update.type === "message_updated") &&
              event.update.message.teamId === teamId &&
              event.update.message.threadId === selected.threadId &&
              authorityKeyRef.current ===
                JSON.stringify({
                  backendId: expectedBackendId,
                  principalUserId: expectedPrincipalId,
                  teamId,
                  threadId: selected.threadId
                })
            ) {
              const message = event.update.message;
              const currentRoot = openRootRef.current;
              setMessages((current) => mergeTeamMessages(current, [message]));
              if (
                currentRoot &&
                currentRoot.teamId === teamId &&
                currentRoot.threadId === selected.threadId &&
                openRootRef.current?.id === currentRoot.id
              ) {
                if (
                  message.id === currentRoot.id &&
                  message.rootMessageId === null
                )
                  setOpenRootMessage((current) =>
                    current?.id === currentRoot.id ? message : current
                  );
                else if (message.rootMessageId === currentRoot.id)
                  setThreadReplies((current) =>
                    mergeTeamMessages(current, [message])
                  );
              }
            }
            const historyApplied =
              changedThread && changedThread === selected.threadId
                ? await loadPageRef.current(changedThread, selected.teamId)
                : true;
            const snapshotApplied = await refreshSnapshotRef.current();
            const current = selectedRef.current;
            return realtimeUpdateMayAcknowledge({
              eventTeamId: teamId,
              eventThreadId: changedThread,
              currentTeamId: current.teamId,
              currentThreadId: current.threadId,
              historyApplied,
              snapshotApplied
            });
          } else if (event.type === "durable_send") {
            const sendAuthority = event.send.authority;
            const currentAuthorityKey = authorityKeyRef.current;
            if (
              sendAuthority.scope !== "team" ||
              sendAuthority.teamId !== teamId ||
              !studioSelectionMatches(
                {
                  teamId: sendAuthority.teamId,
                  threadId: sendAuthority.threadId
                },
                selectedRef.current
              ) ||
              !durableSendMatchesAuthority(event.send, currentAuthorityKey)
            )
              return true;
            const sendDraftAuthority: DraftAuthority = {
              backendId: sendAuthority.backendId,
              principalUserId: sendAuthority.principalUserId,
              teamId: sendAuthority.teamId,
              threadId: sendAuthority.threadId,
              ...(event.send.rootMessageId
                ? { rootMessageId: event.send.rootMessageId }
                : {})
            };
            const sendDraftKey = JSON.stringify(sendDraftAuthority);
            if (event.send.state === "sent") {
              const message = event.message;
              if (
                !message ||
                message.clientMessageId !== event.send.clientMessageId
              )
                return true;
              void recoverPendingReceipt(
                sendDraftAuthority,
                event.send.clientMessageId
              );
            } else {
              const latest = draftByAuthority.current.get(sendDraftKey);
              if (
                latest?.pendingSend?.clientMessageId ===
                event.send.clientMessageId
              ) {
                if (
                  event.send.state === "failed" &&
                  durableSendFailureDisposition(
                    event.send.failure?.code ?? null
                  ) === "authority_lost"
                ) {
                  clearRevokedView();
                  return true;
                }
                if (event.send.state === "failed") {
                  const settled = resolvePendingSend(
                    latest,
                    event.send.clientMessageId,
                    "not-sent",
                    latest.pendingSend.body
                  );
                  draftByAuthority.current.set(sendDraftKey, settled);
                  if (
                    event.send.rootMessageId &&
                    openRootRef.current?.id === event.send.rootMessageId
                  ) {
                    setThreadDraftText(settled.text);
                    setThreadPendingSend(settled.pendingSend);
                    setThreadSendStatus("retry_failed");
                  } else if (
                    !event.send.rootMessageId &&
                    authorityKeyRef.current === currentAuthorityKey
                  ) {
                    setDraftText(settled.text);
                    setPendingSend(settled.pendingSend);
                  }
                  setStatus(
                    event.send.failure?.userMessage
                      ? `Not sent. ${event.send.failure.userMessage}`
                      : "Message was not sent. Your draft is ready to send again."
                  );
                  void persistDraft(sendDraftAuthority, settled).catch(() => {
                    if (authorityKeyRef.current === currentAuthorityKey)
                      setStatus(
                        "Message was not sent. The updated draft could not be saved on this device."
                      );
                  });
                } else {
                  if (
                    event.send.rootMessageId &&
                    openRootRef.current?.id === event.send.rootMessageId
                  )
                    setThreadSendStatus(
                      durableSendStatus(event.send) ? "pending" : null
                    );
                  setStatus(durableSendStatus(event.send));
                }
              }
            }
          } else if (
            event.type === "connection" &&
            event.connection.state === "access_revoked"
          ) {
            clearRevokedView();
          } else if (
            event.type === "connection" &&
            event.connection.state === "live"
          ) {
            if (selectedRef.current.teamId === teamId) await refreshSquare();
            const currentAuthority = authorityKeyRef.current
              ? (JSON.parse(authorityKeyRef.current) as DraftAuthority)
              : null;
            const currentDraft =
              currentAuthority &&
              draftByAuthority.current.get(JSON.stringify(currentAuthority));
            if (
              currentAuthority?.teamId === teamId &&
              currentDraft?.pendingSend
            ) {
              const recovery = await recoverPendingReceipt(
                currentAuthority,
                currentDraft.pendingSend.clientMessageId
              );
              if (recovery === "error") return false;
            }
          } else if (
            event.type === "control" &&
            event.reason === "access_revoked"
          ) {
            clearRevokedView();
          } else if (
            event.type === "snapshot" ||
            event.type === "control" ||
            event.type === "connection"
          ) {
            if (selectedRef.current.teamId !== teamId) return false;
            const snapshotApplied = await refreshSnapshotRef.current();
            if (!snapshotApplied) return false;
            await refreshSquare();
            const selected = selectedRef.current;
            if (selected.teamId === teamId && selected.threadId)
              return await loadPageRef.current(selected.threadId, teamId);
            return true;
          }
          return true;
        },
        async (next) => {
          if (revokedRef.current || selectedRef.current.teamId !== teamId)
            return;
          if (!next.navigation.teams.some((team) => team.id === teamId)) {
            clearRevokedView();
            return;
          }
          await refreshSquare();
          setSnapshot(next);
          const selected = selectedRef.current;
          if (selected.threadId)
            await loadPageRef.current(selected.threadId, teamId);
        },
        teamId
      );
    })();
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [
    client,
    clearRevokedView,
    completeAcceptedReceipt,
    drafts,
    persistDraft,
    recoverPendingReceipt,
    refreshSquare,
    setStatus,
    snapshot?.connection.backendId,
    snapshot?.navigation.teamPrincipal?.id,
    teamId
  ]);

  useEffect(() => {
    if (!activeThreadId || !authority) return;
    let active = true;
    const key = JSON.stringify(authority);
    const hydrationGeneration = draftAuthorityGenerations.current.get(key) ?? 0;
    const queuedDraftWrite = draftWriteTails.current.get(key);
    void (async () => {
      await queuedDraftWrite?.catch(() => undefined);
      return drafts.loadDraft(authority);
    })()
      .then((stored) => {
        if (!mayCompleteDraftHydration({ active, revoked: revokedRef.current }))
          return;
        if (
          authorityKeyRef.current !== key ||
          (draftAuthorityGenerations.current.get(key) ?? 0) !==
            hydrationGeneration
        )
          return;
        // A fresh, successful load under the current verified Team authority is
        // the only operation that removes this authority's revocation tombstone.
        invalidDraftAuthorities.current.delete(key);
        const hydratedDraft = stored ?? { text: "", pendingSend: null };
        draftByAuthority.current.set(key, hydratedDraft);
        setDraftText(hydratedDraft.text);
        setDraftMentionUserIds(hydratedDraft.mentionUserIds ?? []);
        setPendingSend(hydratedDraft.pendingSend);
        setHydratedAuthorityKey(key);
        void (async () => {
          if (hydratedDraft.receiptAckPending) {
            try {
              await clearSavedReceiptMarker(
                authority,
                hydratedDraft.receiptAckPending
              );
            } catch {
              if (authorityKeyRef.current === key && !revokedRef.current)
                setStatus(
                  "Message sent. Device confirmation is still being saved."
                );
            }
          }
          if (hydratedDraft.pendingSend && !revokedRef.current) {
            try {
              await recoverPendingReceipt(
                authority,
                hydratedDraft.pendingSend.clientMessageId
              );
            } catch {
              if (authorityKeyRef.current === key && !revokedRef.current)
                setStatus(
                  "Send status could not be checked. Your original draft is still available to reconcile."
                );
            }
          }
        })();
      })
      .catch(() => {
        if (
          mayCompleteDraftHydration({ active, revoked: revokedRef.current })
        ) {
          setStatus("Draft recovery is unavailable on this device.");
          setHydratedAuthorityKey(JSON.stringify(authority));
        }
      });
    void loadPageRef.current(activeThreadId, teamId);
    return () => {
      active = false;
    };
  }, [
    activeThreadId,
    authority,
    clearSavedReceiptMarker,
    drafts,
    recoverPendingReceipt,
    teamId
  ]);

  useEffect(() => {
    if (
      !authority ||
      !mayPersistTeamDraft({ authorityKey, hydratedAuthorityKey })
    )
      return;
    const key = authorityKey!;
    const persist = () => {
      if (revokedRef.current) return;
      const latest = draftByAuthority.current.get(key) ?? {
        text: draftText,
        mentionUserIds: draftMentionUserIds,
        pendingSend
      };
      void persistDraft(authority, {
        ...latest,
        updatedAt: new Date().toISOString()
      }).catch(() => {
        if (authorityKeyRef.current === key && !revokedRef.current)
          setStatus("Draft could not be saved on this device.");
      });
    };
    const sequence = ++saveSequence.current;
    const timer = window.setTimeout(() => {
      void persist();
    }, 250);
    return () => {
      window.clearTimeout(timer);
      if (saveSequence.current === sequence) {
        // Navigation and ordinary component teardown must flush the last
        // hydrated text; only run a cleanup write if a debounce was pending.
        void persist();
      }
    };
  }, [
    authority,
    authorityKey,
    hydratedAuthorityKey,
    draftText,
    draftMentionUserIds,
    pendingSend,
    persistDraft
  ]);

  useEffect(() => {
    const focusedVisible =
      document.visibilityState === "visible" && document.hasFocus();
    const visible = visibleRead;
    if (
      !focusedVisible ||
      !activeThread ||
      !visible ||
      !authority ||
      !authorityKey ||
      !messagesMatchSelection ||
      !studioSelectionMatches(
        { teamId: visible.teamId, threadId: visible.threadId },
        selectedRef.current
      ) ||
      readPending.current.get(authorityKey) === visible.sequence ||
      !visibleReadMayAdvance({
        messageId: visible.id,
        sequence: visible.sequence,
        senderId: visible.senderId,
        principalUserId: authority.principalUserId,
        focused: focusedVisible,
        lastReportedSequence: readSequenceFor(
          readReported.current,
          authorityKey
        )
      })
    )
      return;
    const capturedKey = authorityKey;
    const capturedTeamId = visible.teamId;
    const capturedThreadId = visible.threadId;
    readPending.current.set(capturedKey, visible.sequence);
    void run("collaboration.mark_read", {
      thread: {
        scope: "team",
        teamId: capturedTeamId,
        threadId: capturedThreadId
      },
      messageId: visible.id
    })
      .then((result) => {
        if (
          result.ok &&
          readCompletionMayApply(capturedKey, authorityKeyRef.current)
        ) {
          rememberReadSequence(
            readReported.current,
            capturedKey,
            visible.sequence
          );
        }
        if (readPending.current.get(capturedKey) === visible.sequence)
          readPending.current.delete(capturedKey);
      })
      .catch(() => {
        if (readPending.current.get(capturedKey) === visible.sequence)
          readPending.current.delete(capturedKey);
      });
  }, [
    activeThread,
    authority,
    authorityKey,
    messagesMatchSelection,
    run,
    teamId,
    visibleRead
  ]);
  useEffect(() => {
    const update = () => {
      if (document.visibilityState === "visible" && document.hasFocus()) {
        const visible = [
          ...(bodyRef.current?.querySelectorAll<HTMLElement>(
            "[data-message-visible='true']"
          ) ?? [])
        ].sort(
          (left, right) =>
            Number(right.dataset.sequence) - Number(left.dataset.sequence)
        )[0];
        const visibleTeamId = visible?.dataset.teamId;
        const visibleThreadId = visible?.dataset.threadId;
        if (
          visible &&
          visibleTeamId &&
          visibleThreadId &&
          studioSelectionMatches(
            { teamId: visibleTeamId, threadId: visibleThreadId },
            selectedRef.current
          )
        ) {
          setVisibleRead({
            id: visible.dataset.messageId ?? "",
            sequence: Number(visible.dataset.sequence),
            senderId: visible.dataset.senderId ?? "",
            teamId: visibleTeamId,
            threadId: visibleThreadId
          });
        }
      }
    };
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  const selectThread = async (thread: CollaborationThread) => {
    if (!activeTeam) return false;
    const generation = ++threadSelectionGeneration.current;
    const selectedTeamId = activeTeam.id;
    try {
      const result = await run("collaboration.select", {
        selection:
          thread.kind === "team_project_channel"
            ? {
                kind: "team_project_channel",
                teamId: activeTeam.id,
                teamProjectId: thread.teamProjectId,
                threadId: thread.id
              }
            : thread.kind === "dm" || thread.kind === "group_dm"
              ? {
                  kind: "team_direct_message",
                  teamId: activeTeam.id,
                  threadId: thread.id
                }
              : {
                  kind: "team_channel",
                  teamId: activeTeam.id,
                  threadId: thread.id
                },
        navigationIntent: "foreground"
      });
      if (
        generation !== threadSelectionGeneration.current ||
        selectedRef.current.teamId !== selectedTeamId
      )
        return false;
      if (!result.ok) {
        if (result.error.code === "access_revoked") clearRevokedView();
        else setStatus(result.error.userMessage);
        return false;
      }
      selectedRef.current = { teamId: selectedTeamId, threadId: thread.id };
      setVisibleRead(null);
      setThreadId(thread.id);
      return true;
    } catch (failure) {
      if (
        revokedRef.current ||
        generation !== threadSelectionGeneration.current ||
        selectedRef.current.teamId !== selectedTeamId
      )
        return false;
      const described = describeStudioCommandFailure(failure);
      if (described.revoked) clearRevokedView();
      else setStatus(described.message);
      return false;
    }
  };

  const openTeamThreadDestination = async (destination: {
    teamId: string;
    threadId: string;
    rootMessageId: string | null;
  }) => {
    const capturedEpoch = snapshotEpoch.current;
    const stillCurrent = () =>
      !revokedRef.current &&
      snapshotEpoch.current === capturedEpoch &&
      selectedTeamIdRef.current === destination.teamId;
    const thread = threads.find(
      (candidate) => candidate.id === destination.threadId
    );
    if (!thread || !(await selectThread(thread))) return;
    if (!stillCurrent() || activeTeam?.id !== destination.teamId) return;
    const selectedGeneration = threadSelectionGeneration.current;
    setForYouOpen(false);
    setSquareOpen(false);
    if (!destination.rootMessageId) return;
    const root = messages.find(
      (message) => message.id === destination.rootMessageId
    );
    if (root) {
      openMessageThread(root);
      return;
    }
    const loadedRoot = await findStudioNotificationRoot(
      destination.rootMessageId,
      async (direction, cursor) => {
        const result = await run("collaboration.load_message_page", {
          thread: {
            scope: "team",
            teamId: destination.teamId,
            threadId: destination.threadId
          },
          rootMessageId: null,
          direction,
          cursor,
          limit: 50
        });
        if (
          !stillCurrent() ||
          selectedRef.current.teamId !== destination.teamId ||
          selectedRef.current.threadId !== destination.threadId ||
          threadSelectionGeneration.current !== selectedGeneration ||
          !result.ok ||
          !("page" in result.data)
        )
          return null;
        const parsed = collaborationMessagePageSchema.safeParse(
          result.data.page
        );
        return parsed.success ? parsed.data : null;
      }
    );
    if (loadedRoot) openMessageThread(loadedRoot);
  };

  const openAttentionHere = async (item: TeamOverviewItem) => {
    const capturedEpoch = snapshotEpoch.current;
    const capturedSelectionGeneration = threadSelectionGeneration.current;
    const capturedSelectedTeamId = selectedTeamIdRef.current;
    const stillCurrent = () =>
      !revokedRef.current &&
      snapshotEpoch.current === capturedEpoch &&
      selectedTeamIdRef.current === item.teamId;
    const destination = item.destination;
    if (destination.kind === "pull_request_review") {
      router.push(
        `/pull-requests?review=${encodeURIComponent(destination.reviewId)}`
      );
      return;
    }
    if (destination.kind === "team_job") {
      setForYouOpen(false);
      setFocusSquareJobId(destination.jobId);
      setSquareOpen(true);
      return;
    }
    if (destination.kind === "agent_request") {
      const request = await teamAgentRequestsClient.findInboxRequest(
        item.teamId,
        destination.requestId
      );
      if (
        !stillCurrent() ||
        capturedSelectedTeamId !== item.teamId ||
        threadSelectionGeneration.current !== capturedSelectionGeneration
      )
        return;
      if (request) {
        await openRequestReview(request);
        return;
      }
    }
    await openTeamThreadDestination({
      teamId: item.teamId,
      threadId: destination.threadId,
      rootMessageId: destination.rootMessageId ?? null
    });
  };

  const openPendingAttention = useEffectEvent(openAttentionHere);

  const openAttentionItem = async (item: TeamOverviewItem) => {
    if (item.teamId !== activeTeam?.id) {
      pendingAttentionItem.current = item;
      setForYouOpen(false);
      setSquareOpen(false);
      setTeamId(item.teamId);
      return;
    }
    try {
      await openAttentionHere(item);
    } catch (failure) {
      if (
        failure instanceof TeamAgentRequestError &&
        [401, 403].includes(failure.status)
      ) {
        clearRevokedView();
        return;
      }
      setStatus(
        failure instanceof Error
          ? failure.message
          : "Team activity could not be opened."
      );
    }
  };
  const openPendingNotificationDestination = useEffectEvent(
    openTeamThreadDestination
  );

  useEffect(() => {
    const navigation = notificationNavigation;
    if (!navigation || navigation.kind !== "team_thread") return;
    if (handledNotificationMessage.current === navigation.messageId) return;
    if (!snapshot || revokedRef.current) return;
    const destination = findAuthorizedStudioNotificationDestination(
      snapshot,
      navigation
    );
    if (!destination) return;
    handledNotificationMessage.current = navigation.messageId;
    queueMicrotask(() => {
      if (revokedRef.current) return;
      if (destination.teamId !== selectedTeamIdRef.current) {
        pendingNotificationDestination.current = destination;
        setForYouOpen(false);
        setSquareOpen(false);
        setTeamId(destination.teamId);
        return;
      }
      void openPendingNotificationDestination(destination);
    });
  }, [notificationNavigation, snapshot]);

  useEffect(() => {
    const pendingDestination = pendingNotificationDestination.current;
    if (
      pendingDestination &&
      pendingDestination.teamId === activeTeam?.id &&
      threads.some((thread) => thread.id === pendingDestination.threadId)
    ) {
      pendingNotificationDestination.current = null;
      void openPendingNotificationDestination(pendingDestination).catch(
        (failure) =>
          setStatus(
            failure instanceof Error
              ? failure.message
              : "The notification destination could not be opened."
          )
      );
      return;
    }
    const pending = pendingAttentionItem.current;
    if (!pending || pending.teamId !== activeTeam?.id) return;
    pendingAttentionItem.current = null;
    void openPendingAttention(pending).catch((failure) => {
      if (
        failure instanceof TeamAgentRequestError &&
        [401, 403].includes(failure.status)
      )
        clearRevokedView();
      else
        setStatus(
          failure instanceof Error
            ? failure.message
            : "Team activity could not be opened."
        );
    });
  }, [activeTeam?.id, clearRevokedView, messages, threads]);

  const startDirectMessage = async (participantUserIds: string[]) => {
    if (!activeTeam || !snapshot?.navigation.teamPrincipal)
      throw new Error("Team access changed. Refresh to check your access.");
    const selectedTeamId = activeTeam.id;
    const principalId = snapshot.navigation.teamPrincipal.id;
    const principalUserId = snapshot.navigation.teamPrincipal.id;
    const enabledMemberIds = new Set(
      activeTeam.people
        .filter((person) => person.membershipState === "enabled")
        .map((person) => person.id)
    );
    const participants = participantUserIds.slice().sort();
    if (
      !directMessageParticipantsAreEligible({
        principalUserId,
        participantUserIds: participants,
        enabledMemberIds
      })
    )
      throw new Error("Choose an enabled teammate to message.");
    const key = directMessageAttemptKey(
      activeTeam.id,
      principalUserId,
      participants
    );
    const requestId =
      directMessageRequestIds.current.get(key) ?? crypto.randomUUID();
    directMessageRequestIds.current.set(key, requestId);
    const result =
      participants.length === 1
        ? await run(
            "collaboration.start_direct_message",
            { teamId: activeTeam.id, participantUserId: participants[0] },
            requestId
          )
        : await run(
            "collaboration.start_group_direct_message",
            { teamId: activeTeam.id, participantUserIds: participants },
            requestId
          );
    if (
      revokedRef.current ||
      selectedRef.current.teamId !== selectedTeamId ||
      snapshot?.navigation.teamPrincipal?.id !== principalId
    )
      throw new Error("Team access changed. Refresh to check your access.");
    if (!result.ok) {
      if (!result.error.retryable) directMessageRequestIds.current.delete(key);
      if (result.error.code === "access_revoked") clearRevokedView();
      throw new Error(result.error.userMessage);
    }
    if (!("thread" in result.data)) {
      throw new Error("Koed returned an invalid direct message.");
    }
    const createdThread = result.data.thread;
    if (createdThread.kind !== "dm" && createdThread.kind !== "group_dm") {
      throw new Error("Koed returned an invalid direct message.");
    }
    if (
      !directMessageThreadMatchesRequest({
        requestedTeamId: selectedTeamId,
        principalUserId,
        participantUserIds: participants,
        thread: createdThread
      })
    ) {
      throw new Error("Koed returned an invalid direct message.");
    }
    directMessageRequestIds.current.delete(key);
    setSnapshot(
      (current) =>
        current && {
          ...current,
          navigation: {
            ...current.navigation,
            teams: current.navigation.teams.map((team) =>
              team.id === activeTeam.id
                ? {
                    ...team,
                    directMessages: [
                      ...team.directMessages.filter(
                        (item) => item.id !== createdThread.id
                      ),
                      createdThread
                    ]
                  }
                : team
            )
          }
        }
    );
    if (!(await selectThread(createdThread)))
      throw new Error(
        "The direct message was created, but it could not be opened. Refresh to check your access."
      );
  };

  const waitForSendReceipt = async (
    draftAuthority: DraftAuthority,
    clientMessageId: string
  ): Promise<boolean> => {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let recovered:
        | "recovered"
        | "missing"
        | "error"
        | typeof receiptWaitExpired;
      try {
        recovered = await Promise.race([
          recoverPendingReceipt(draftAuthority, clientMessageId),
          new Promise<typeof receiptWaitExpired>((resolve) => {
            timeout = setTimeout(() => resolve(receiptWaitExpired), remaining);
          })
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      if (recovered === receiptWaitExpired) break;
      if (recovered === "recovered") return true;
      if (recovered === "error") return false;
      const pause = Math.min(300, deadline - Date.now());
      if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
    }
    if (authorityKeyRef.current === JSON.stringify(draftAuthority))
      setStatus(
        "The channel message is saved and delivery is still being confirmed. Keep this handoff open; it will not resend the message."
      );
    return false;
  };

  const send = async (
    body: string,
    options: {
      awaitReceipt?: boolean;
      clientMessageId?: string;
      mentionUserIds?: string[];
    } = {}
  ) => {
    const key = authorityKey;
    if (!key) return false;
    if (sendLocks.current.has(key)) {
      setStatus("A send is already being confirmed for this conversation.");
      throw new Error(
        "A send is already being confirmed for this conversation."
      );
    }
    sendLocks.current.add(key);
    try {
      return await sendMessage(body, key, options);
    } finally {
      sendLocks.current.delete(key);
    }
  };

  const sendMessage = async (
    body: string,
    lockedAuthorityKey: string,
    options: {
      awaitReceipt?: boolean;
      clientMessageId?: string;
      mentionUserIds?: string[];
    } = {}
  ): Promise<boolean> => {
    if (!activeThread || !authority) return false;
    const capturedAuthority = authority;
    const capturedKey = authorityKey;
    if (capturedKey !== lockedAuthorityKey) return false;
    const capturedTeamId = teamId;
    const capturedThreadId = activeThread.id;
    if (!capturedKey) return false;
    const existingPending =
      draftByAuthority.current.get(capturedKey)?.pendingSend ?? pendingSend;
    if (
      options.awaitReceipt &&
      options.clientMessageId &&
      existingPending?.clientMessageId === options.clientMessageId &&
      existingPending.body === body
    )
      return await waitForSendReceipt(
        capturedAuthority,
        options.clientMessageId
      );
    if (existingPending) {
      setStatus("Resolve the earlier send before sending edited text.");
      return false;
    }
    const draftBeforePreflight =
      draftByAuthority.current.get(capturedKey)?.text ?? draftText;
    const unacknowledgedReceipt =
      draftByAuthority.current.get(capturedKey)?.receiptAckPending;
    if (unacknowledgedReceipt) {
      try {
        await clearSavedReceiptMarker(capturedAuthority, unacknowledgedReceipt);
      } catch {
        setStatus(
          "Confirm the previous sent message on this device before sending another."
        );
        throw new Error(
          "The previous sent message is still being confirmed on this device."
        );
      }
      if (revokedRef.current || authorityKeyRef.current !== capturedKey)
        return false;
    }
    const latestText =
      draftByAuthority.current.get(capturedKey)?.text ?? draftBeforePreflight;
    const nextDraftText = draftTextAfterSendPreflight({
      textBeforePreflight: draftBeforePreflight,
      latestText
    });
    const nextPending = {
      clientMessageId: options.clientMessageId ?? crypto.randomUUID(),
      body,
      createdAt: new Date().toISOString(),
      ...(options.mentionUserIds
        ? { mentionUserIds: options.mentionUserIds }
        : {})
    };
    draftByAuthority.current.set(capturedKey, {
      ...draftByAuthority.current.get(capturedKey),
      text: nextDraftText,
      mentionUserIds: options.mentionUserIds ?? [],
      pendingSend: nextPending
    });
    setPendingSend(nextPending);
    setDraftText(nextDraftText);
    setDraftMentionUserIds([]);
    let requestStarted = false;
    try {
      await persistDraft(
        capturedAuthority,
        draftByAuthority.current.get(capturedKey)!
      );
      if (revokedRef.current) return false;
      requestStarted = true;
      const result = await run("collaboration.send_message", {
        thread: {
          scope: "team",
          teamId: capturedTeamId,
          threadId: capturedThreadId
        },
        clientMessageId: nextPending.clientMessageId,
        body,
        ...(nextPending.mentionUserIds?.length
          ? { mentionUserIds: nextPending.mentionUserIds }
          : {})
      });
      if (revokedRef.current) return false;
      const acceptedReceipt =
        result.ok && "message" in result.data
          ? {
              message: result.data.message,
              acceptedBody:
                "acceptedBody" in result.data &&
                typeof result.data.acceptedBody === "string"
                  ? result.data.acceptedBody
                  : result.data.message.body
            }
          : null;
      const sentMessage = acceptedReceipt?.message ?? null;
      const currentlySelected = studioSelectionMatches(
        { teamId: capturedTeamId, threadId: capturedThreadId },
        selectedRef.current
      );
      if (sentMessage) {
        if (currentlySelected)
          setMessages((current) => [
            ...current.filter((item) => item.id !== sentMessage.id),
            sentMessage
          ]);
        if (
          sentMessage.clientMessageId === nextPending.clientMessageId &&
          sentMessage.delivery === "sent"
        ) {
          await completeAcceptedReceipt(capturedAuthority, {
            thread: {
              scope: "team",
              teamId: capturedTeamId,
              threadId: capturedThreadId
            },
            clientMessageId: nextPending.clientMessageId,
            message: sentMessage,
            acceptedBody: acceptedReceipt!.acceptedBody
          });
        }
      } else if (result.ok && "durableSend" in result.data) {
        const durableSend = result.data.durableSend;
        const currentPending =
          draftByAuthority.current.get(capturedKey)?.pendingSend;
        if (
          currentlySelected &&
          authorityKey === capturedKey &&
          durableSend.clientMessageId === nextPending.clientMessageId &&
          currentPending?.clientMessageId === nextPending.clientMessageId &&
          durableSendMatchesAuthority(durableSend, capturedKey)
        ) {
          setStatus(durableSendStatus(durableSend));
        }
      } else if (!result.ok && result.error.code === "access_revoked") {
        clearRevokedView();
      } else if (!result.ok && result.error.retryable) {
        const latest = draftByAuthority.current.get(capturedKey) ?? {
          text: "",
          pendingSend: nextPending
        };
        const retained = retainPendingSendAfterUncertainOutcome(
          latest,
          nextPending
        );
        draftByAuthority.current.set(capturedKey, retained);
        await persistDraft(capturedAuthority, retained).catch(() => undefined);
        if (currentlySelected && authorityKey === capturedKey) {
          setDraftText(retained.text);
          setDraftMentionUserIds(
            retained.mentionUserIds ?? nextPending.mentionUserIds ?? []
          );
          setPendingSend(retained.pendingSend);
          setStatus(
            "Send status is unknown. Resolve the original send before retrying."
          );
        }
      } else {
        const latest = draftByAuthority.current.get(capturedKey) ?? {
          text: "",
          pendingSend: nextPending
        };
        const settled = resolvePendingSend(
          latest,
          nextPending.clientMessageId,
          "not-sent",
          body
        );
        draftByAuthority.current.set(capturedKey, settled);
        await persistDraft(capturedAuthority, settled);
        if (currentlySelected && authorityKey === capturedKey) {
          setDraftText(settled.text);
          setDraftMentionUserIds(settled.mentionUserIds ?? []);
          setPendingSend(settled.pendingSend);
          setStatus(
            "Not sent. Your draft is saved on this device; retry when connected."
          );
        }
      }
      if (sentMessage?.delivery === "sent") return true;
      if (options.awaitReceipt && options.clientMessageId)
        return await waitForSendReceipt(
          capturedAuthority,
          options.clientMessageId
        );
      return false;
    } catch (failure) {
      if (revokedRef.current) return false;
      const latest = draftByAuthority.current.get(capturedKey) ?? {
        text: "",
        pendingSend: nextPending
      };
      const settled = requestStarted
        ? retainPendingSendAfterUncertainOutcome(latest, nextPending)
        : resolvePendingSend(
            latest,
            nextPending.clientMessageId,
            "not-sent",
            body
          );
      draftByAuthority.current.set(capturedKey, settled);
      await persistDraft(capturedAuthority, settled).catch(() => undefined);
      if (
        studioSelectionMatches(
          { teamId: capturedTeamId, threadId: capturedThreadId },
          selectedRef.current
        ) &&
        authorityKey === capturedKey
      ) {
        setDraftText(settled.text);
        setDraftMentionUserIds(
          settled.mentionUserIds ?? nextPending.mentionUserIds ?? []
        );
        setPendingSend(settled.pendingSend);
        setStatus(
          requestStarted
            ? "Send status is unknown. Resolve the original send before retrying."
            : failure instanceof Error
              ? failure.message
              : "Not sent. Your draft is saved on this device."
        );
      }
      return false;
    }
  };

  const completeAgentMention = async (
    intent: NonNullable<typeof pendingAgentMention>,
    teamProjectId: string
  ): Promise<boolean> => {
    if (!activeTeam || !snapshot?.navigation.teamPrincipal) return false;
    if (
      intent.rootMessageId &&
      openRootRef.current?.id !== intent.rootMessageId
    ) {
      setStatus(
        "This Agent request belongs to a different message thread. Reopen that thread to continue."
      );
      return false;
    }
    const capturedTeamId = activeTeam.id;
    const capturedThreadId = activeThread?.id;
    setAgentMentionBusy(true);
    setStatus(null);
    try {
      if (intent.agent.kind === "colleague") {
        if (intent.mentionUserIds.length > 0) {
          setStatus(
            "Remove human mentions before sending a request to another Agent."
          );
          return false;
        }
        await teamAgentRequestsClient.createRequest(capturedTeamId, {
          idempotencyKey: intent.idempotencyKey,
          teamProjectId,
          channelId: capturedThreadId ?? "",
          agentId: intent.agent.id,
          requestText: intent.text,
          rootMessageId: intent.rootMessageId ?? null
        });
        setAgentRequestRevision((revision) => revision + 1);
        setStatus("Request sent to the Agent owner for private review.");
        setPendingAgentMention(null);
        setTeamMentionSelection((selection) =>
          selection?.scopeKey === teamMentionScopeKey
            ? { ...selection, agentId: null }
            : selection
        );
        return true;
      }
      const connection = await publicSquareClient.getConnection(
        capturedTeamId,
        teamProjectId
      );
      if (
        intent.rootMessageId &&
        openRootRef.current?.id !== intent.rootMessageId
      )
        return false;
      if (connection.localProjectId === null) {
        setStatus(
          "Connect this Team Project to a local Project in Public Square before opening your Agent."
        );
        return false;
      }
      if (!capturedThreadId) return false;
      const sent = intent.rootMessageId
        ? await sendThreadReply(
            intent.text,
            intent.sendClientMessageId,
            intent.mentionUserIds
          )
        : await send(intent.text, {
            awaitReceipt: true,
            clientMessageId: intent.sendClientMessageId,
            mentionUserIds: intent.mentionUserIds
          });
      if (!sent) return false;
      if (
        selectedRef.current.teamId !== capturedTeamId ||
        selectedRef.current.threadId !== capturedThreadId ||
        activeThread?.id !== capturedThreadId ||
        activeTeam.id !== capturedTeamId
      )
        return false;
      router.push(
        privateAgentHandoffHref({
          agentId: intent.agent.id,
          localProjectId: connection.localProjectId,
          teamId: capturedTeamId,
          draft: buildOwnedAgentHandoffDraft({
            agentName: intent.agent.name,
            channelName: activeThread?.name ?? "channel",
            typedMessage: intent.text,
            recentMessages: (intent.rootMessageId
              ? [openRootMessage, ...threadReplies]
              : visibleMessages
            )
              .filter((message): message is CollaborationMessage =>
                Boolean(message)
              )
              .map((message) => ({
                senderName: message.sender.displayName,
                body: message.body,
                delivery: message.delivery
              }))
          })
        })
      );
      setPendingAgentMention(null);
      setTeamMentionSelection((selection) =>
        selection?.scopeKey === teamMentionScopeKey
          ? { ...selection, agentId: null }
          : selection
      );
      return true;
    } catch (failure) {
      setStatus(
        failure instanceof Error
          ? failure.message
          : "The Agent request could not be completed."
      );
      return false;
    } finally {
      setAgentMentionBusy(false);
    }
  };

  const sendTeamComposer = async (
    text: string,
    selection: ChatComposerSelection
  ) => {
    if (!selection.agentId || !activeTeam || activeDirectMessage) {
      if (
        await send(text, { mentionUserIds: selection.mentionUserIds ?? [] })
      ) {
        setTeamMentionSelection((current) =>
          current?.scopeKey === teamMentionScopeKey
            ? { ...current, agentId: null }
            : current
        );
      }
      return;
    }
    const agent = teamAgentMentions.options.find(
      (candidate) => candidate.id === selection.agentId
    );
    if (!agent) {
      setStatus(
        "This Agent is no longer available. Refresh Team Agents and try again."
      );
      return;
    }
    const intent = {
      agent,
      text,
      idempotencyKey: crypto.randomUUID(),
      sendClientMessageId: crypto.randomUUID(),
      mentionUserIds: selection.mentionUserIds ?? []
    };
    if (activeThread?.kind === "team_project_channel") {
      await completeAgentMention(intent, activeThread.teamProjectId);
    } else {
      if (activeTeam.sharedProjects.length === 0) {
        setStatus("Share a Team Project before requesting an Agent.");
        return;
      }
      setPendingAgentMention(intent);
      setStatus("Choose the Team Project for this Agent request.");
    }
  };

  const reconcilePendingSend = async () => {
    if (!pendingSend || !activeThread || !authority) return;
    const original = pendingSend;
    const capturedAuthority = authority;
    const capturedKey = authorityKey;
    const capturedTeamId = teamId;
    const capturedThreadId = activeThread.id;
    const receiptResult = await recoverPendingReceipt(
      capturedAuthority,
      original.clientMessageId
    ).catch(() => "error" as const);
    if (receiptResult !== "missing") return;
    if (revokedRef.current || authorityKeyRef.current !== capturedKey) return;
    const result = await run("collaboration.retry_message", {
      thread: {
        scope: "team",
        teamId: capturedTeamId,
        threadId: capturedThreadId
      },
      clientMessageId: original.clientMessageId,
      body: original.body,
      ...(original.mentionUserIds?.length
        ? { mentionUserIds: original.mentionUserIds }
        : {})
    });
    if (revokedRef.current) return;
    const message =
      result.ok && "message" in result.data ? result.data.message : null;
    if (message) {
      const currentlySelected = studioSelectionMatches(
        { teamId: capturedTeamId, threadId: capturedThreadId },
        selectedRef.current
      );
      if (currentlySelected)
        setMessages((current) => [
          ...current.filter((item) => item.id !== message.id),
          message
        ]);
      const latest = draftByAuthority.current.get(capturedKey!) ?? {
        text: draftText,
        pendingSend: original
      };
      const settled = resolvePendingSend(
        latest,
        original.clientMessageId,
        "accepted",
        original.body
      );
      draftByAuthority.current.set(capturedKey!, settled);
      try {
        await persistDraft(capturedAuthority, settled);
      } catch {
        if (currentlySelected && authorityKey === capturedKey)
          setStatus(
            "Message sent. The edited draft update could not be saved on this device."
          );
        return false;
      }
      if (currentlySelected && authorityKey === capturedKey) {
        setDraftText(settled.text);
        setPendingSend(settled.pendingSend);
        setStatus(null);
      }
      return;
    }
    if (
      studioSelectionMatches(
        { teamId: capturedTeamId, threadId: capturedThreadId },
        selectedRef.current
      ) &&
      authorityKey === capturedKey
    ) {
      setStatus(
        result.ok
          ? "Send is still being reconciled. Keep this draft and try again."
          : result.error.userMessage
      );
    }
  };

  const onMessageVisibility = useCallback(
    (message: CollaborationMessage, visible: boolean) => {
      if (
        !visible ||
        !authority ||
        !message.teamId ||
        !studioSelectionMatches(
          { teamId: message.teamId, threadId: message.threadId },
          selectedRef.current
        ) ||
        !visibleReadMayAdvance({
          messageId: message.id,
          sequence: message.sequence,
          senderId: message.sender.id,
          principalUserId: authority.principalUserId,
          focused:
            document.visibilityState === "visible" && document.hasFocus(),
          lastReportedSequence: -1
        })
      )
        return;
      setVisibleRead((current) =>
        !current || message.sequence > current.sequence
          ? {
              id: message.id,
              sequence: message.sequence,
              senderId: message.sender.id,
              teamId: message.teamId!,
              threadId: message.threadId
            }
          : current
      );
    },
    [authority]
  );
  const changeDraftText = (text: string) => {
    const callbackAuthorityKey = authorityKey;
    if (!callbackAuthorityKey) return;
    const latest = draftByAuthority.current.get(callbackAuthorityKey) ?? {
      text: draftText,
      mentionUserIds: draftMentionUserIds,
      pendingSend
    };
    const updated = teamDraftAfterTextChange({
      callbackAuthorityKey,
      currentAuthorityKey: authorityKeyRef.current,
      hydratedAuthorityKey,
      latest,
      text
    });
    if (!updated) return;
    draftByAuthority.current.set(callbackAuthorityKey, updated);
    setDraftText(text);
  };
  const changeDraftMentionUserIds = (userIds: string[]) => {
    const key = authorityKey;
    if (!key || !authority) return;
    setDraftMentionUserIds(userIds);
    const current = draftByAuthority.current.get(key) ?? {
      text: draftText,
      pendingSend,
      mentionUserIds: draftMentionUserIds
    };
    const next = { ...current, mentionUserIds: userIds };
    draftByAuthority.current.set(key, next);
    void persistDraft(authority, next).catch(() => {
      if (authorityKeyRef.current === key && !revokedRef.current)
        setStatus("Draft could not be saved on this device.");
    });
  };
  const changeThreadMentionUserIds = (userIds: string[]) => {
    const root = visibleOpenRoot;
    if (!authority || !root) return;
    setThreadMentionUserIds(userIds);
    const key = JSON.stringify({ ...authority, rootMessageId: root.id });
    const current = draftByAuthority.current.get(key);
    saveReplyDraft(root.id, current?.text ?? threadDraftText, userIds);
  };

  const createChannel = async (name: string) => {
    const result = await run("collaboration.create_team_channel", {
      teamId,
      name,
      topic: null
    });
    if (revokedRef.current) return false;
    const candidateThread =
      result.ok && "thread" in result.data ? result.data.thread : null;
    if (candidateThread?.kind === "team_channel") {
      const createdThread = candidateThread;
      setSnapshot(
        (current) =>
          current && {
            ...current,
            navigation: {
              ...current.navigation,
              teams: current.navigation.teams.map((team) =>
                team.id === teamId
                  ? { ...team, channels: [...team.channels, createdThread] }
                  : team
              )
            }
          }
      );
      setCreateChannelOpen(false);
      await selectThread(createdThread);
    } else if (!result.ok) setChannelError(result.error.userMessage);
  };

  const createProject = async (project: {
    name: string;
    selectionId?: string;
  }) => {
    if (!project.selectionId)
      throw new Error(
        "Choose a local folder before creating this Shared Project."
      );
    const selectionId = project.selectionId;
    const priorAttempt = projectRequestIds.current.get(selectionId);
    if (priorAttempt && priorAttempt.name !== project.name) {
      throw new Error(
        "This folder already has an unresolved Shared Project request. Retry with the original name, or choose a folder to begin a new attempt."
      );
    }
    const requestId = priorAttempt?.requestId ?? crypto.randomUUID();
    projectRequestIds.current.set(selectionId, {
      requestId,
      name: project.name
    });
    let registration = localProjectRegistrations.current.get(selectionId);
    if (!registration) {
      registration = registerLocalProject({ name: project.name, selectionId });
      localProjectRegistrations.current.set(selectionId, registration);
      void registration.catch(() => {
        if (localProjectRegistrations.current.get(selectionId) === registration)
          localProjectRegistrations.current.delete(selectionId);
      });
    }
    const localProject = await registration;
    setLocalProjectsState((current) => {
      const available =
        current.owner === localProjectsOwner ? current.projects : [];
      const projects = available.some((item) => item.id === localProject.id)
        ? available.map((item) =>
            item.id === localProject.id
              ? { id: localProject.id, name: localProject.name }
              : item
          )
        : [...available, { id: localProject.id, name: localProject.name }];
      return { owner: localProjectsOwner, loaded: true, projects };
    });
    if (revokedRef.current) return;
    const result = await run(
      "collaboration.create_team_shared_project",
      { teamId, name: project.name, localProjectId: localProject.id },
      requestId
    );
    if (revokedRef.current) return;
    const createdProject =
      result.ok && "project" in result.data ? result.data.project : null;
    const candidateThread =
      result.ok && "thread" in result.data ? result.data.thread : null;
    if (!createdProject || candidateThread?.kind !== "team_project_channel") {
      throw new Error(
        !result.ok
          ? result.error.userMessage
          : "Koed returned an invalid Shared Project."
      );
    }
    const createdThread = candidateThread;
    if (revokedRef.current) return;
    projectRequestIds.current.delete(selectionId);
    localProjectRegistrations.current.delete(selectionId);
    setSnapshot(
      (current) =>
        current && {
          ...current,
          navigation: {
            ...current.navigation,
            teams: current.navigation.teams.map((team) =>
              team.id === teamId
                ? {
                    ...team,
                    sharedProjects: [
                      ...team.sharedProjects,
                      { ...createdProject, thread: createdThread }
                    ]
                  }
                : team
            )
          }
        }
    );
    setCreateProjectOpen(false);
    await selectThread(createdThread);
  };

  const loadOlder = () => {
    if (!activeThread || !visiblePage?.hasOlder || !visiblePage.olderCursor)
      return;
    void loadPage(activeThread.id, teamId, visiblePage.olderCursor);
  };

  if (!snapshot || !activeTeam)
    return (
      <div className="flex h-full min-h-0 w-full bg-background text-foreground">
        <nav
          aria-label="Workspace navigation"
          className="flex h-full w-[72px] shrink-0 flex-col items-center border-r border-border bg-sidebar py-4 pt-10"
        >
          <Link
            href="/"
            aria-label="Personal Workspace"
            title="Personal Workspace"
            className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-surface-hover text-foreground"
          >
            <User className="h-5 w-5" />
          </Link>
          <div className="mt-auto">
            <Link
              href="/settings"
              aria-label="Settings"
              title="Settings"
              className="flex h-10 w-10 items-center justify-center rounded-xl text-muted hover:bg-surface-hover"
            >
              <Settings className="h-5 w-5" />
            </Link>
          </div>
        </nav>
        <div className="flex flex-1 items-center justify-center text-sm text-muted">
          <div className="text-center">
            {status ?? "No Team access is available."}
            <button
              type="button"
              onClick={onRefresh}
              className="ml-3 underline"
            >
              Refresh
            </button>
          </div>
        </div>
      </div>
    );
  return (
    <div className="flex h-full min-h-0 w-full bg-background text-foreground">
      <SidebarProvider>
        <aside className="flex min-h-0 w-[72px] shrink-0 flex-col items-center overflow-y-auto border-r border-border bg-sidebar py-4 pt-10">
          <Link
            href="/"
            aria-label="Personal Workspace"
            title="Personal Workspace"
            className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-surface-hover text-foreground transition-colors hover:bg-surface-active"
          >
            <User className="h-5 w-5" />
          </Link>
          <div className="my-2 h-px w-8 bg-surface-hover" />
          {snapshot.navigation.teams.map((team, index) => (
            <button
              key={team.id}
              type="button"
              aria-label={team.name}
              aria-current={team.id === teamId ? "page" : undefined}
              title={team.name}
              onClick={() => {
                threadSelectionGeneration.current += 1;
                setSquareOpen(false);
                setForYouOpen(false);
                setTeamId(team.id);
                const next = snapshot.navigation.teams.find(
                  (item) => item.id === team.id
                );
                const initialThreadId =
                  next?.channels.find((thread) => thread.name === "general")
                    ?.id ??
                  next?.channels[0]?.id ??
                  next?.sharedProjects[0]?.thread.id ??
                  "";
                selectedRef.current = {
                  teamId: team.id,
                  threadId: initialThreadId
                };
                setVisibleRead(null);
                setThreadId(initialThreadId);
              }}
              className={`mb-3 flex h-10 w-10 items-center justify-center rounded-xl border text-sm font-semibold ${team.id === teamId ? "border-accent/50 bg-surface-hover text-foreground ring-2 ring-accent" : "border-border bg-surface text-muted hover:bg-surface-hover"}`}
            >
              {team.name.slice(0, 1).toUpperCase() || index + 1}
            </button>
          ))}
          <Link
            href="/settings"
            aria-label="Settings"
            title="Settings"
            className="mt-auto flex h-10 w-10 items-center justify-center rounded-xl text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
          >
            <Settings className="h-5 w-5" />
          </Link>
        </aside>
        <TeamChannelNavigation
          teamName={activeTeam.name}
          channels={threads
            .filter(
              (thread) => thread.kind !== "dm" && thread.kind !== "group_dm"
            )
            .map((thread) => ({ id: thread.id, name: thread.name }))}
          people={activeTeam.people
            .filter((person) => person.membershipState === "enabled")
            .map((person) => ({ id: person.id, name: person.displayName }))}
          principalUserId={snapshot.navigation.teamPrincipal?.id ?? ""}
          directMessages={activeTeam.directMessages}
          forYouBadgeCount={teamOverview.snapshot?.badgeCount ?? 0}
          selectedId={
            forYouOpen ? "for-you" : squareOpen ? "public-square" : threadId
          }
          forYouSelected={forYouOpen}
          onOpenForYou={() => {
            setSquareOpen(false);
            setForYouOpen(true);
          }}
          squareSelected={squareOpen}
          onOpenSquare={() => {
            setForYouOpen(false);
            setSquareOpen(true);
          }}
          onSelect={(id) => {
            setForYouOpen(false);
            setSquareOpen(false);
            const thread = threads.find((item) => item.id === id);
            if (thread) void selectThread(thread);
          }}
          onCreate={() => {
            setChannelError(null);
            setCreateChannelOpen(true);
          }}
          onNewDirectMessage={startDirectMessage}
        />
        <section className="relative flex min-w-0 flex-1 flex-col">
          <TeamShell
            chatLayout={!forYouOpen && !squareOpen}
            heading={
              forYouOpen ? "For you" : squareOpen ? "Public Square" : undefined
            }
            wallpaper={!forYouOpen && (squareOpen || !activeDirectMessage)}
            crumbs={
              !forYouOpen && !squareOpen && activeDirectMessage
                ? [activeTeam.name, activeDirectMessageTitle]
                : undefined
            }
            subheader={
              !forYouOpen && !squareOpen && !activeDirectMessage ? (
                <ChannelHeader
                  channelName={activeThread?.name ?? "Select a channel"}
                  project={null}
                  agents={[]}
                  members={activeTeam.people.map((person) => ({
                    id: person.id,
                    name: person.displayName
                  }))}
                />
              ) : undefined
            }
          >
            {forYouOpen ? (
              <TeamAttentionView
                state={teamOverview.state}
                snapshot={teamOverview.snapshot}
                refreshing={teamOverview.refreshing}
                mutationError={teamOverview.mutationError}
                pendingItemIds={teamOverview.pendingItemIds}
                selectedTeamId={overviewTeamFilter}
                onTeamChange={setOverviewTeamFilter}
                onRefresh={teamOverview.refresh}
                onOpen={(item) => void openAttentionItem(item)}
                onClear={(item, cleared) =>
                  void teamOverview.setCleared(item, cleared)
                }
                onSeen={(item) => teamOverview.setSeen(item)}
                onLoadMore={teamOverview.loadMore}
              />
            ) : squareOpen ? (
              <PublicSquare
                viewerId={snapshot.navigation.teamPrincipal?.id ?? ""}
                onOpenInbox={() => {
                  setSquareOpen(false);
                  setForYouOpen(true);
                }}
                onOpenOwnerConversation={(item) => {
                  if (
                    item.ownerId !== snapshot.navigation.teamPrincipal?.id ||
                    !item.ownerExecutionId ||
                    item.ownerLeftTeam
                  )
                    return;
                  const query = new URLSearchParams({
                    chat: "1",
                    execution: item.ownerExecutionId
                  });
                  router.push(`/?${query.toString()}`);
                }}
                key={`${snapshot.connection.backendId}:${snapshot.navigation.teamPrincipal?.id ?? ""}:${teamId}`}
                teamName={activeTeam.name}
                teamId={teamId}
                focusJobId={focusSquareJobId}
                authorityKey={`${snapshot.connection.backendId}:${snapshot.navigation.teamPrincipal?.id ?? ""}:${teamId}`}
                agentOfferRevision={agentOfferRevision}
                agentRequestsClient={teamAgentRequestsClient}
                items={square.items}
                idleAgents={square.idleAgents}
                refreshing={square.refreshing}
                projects={square.projects}
                localProjects={square.localProjects}
                loadingLocalProjects={loadingLocalProjects}
                ownerBriefDrafts={square.ownerBriefDrafts}
                connections={square.connections}
                state={square.state}
                error={square.error}
                serverTime={square.serverTime}
                hasMore={Boolean(square.nextCursor)}
                loadingMore={square.loadingMore}
                onRetry={() => {
                  void square.refresh();
                }}
                onLoadMore={() => {
                  void square.loadMore();
                }}
                onShareBrief={(id, brief, version) =>
                  square.setBrief(id, brief, version)
                }
                onWithdrawBrief={(id, version) =>
                  square.setBrief(id, null, version)
                }
                onRemoveRetainedBrief={(id, version) =>
                  square.setBrief(id, null, version)
                }
                onRequestBriefDraft={square.loadBriefDraft}
                onConnectProject={square.connectProject}
                canUnshareProjects={
                  activeTeam.role === "owner" || activeTeam.role === "admin"
                }
                onUnshareProject={square.unshareProject}
              />
            ) : (
              <>
                <div className="flex min-h-0 min-w-0 flex-1">
                  <div ref={bodyRef} className="min-h-0 min-w-0 flex-1">
                    <SharedChatUI
                      mode={{ kind: "human", controls: "formatting" }}
                      scopeKey={`team:${authorityKey ?? "unselected"}`}
                      messages={sharedChannelMessages}
                      className="h-full"
                      viewportClassName="pt-4"
                      listClassName={`mx-auto min-w-0 max-w-3xl space-y-4 ${activeDirectMessage ? "" : "space-y-3"}`}
                      emptyState={
                        visibleMessages.length === 0 && !loading ? (
                          <p className="mx-auto max-w-3xl pt-8 text-sm text-subtle">
                            {activeDirectMessage
                              ? `Private to ${activeDirectMessageTitle}. Agents are not in this thread.`
                              : "No messages yet. Start the conversation."}
                          </p>
                        ) : null
                      }
                      composer={
                        <footer className="border-t border-border bg-background p-4">
                          <div className="mx-auto max-w-3xl no-drag">
                            {visiblePendingSend && (
                              <div className="mb-2 flex items-center justify-between rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-muted">
                                <span>
                                  Previous send may have been accepted. Resolve
                                  it before retrying.
                                </span>
                                <button
                                  type="button"
                                  onClick={() => void reconcilePendingSend()}
                                  className="font-medium text-foreground hover:underline"
                                >
                                  Reconcile send
                                </button>
                              </div>
                            )}
                            {pendingAgentMention && (
                              <div className="mb-2 rounded-lg border border-border bg-surface px-3 py-2">
                                <p className="mb-2 text-xs text-subtle">
                                  Choose a Team Project for{" "}
                                  {pendingAgentMention.agent.name}.
                                </p>
                                <div className="flex flex-wrap gap-2">
                                  {activeTeam.sharedProjects.map((project) => (
                                    <button
                                      key={project.id}
                                      type="button"
                                      disabled={agentMentionBusy}
                                      onClick={() =>
                                        void completeAgentMention(
                                          pendingAgentMention,
                                          project.id
                                        )
                                      }
                                      className="rounded-md border border-border px-2.5 py-1.5 text-xs text-foreground hover:bg-surface-hover disabled:opacity-50"
                                    >
                                      {project.name}
                                    </button>
                                  ))}
                                  <button
                                    type="button"
                                    disabled={agentMentionBusy}
                                    onClick={() => setPendingAgentMention(null)}
                                    className="rounded-md px-2.5 py-1.5 text-xs text-subtle hover:bg-surface-hover"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            )}
                            <fieldset
                              disabled={
                                !activeThread ||
                                hydratedAuthorityKey !== authorityKey
                              }
                              className="m-0 min-w-0 border-0 p-0"
                            >
                              <ChatComposer
                                placeholder={
                                  activeDirectMessage
                                    ? `Message ${activeDirectMessageTitle}`
                                    : `Message #${activeThread?.name ?? "channel"}`
                                }
                                projectName={
                                  activeDirectMessage
                                    ? activeTeam.name
                                    : (activeThread?.name ?? "Team")
                                }
                                branch="shared"
                                value={visibleDraftText}
                                onChange={changeDraftText}
                                initialMentionUserIds={draftMentionUserIds}
                                onMentionUserIdsChange={
                                  changeDraftMentionUserIds
                                }
                                onSend={(text, selection) =>
                                  sendTeamComposer(text, selection)
                                }
                                agents={
                                  activeDirectMessage
                                    ? []
                                    : teamAgentMentions.options
                                }
                                teamMembers={
                                  activeDirectMessage
                                    ? []
                                    : activeTeam.people
                                        .filter(
                                          (person) =>
                                            person.membershipState === "enabled"
                                        )
                                        .map((person) => ({
                                          id: person.id,
                                          name: person.displayName
                                        }))
                                }
                                activeAgentId={activeMentionAgentId}
                                onActiveAgentChange={(agentId) =>
                                  setTeamMentionSelection({
                                    scopeKey: teamMentionScopeKey,
                                    agentId
                                  })
                                }
                                showExecutionControls={false}
                                switchToExecutionControlsOnMention={
                                  !activeDirectMessage
                                }
                                showMetaBar={false}
                                showFormattingToolbar
                                sendEnabled={Boolean(
                                  activeThread &&
                                  hydratedAuthorityKey === authorityKey
                                )}
                                footer={
                                  visiblePendingSend
                                    ? "Resolve the earlier send before sending this edit."
                                    : activeDirectMessage
                                      ? "Direct messages stay among these people."
                                      : "Your @Agent message is sent to this channel; the private chat opens with a bounded quote and a prompt to discuss before work starts."
                                }
                              />
                            </fieldset>
                          </div>
                        </footer>
                      }
                      renderMessage={(sharedMessage) => {
                        const message = sharedMessage.source;
                        return (
                          <MessageRow
                            message={message}
                            forwardRequests={
                              !activeDirectMessage &&
                              message.sender.id !==
                                (snapshot.navigation.teamPrincipal?.id ?? "")
                                ? forwardableTeamRequestsForChannelMessage({
                                    requests: channelRequests,
                                    message,
                                    viewerId:
                                      snapshot.navigation.teamPrincipal?.id ??
                                      "",
                                    teamId: activeTeam.id
                                  })
                                : []
                            }
                            forwardRequestTextById={Object.fromEntries(
                              channelRequests.map((request) => [
                                request.id,
                                visibleMessages.find(
                                  (candidate) =>
                                    candidate.id === request.requestMessageId
                                )?.body ?? ""
                              ])
                            )}
                            onForwardAnswer={(request) =>
                              void forwardChannelAnswer(request, message)
                            }
                            onVisibility={onMessageVisibility}
                            onOpenThread={
                              !activeDirectMessage
                                ? openMessageThread
                                : undefined
                            }
                            onEditMessage={
                              !activeDirectMessage
                                ? (item) => {
                                    openMessageThread(item);
                                    void startThreadEdit(item);
                                  }
                                : undefined
                            }
                            onToggleReaction={
                              !activeDirectMessage
                                ? toggleThreadReaction
                                : undefined
                            }
                            principalUserId={
                              snapshot.navigation.teamPrincipal?.id ?? ""
                            }
                            directMessagePrincipalUserId={
                              activeDirectMessage
                                ? (snapshot.navigation.teamPrincipal?.id ?? "")
                                : undefined
                            }
                          />
                        );
                      }}
                      childrenAfter={
                        status && (
                          <p role="status" className="text-xs text-warning">
                            {status}
                          </p>
                        )
                      }
                    >
                      {!activeDirectMessage && activeThread && (
                        <TeamChannelAgentRequests
                          teamId={activeTeam.id}
                          channelId={activeThread.id}
                          viewerId={snapshot.navigation.teamPrincipal?.id ?? ""}
                          authorityKey={`${snapshot.connection.backendId}:${snapshot.navigation.teamPrincipal?.id ?? ""}:${activeTeam.id}`}
                          refreshRevision={agentRequestRevision}
                          client={teamAgentRequestsClient}
                          onAuthorizationLost={handleSquareAuthorizationLost}
                          onReview={(request) =>
                            void openRequestReview(request)
                          }
                          onViewWork={openRequestWork}
                          onRequestsChanged={setChannelRequests}
                        />
                      )}
                      {visiblePage?.hasOlder && (
                        <button
                          type="button"
                          onClick={loadOlder}
                          className="mx-auto block text-xs text-muted hover:text-foreground"
                        >
                          Load older messages
                        </button>
                      )}
                    </SharedChatUI>
                  </div>
                  {!activeDirectMessage && visibleOpenRoot && (
                    <TeamMessageThreadPane
                      root={visibleOpenRoot}
                      replies={threadReplies}
                      hasOlderReplies={Boolean(
                        threadPage?.hasOlder && threadPage.olderCursor
                      )}
                      principalUserId={
                        snapshot.navigation.teamPrincipal?.id ?? ""
                      }
                      connected={snapshot.connection.state === "live"}
                      replyDraft={threadDraftText}
                      replyMentionUserIds={threadMentionUserIds}
                      onReplyMentionUserIdsChange={changeThreadMentionUserIds}
                      pendingSend={threadPendingSend}
                      pendingStatus={threadSendStatus}
                      editDrafts={threadEditDrafts}
                      agents={teamAgentMentions.options}
                      teamMembers={activeTeam.people
                        .filter(
                          (person) => person.membershipState === "enabled"
                        )
                        .map((person) => ({
                          id: person.id,
                          name: person.displayName
                        }))}
                      key={`${authorityKey ?? ""}:${visibleOpenRoot.id}`}
                      agentRequests={
                        activeThread && (
                          <TeamChannelAgentRequests
                            key={`requests:${authorityKey ?? ""}:${visibleOpenRoot.id}`}
                            teamId={activeTeam.id}
                            channelId={activeThread.id}
                            originRootMessageId={visibleOpenRoot.id}
                            viewerId={
                              snapshot.navigation.teamPrincipal?.id ?? ""
                            }
                            authorityKey={`${snapshot.connection.backendId}:${snapshot.navigation.teamPrincipal?.id ?? ""}:${activeTeam.id}`}
                            refreshRevision={agentRequestRevision}
                            client={teamAgentRequestsClient}
                            onAuthorizationLost={handleSquareAuthorizationLost}
                            onReview={(request) =>
                              void openRequestReview(request)
                            }
                            onViewWork={openRequestWork}
                            onRequestsChanged={setThreadRequests}
                          />
                        )
                      }
                      forwardRequestsByMessage={Object.fromEntries(
                        threadReplies.map((message) => [
                          message.id,
                          forwardableTeamRequestsForReply({
                            requests: threadRequests,
                            message,
                            viewerId:
                              snapshot.navigation.teamPrincipal?.id ?? "",
                            teamId: activeTeam.id,
                            threadId: visibleOpenRoot.threadId,
                            rootMessageId: visibleOpenRoot.id
                          })
                        ])
                      )}
                      forwardRequestTextById={Object.fromEntries(
                        threadRequests.map((request) => [
                          request.id,
                          threadReplies.find(
                            (candidate) =>
                              candidate.id === request.requestMessageId
                          )?.body ?? ""
                        ])
                      )}
                      onForwardAnswer={(request, message) =>
                        void forwardChannelAnswer(request, message)
                      }
                      onClose={() => {
                        setOpenRootMessage(null);
                        openRootRef.current = null;
                        setOpenRootAuthorityKey(null);
                      }}
                      onReplyDraftChange={(text) => {
                        threadDraftEditGeneration.current += 1;
                        setThreadDraftText(text);
                        saveReplyDraft(visibleOpenRoot.id, text);
                      }}
                      onSendReply={async (text, selection) => {
                        if (selection.agentId) {
                          const agent = teamAgentMentions.options.find(
                            (item) => item.id === selection.agentId
                          );
                          if (!agent) {
                            setStatus(
                              "This Agent is no longer available. Refresh Team Agents and try again."
                            );
                            return;
                          }
                          const intent = {
                            agent,
                            text,
                            idempotencyKey: crypto.randomUUID(),
                            sendClientMessageId: crypto.randomUUID(),
                            mentionUserIds: selection.mentionUserIds ?? [],
                            rootMessageId: visibleOpenRoot.id
                          };
                          if (activeThread?.kind === "team_project_channel")
                            void completeAgentMention(
                              intent,
                              activeThread.teamProjectId
                            );
                          else if (activeTeam.sharedProjects.length === 0)
                            setStatus(
                              "Share a Team Project before requesting an Agent."
                            );
                          else setPendingAgentMention(intent);
                          return;
                        }
                        await sendThreadReply(
                          text,
                          undefined,
                          selection.mentionUserIds ?? []
                        );
                      }}
                      onRetryPending={async () => {
                        if (threadPendingSend)
                          await sendThreadReply(
                            threadPendingSend.body,
                            threadPendingSend.clientMessageId
                          );
                      }}
                      onStartEdit={(message) => void startThreadEdit(message)}
                      onCancelEdit={(message) => {
                        setThreadEditDrafts((current) => {
                          const next = new Map(current);
                          next.delete(message.id);
                          return next;
                        });
                        if (authority)
                          void drafts.deleteDraft({
                            ...authority,
                            editMessageId: message.id
                          });
                      }}
                      onEditDraftChange={(message, text) => {
                        const current = threadEditDrafts.get(message.id);
                        if (current)
                          persistThreadEdit(message, { ...current, text });
                      }}
                      onSaveEdit={(message, edit) =>
                        saveThreadEdit(message, edit)
                      }
                      onReviewEditConflict={(message) => {
                        const current = threadEditDrafts.get(message.id);
                        if (current) {
                          const reviewed = editDraftAfterConflictReview({
                            text: current.text,
                            edit: current
                          });
                          if (!reviewed.edit) return;
                          persistThreadEdit(message, {
                            ...reviewed.edit,
                            text: reviewed.text
                          });
                        }
                      }}
                      onToggleReaction={toggleThreadReaction}
                      onLoadOlderReplies={() => {
                        if (threadPage?.olderCursor)
                          void loadRootReplies(
                            visibleOpenRoot,
                            threadPage.olderCursor
                          );
                      }}
                      onReplyVisible={markThreadReplyVisible}
                    />
                  )}
                </div>
              </>
            )}
          </TeamShell>
        </section>
      </SidebarProvider>
      {createChannelOpen && (
        <CreateChannelModal
          teamName={activeTeam.name}
          existingNames={threads
            .filter(
              (thread) => thread.kind !== "dm" && thread.kind !== "group_dm"
            )
            .map((thread) => thread.name.toLowerCase())}
          onClose={() => setCreateChannelOpen(false)}
          onCreateChat={(name) => void createChannel(name)}
          onChooseProject={() => {
            setCreateChannelOpen(false);
            setCreateProjectOpen(true);
          }}
        />
      )}
      {createProjectOpen && (
        <CreateProjectModal
          teams={[{ id: activeTeam.id, name: activeTeam.name }]}
          forceTeamId={activeTeam.id}
          onChooseFolder={chooseLocalProjectFolder}
          onClose={() => setCreateProjectOpen(false)}
          onBack={() => {
            setCreateProjectOpen(false);
            setCreateChannelOpen(true);
          }}
          onCreate={createProject}
        />
      )}
      {channelError && (
        <div
          role="alert"
          className="fixed bottom-5 right-5 z-[110] rounded-lg border border-border bg-surface px-4 py-3 text-sm shadow-xl"
        >
          {channelError}
        </div>
      )}
    </div>
  );
}

function MessageRow({
  message,
  onVisibility,
  directMessagePrincipalUserId,
  forwardRequests = [],
  forwardRequestTextById = {},
  onForwardAnswer,
  onOpenThread,
  onEditMessage,
  onToggleReaction,
  principalUserId = ""
}: {
  message: CollaborationMessage;
  onVisibility: (message: CollaborationMessage, visible: boolean) => void;
  directMessagePrincipalUserId?: string;
  forwardRequests?: TeamAgentRequest[];
  forwardRequestTextById?: Record<string, string>;
  onForwardAnswer?: (request: TeamAgentRequest) => void;
  onOpenThread?: (message: CollaborationMessage) => void;
  onEditMessage?: (message: CollaborationMessage) => void;
  onToggleReaction?: (
    message: CollaborationMessage,
    emoji: string
  ) => void | Promise<void>;
  principalUserId?: string;
}) {
  const rowRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const row = rowRef.current;
    if (!row || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        const visible = Boolean(
          entry?.isIntersecting &&
          document.visibilityState === "visible" &&
          document.hasFocus()
        );
        row.dataset.messageVisible = visible ? "true" : "false";
        row.dataset.messageId = message.id;
        row.dataset.sequence = String(message.sequence);
        onVisibility(message, visible);
      },
      { threshold: 0.6 }
    );
    observer.observe(row);
    const checkOnFocus = () => {
      if (
        !row.isConnected ||
        document.visibilityState !== "visible" ||
        !document.hasFocus()
      )
        return;
      const bounds = row.getBoundingClientRect();
      const visible = bounds.bottom > 0 && bounds.top < window.innerHeight;
      if (visible) onVisibility(message, true);
    };
    window.addEventListener("focus", checkOnFocus);
    document.addEventListener("visibilitychange", checkOnFocus);
    return () => {
      observer.disconnect();
      window.removeEventListener("focus", checkOnFocus);
      document.removeEventListener("visibilitychange", checkOnFocus);
    };
  }, [message, onVisibility]);
  const isDirectMessage = directMessagePrincipalUserId !== undefined;
  const isYou =
    isDirectMessage && message.sender.id === directMessagePrincipalUserId;
  return (
    <article
      ref={rowRef}
      data-message-visible="false"
      data-message-id={message.id}
      data-sequence={message.sequence}
      data-sender-id={message.sender.id}
      data-team-id={message.teamId ?? ""}
      data-thread-id={message.threadId}
      className={
        isDirectMessage
          ? isYou
            ? "flex justify-end"
            : "flex justify-start"
          : "flex gap-3 rounded-lg px-2 py-2 hover:bg-surface-hover/30"
      }
    >
      {isDirectMessage ? (
        <TeamDirectMessageBubble
          message={message}
          principalUserId={directMessagePrincipalUserId}
        />
      ) : (
        <TeamChannelMessageContent
          message={message}
          principalUserId={principalUserId}
          variant="desktop"
          onReply={onOpenThread ? () => onOpenThread(message) : undefined}
          onEditMessage={onEditMessage}
          onToggleReaction={onToggleReaction}
          forwardRequests={forwardRequests}
          forwardRequestTextById={forwardRequestTextById}
          onForwardAnswer={onForwardAnswer}
        />
      )}
    </article>
  );
}
