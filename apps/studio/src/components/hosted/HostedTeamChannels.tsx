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
import { useRouter } from "next/navigation";
import type {
  CollaborationMessage,
  CollaborationThread
} from "@koed/shared/collaboration";
import {
  ChatComposer,
  type ChatComposerSelection
} from "@/components/ChatComposer";
import { ChannelHeader } from "@/components/ChannelView";
import {
  TeamMessageThreadPane,
  type ThreadEditDraft
} from "@/components/TeamMessageThreadPane";
import {
  TeamDirectMessageBubble,
  directMessageTitle
} from "@/components/TeamDirectMessage";
import { CreateChannelModal } from "@/components/CreateChannelModal";
import { SidebarProvider } from "@/components/SidebarContext";
import { TeamShell } from "@/components/TeamShell";
import { TeamChannelMessageContent } from "@/components/TeamChannelMessageContent";
import { SharedChatUI } from "@/components/SharedChatUI";
import { TeamChannelNavigation } from "@/components/TeamSidebar";
import { PublicSquare } from "@/components/PublicSquare";
import {
  TeamAgentRequestInbox,
  TeamChannelAgentRequests
} from "@/components/TeamAgentRequestViews";
import type { HostedTeam, HostedUser } from "@/lib/hosted-session";
import { loadHostedLaunchOptions } from "@/lib/hosted-managed-chats";
import {
  HostedTeamCollaborationClient,
  HostedTeamRequestError
} from "@/lib/hosted-team-collaboration";
import type { HostedTeamPerson } from "@/lib/hosted-team-collaboration";
import { PublicSquareClient } from "@/lib/public-square-client";
import { TeamAgentRequestsClient } from "@/lib/team-agent-requests-client";
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
import { toTeamChatMessages } from "@/lib/team-chat-messages";
import { createBrowserTeamDraftStore } from "@/lib/browser-team-draft-store";
import {
  directMessageAttemptKey,
  directMessageParticipantsAreEligible,
  mergeTeamMessages,
  resolvePendingSend,
  retainPendingSendAfterUncertainOutcome,
  editDraftAfterConflict,
  editDraftAfterConflictReview,
  studioRequestMayApply,
  studioSelectionMatches,
  teamDraftForHydration,
  teamDraftForReplyAttempt,
  messageReactionMayStart,
  messageReactionMayUpdateOpenPane,
  visibleReplyReadMayAdvance
} from "@/lib/team-channel-state";
import type {
  StudioTeamDraft,
  StudioTeamDraftAuthority
} from "@/lib/studio-collaboration-client";

const makeAuthority = (
  teamId: string,
  threadId: string,
  userId: string,
  backendId = typeof window === "undefined" ? "" : window.location.origin
): StudioTeamDraftAuthority => ({
  backendId,
  principalUserId: userId,
  teamId,
  threadId
});

export function HostedTeamChannels({
  team,
  user,
  allTeams,
  onAuthorizationLost
}: {
  team: HostedTeam;
  user: HostedUser;
  allTeams: HostedTeam[];
  onAuthorizationLost: () => void;
}) {
  const router = useRouter();
  const client = useMemo(() => new HostedTeamCollaborationClient(), []);
  const publicSquareClient = useMemo(
    () => new PublicSquareClient("hosted"),
    []
  );
  const teamAgentRequestsClient = useMemo(
    () => new TeamAgentRequestsClient("hosted"),
    []
  );
  const drafts = useMemo(() => {
    try {
      return createBrowserTeamDraftStore();
    } catch {
      return null;
    }
  }, []);
  const [channels, setChannels] = useState<CollaborationThread[]>([]);
  const [projects, setProjects] = useState<
    Array<{ id: string; name: string; thread: CollaborationThread }>
  >([]);
  const [people, setPeople] = useState<HostedTeamPerson[]>([]);
  const [directMessages, setDirectMessages] = useState<CollaborationThread[]>(
    []
  );
  const [navigationLoadedOwner, setNavigationLoadedOwner] = useState("");
  const [threadId, setThreadId] = useState("");
  const [squareOpen, setSquareOpen] = useState(false);
  const [focusSquareJobId, setFocusSquareJobId] = useState<string | null>(null);
  const [forYouOpen, setForYouOpen] = useState(false);
  const [agentOfferRevision, setAgentOfferRevision] = useState(0);
  const [agentRequestRevision, setAgentRequestRevision] = useState(0);
  const [channelRequests, setChannelRequests] = useState<TeamAgentRequest[]>(
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
  const [threadBeforeSequence, setThreadBeforeSequence] = useState<
    number | null
  >(null);
  const [threadHasOlder, setThreadHasOlder] = useState(false);
  const [threadDraftText, setThreadDraftText] = useState("");
  const [threadPendingSend, setThreadPendingSend] =
    useState<StudioTeamDraft["pendingSend"]>(null);
  const [threadSendStatus, setThreadSendStatus] = useState<
    "pending" | "uncertain" | "retry_failed" | null
  >(null);
  const [threadEditDrafts, setThreadEditDrafts] = useState<
    Map<string, ThreadEditDraft>
  >(new Map());
  const [threadRequests, setThreadRequests] = useState<TeamAgentRequest[]>([]);
  const [browserOnline, setBrowserOnline] = useState(true);
  const [realtimeConnection, setRealtimeConnection] = useState({
    owner: "",
    connected: false
  });
  const [authorizationLost, setAuthorizationLost] = useState(false);
  const [messageSelection, setMessageSelection] = useState<{
    teamId: string;
    threadId: string;
  } | null>(null);
  const [loadedPage, setLoadedPage] = useState<{
    teamId: string;
    threadId: string;
  } | null>(null);
  const [beforeSequence, setBeforeSequence] = useState<number | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [draftText, setDraftText] = useState("");
  const [teamMentionSelection, setTeamMentionSelection] =
    useState<ScopedTeamMentionSelection | null>(null);
  const [pendingSend, setPendingSend] =
    useState<StudioTeamDraft["pendingSend"]>(null);
  const [hydrated, setHydrated] = useState(false);
  const [hydratedKey, setHydratedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [visibleRead, setVisibleRead] = useState<{
    id: string;
    sequence: number;
    teamId: string;
    threadId: string;
  } | null>(null);
  const readOwnerKey = `${typeof window === "undefined" ? "" : window.location.origin}:${user.id}:${team.id}`;
  const [readSelection, setReadSelection] = useState({
    ownerKey: readOwnerKey,
    threadId,
    epoch: 0
  });
  const readSelectionRef = useRef(readSelection);
  useLayoutEffect(() => {
    readSelectionRef.current = readSelection;
  }, [readSelection]);
  const [readCursor, setReadCursor] = useState(0);
  if (
    readSelection.ownerKey !== readOwnerKey ||
    readSelection.threadId !== threadId
  ) {
    setReadSelection((current) => ({
      ownerKey: readOwnerKey,
      threadId,
      epoch: current.epoch + 1
    }));
    setVisibleRead(null);
    setReadCursor(0);
  }
  const mountedRef = useRef(true);
  const openRootRef = useRef<CollaborationMessage | null>(null);
  const threadDraftEditGeneration = useRef(0);
  const threadSendInFlight = useRef(new Set<string>());
  const threadReadReported = useRef(new Map<string, number>());
  const realtimeConnectedOwner = useRef("");
  const sendThreadReplyRef = useRef<
    (
      text: string,
      clientMessageId?: string,
      pendingIdentity?: NonNullable<StudioTeamDraft["pendingSend"]>
    ) => Promise<boolean | void>
  >(async () => false);
  const revokedRef = useRef(false);
  const navigationGeneration = useRef(0);
  const directMessageRequestIds = useRef(new Map<string, string>());
  const navigationOwner = useRef("");
  const draftByAuthority = useRef(new Map<string, StudioTeamDraft>());
  const selectedThreadRef = useRef(threadId);
  const ownerKey = `${user.id}:${team.id}`;
  const localProjectsOwner = `${typeof window === "undefined" ? "" : window.location.origin}:${user.id}`;
  const localProjects =
    localProjectsState.owner === localProjectsOwner
      ? localProjectsState.projects
      : [];
  const loadingLocalProjects =
    localProjectsState.owner !== localProjectsOwner ||
    !localProjectsState.loaded;
  const teamAuthorizedBySnapshot = allTeams.some((item) => item.id === team.id);
  const navigationReady =
    navigationLoadedOwner === ownerKey && teamAuthorizedBySnapshot;
  const authorityKeyRef = useRef<string | null>(null);
  const visibleChannels = useMemo(
    () => (navigationReady ? channels : []),
    [channels, navigationReady]
  );
  const visibleProjects = useMemo(
    () => (navigationReady ? projects : []),
    [navigationReady, projects]
  );
  const visiblePeople = useMemo(
    () => (navigationReady ? people : []),
    [navigationReady, people]
  );
  const visibleDirectMessages = useMemo(
    () => (navigationReady ? directMessages : []),
    [directMessages, navigationReady]
  );
  const activeThreads = useMemo(
    () => [
      ...visibleChannels,
      ...visibleProjects.map((project) => project.thread),
      ...visibleDirectMessages
    ],
    [visibleChannels, visibleDirectMessages, visibleProjects]
  );
  const activeThread =
    activeThreads.find((thread) => thread.id === threadId) ?? null;
  const activeThreadId = activeThread?.id ?? null;
  const activeThreadKind = activeThread?.kind ?? null;
  const teamMentionScopeKey = JSON.stringify({
    backendId: typeof window === "undefined" ? "" : window.location.origin,
    principalId: user.id,
    teamId: team.id,
    threadId: activeThread?.id ?? ""
  });
  const activeMentionAgentId = teamMentionSelectionForScope(
    teamMentionSelection,
    teamMentionScopeKey
  );
  const squareProjects = useMemo(
    () =>
      visibleProjects.map((project) => ({
        id: project.id,
        name: project.name
      })),
    [visibleProjects]
  );
  const square = usePublicSquare({
    client: publicSquareClient,
    scope: {
      backendId: typeof window === "undefined" ? "" : window.location.origin,
      principalUserId: user.id,
      teamId: team.id
    },
    projects: squareProjects,
    localProjects,
    enabled: navigationReady,
    onAuthorizationLost
  });
  const teamAgentMentions = useTeamAgentMentions(
    teamAgentRequestsClient,
    team.id,
    user.id,
    `${typeof window === "undefined" ? "" : window.location.origin}:${user.id}:${team.id}`,
    agentOfferRevision
  );
  const [pendingAgentMention, setPendingAgentMention] = useState<{
    agent: TeamAgentMention;
    text: string;
    idempotencyKey: string;
    rootMessageId?: string;
  } | null>(null);
  const [agentMentionBusy, setAgentMentionBusy] = useState(false);
  const openRequestReview = useCallback(
    async (request: TeamAgentRequest, draft?: string) => {
      try {
        const review = await teamAgentRequestsClient.getReview(
          team.id,
          request.id
        );
        const connection = await publicSquareClient.getConnection(
          team.id,
          request.teamProjectId
        );
        if (!mountedRef.current) return;
        if (!connection.localProjectId) {
          setError(
            "Connect this Team Project to a local Project in Public Square before reviewing its Agent request."
          );
          return;
        }
        const query = new URLSearchParams({
          chat: "1",
          agent: request.agentId,
          project: connection.localProjectId,
          teamRequest: request.id,
          teamRequestTeam: team.id
        });
        query.set("teamRequestVersion", String(request.version));
        query.set("teamReviewVersion", String(review.version));
        if (review.executionId) query.set("execution", review.executionId);
        if (draft) query.set("draft", draft.slice(0, 2_400));
        router.push(`/?${query.toString()}`);
      } catch (failure) {
        if (!mountedRef.current) return;
        setError(
          failure instanceof Error
            ? failure.message
            : "The private Agent review could not be opened."
        );
      }
    },
    [publicSquareClient, router, team.id, teamAgentRequestsClient]
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
      if (!canForwardTeamAnswer(request, user.id)) return;
      try {
        const review = await teamAgentRequestsClient.getReview(
          team.id,
          request.id
        );
        if (
          !review.executionId ||
          !mountedRef.current ||
          selectedThreadRef.current !== message.threadId
        ) {
          setError(
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
        if (mountedRef.current)
          setError(
            failure instanceof Error
              ? failure.message
              : "The Team reply could not be opened privately."
          );
      }
    },
    [openRequestReview, team.id, teamAgentRequestsClient, user.id]
  );
  const refreshSquare = square.refresh;
  const messageViewReady = Boolean(
    navigationReady &&
    activeThread &&
    messageSelection?.teamId === team.id &&
    messageSelection.threadId === activeThread.id
  );
  const visibleMessages = messageViewReady ? messages : [];
  const visiblePage =
    messageViewReady &&
    loadedPage?.teamId === team.id &&
    loadedPage.threadId === activeThread?.id;
  const activeDirectMessage =
    activeThread?.kind === "dm" || activeThread?.kind === "group_dm"
      ? activeThread
      : null;
  const channelMessages = activeDirectMessage
    ? visibleMessages
    : visibleMessages.filter((message) => message.rootMessageId === null);
  const sharedChannelMessages = toTeamChatMessages(channelMessages, user.id);
  const activeDirectMessageTitle = activeDirectMessage
    ? directMessageTitle(activeDirectMessage, user.id)
    : "";
  const backendId = typeof window === "undefined" ? "" : window.location.origin;
  const authority = useMemo(
    () =>
      activeThreadId
        ? makeAuthority(team.id, activeThreadId, user.id, backendId)
        : null,
    [activeThreadId, backendId, team.id, user.id]
  );
  const authorityKey = authority ? JSON.stringify(authority) : null;
  const [threadPaneAuthorityKey, setThreadPaneAuthorityKey] =
    useState(authorityKey);
  if (threadPaneAuthorityKey !== authorityKey) {
    setThreadPaneAuthorityKey(authorityKey);
    setOpenRootMessage(null);
    setOpenRootAuthorityKey(null);
    setThreadReplies([]);
    setThreadDraftText("");
    setThreadPendingSend(null);
    setThreadSendStatus(null);
    setThreadEditDrafts(new Map());
    setThreadRequests([]);
  }
  const [hydrationAuthorityKey, setHydrationAuthorityKey] =
    useState(authorityKey);
  if (hydrationAuthorityKey !== authorityKey) {
    setHydrationAuthorityKey(authorityKey);
    setHydrated(false);
    setHydratedKey(null);
  }
  const draftReady = Boolean(
    authorityKey && hydrated && hydratedKey === authorityKey
  );
  useLayoutEffect(() => {
    authorityKeyRef.current = authorityKey;
    selectedThreadRef.current = threadId;
    openRootRef.current =
      openRootAuthorityKey === authorityKey ? openRootMessage : null;
  }, [authorityKey, openRootAuthorityKey, openRootMessage, threadId]);
  const visibleOpenRoot =
    openRootMessage &&
    openRootAuthorityKey === authorityKey &&
    openRootMessage.teamId === team.id &&
    openRootMessage.threadId === activeThread?.id
      ? openRootMessage
      : null;
  const connected =
    browserOnline &&
    navigationReady &&
    !authorizationLost &&
    realtimeConnection.owner === ownerKey &&
    realtimeConnection.connected;
  const visibleDraftText =
    authorityKey && hydratedKey === authorityKey ? draftText : "";
  const visiblePendingSend =
    authorityKey && hydratedKey === authorityKey ? pendingSend : null;
  const handleAuthorizationLost = useCallback(() => {
    revokedRef.current = true;
    realtimeConnectedOwner.current = "";
    setAuthorizationLost(true);
    navigationGeneration.current += 1;
    setChannels([]);
    setProjects([]);
    setPeople([]);
    setDirectMessages([]);
    setNavigationLoadedOwner("");
    setThreadId("");
    selectedThreadRef.current = "";
    setMessages([]);
    setMessageSelection(null);
    setLoadedPage(null);
    setBeforeSequence(null);
    setHasOlder(false);
    setDraftText("");
    setPendingSend(null);
    setHydrated(false);
    setHydratedKey(null);
    setVisibleRead(null);
    setSquareOpen(false);
    setForYouOpen(false);
    setPendingAgentMention(null);
    setError("Team access changed. Refresh to check your access.");
    draftByAuthority.current.clear();
    if (drafts) {
      void drafts
        .deleteTeam({
          backendId:
            typeof window === "undefined" ? "" : window.location.origin,
          principalUserId: user.id,
          teamId: team.id
        })
        .catch(() => undefined);
    }
    onAuthorizationLost();
  }, [drafts, onAuthorizationLost, setPendingAgentMention, team.id, user.id]);
  const handleAuthorizationLostFromEffect = useEffectEvent(
    (capturedReadOwnerKey: string, capturedGeneration: number) => {
      if (
        readOwnerKey !== capturedReadOwnerKey ||
        teamAuthorizedBySnapshot ||
        navigationGeneration.current !== capturedGeneration ||
        !revokedRef.current
      )
        return;
      handleAuthorizationLost();
    }
  );

  const loadNavigationSnapshot = useCallback(
    () =>
      Promise.all([
        client.listChannels(team.id),
        client.listProjects(team.id),
        client.listPeople(team.id),
        client.listDirectMessages(team.id)
      ]),
    [client, team.id]
  );
  const applyNavigationSnapshot = useCallback(
    (
      snapshot: Awaited<ReturnType<typeof loadNavigationSnapshot>>,
      ownerKey: string,
      generation: number,
      priorThreadId: string
    ) => {
      if (
        !studioRequestMayApply({
          capturedGeneration: generation,
          currentGeneration: navigationGeneration.current,
          mounted: mountedRef.current
        })
      )
        return;
      const [nextChannels, nextProjects, nextPeople, nextDirectMessages] =
        snapshot;
      revokedRef.current = false;
      setAuthorizationLost(false);
      setChannels(nextChannels);
      setProjects(nextProjects);
      setPeople(nextPeople);
      setDirectMessages(nextDirectMessages);
      setNavigationLoadedOwner(ownerKey);
      const availableThreads = [
        ...nextChannels,
        ...nextProjects.map((project) => project.thread),
        ...nextDirectMessages
      ];
      const initialThreadId = availableThreads.some(
        (thread) => thread.id === priorThreadId
      )
        ? priorThreadId
        : (nextChannels.find((thread) => thread.name === "general")?.id ??
          nextChannels[0]?.id ??
          nextProjects[0]?.thread.id ??
          nextDirectMessages[0]?.id ??
          "");
      setThreadId(initialThreadId);
      selectedThreadRef.current = initialThreadId;
      setError(null);
    },
    []
  );
  const beginNavigationRefresh = useCallback(() => {
    const generation = ++navigationGeneration.current;
    const currentOwnerKey = `${user.id}:${team.id}`;
    const preserveSelection = navigationOwner.current === currentOwnerKey;
    const priorThreadId = preserveSelection ? selectedThreadRef.current : "";
    if (!preserveSelection) {
      navigationOwner.current = currentOwnerKey;
      draftByAuthority.current.clear();
    }
    return { currentOwnerKey, generation, priorThreadId };
  }, [team.id, user.id]);
  const refreshNavigation = useCallback(async () => {
    const { currentOwnerKey, generation, priorThreadId } =
      beginNavigationRefresh();
    try {
      const snapshot = await loadNavigationSnapshot();
      applyNavigationSnapshot(
        snapshot,
        currentOwnerKey,
        generation,
        priorThreadId
      );
    } catch (failure) {
      if (
        !studioRequestMayApply({
          capturedGeneration: generation,
          currentGeneration: navigationGeneration.current,
          mounted: mountedRef.current
        })
      )
        return;
      if (
        failure instanceof HostedTeamRequestError &&
        [401, 403].includes(failure.status)
      )
        handleAuthorizationLost();
      else
        setError(
          failure instanceof Error
            ? failure.message
            : "Team channels are unavailable."
        );
    }
  }, [
    applyNavigationSnapshot,
    beginNavigationRefresh,
    handleAuthorizationLost,
    loadNavigationSnapshot
  ]);

  const loadPage = useCallback(
    async (id: string, before: number | null = null) => {
      const ownerKey = `${user.id}:${team.id}`;
      try {
        const page = await client.loadMessages(team.id, id, before, 50);
        if (
          !mountedRef.current ||
          navigationOwner.current !== ownerKey ||
          selectedThreadRef.current !== id
        )
          return;
        setMessages((current) =>
          mergeTeamMessages(
            current.filter(
              (message) => message.teamId === team.id && message.threadId === id
            ),
            page.items
          )
        );
        setMessageSelection({ teamId: team.id, threadId: id });
        setLoadedPage({ teamId: team.id, threadId: id });
        setHasOlder(page.hasOlder);
        setBeforeSequence(page.nextBeforeSequence);
        setError(null);
      } catch (failure) {
        if (
          !mountedRef.current ||
          navigationOwner.current !== ownerKey ||
          selectedThreadRef.current !== id
        )
          return;
        if (
          failure instanceof HostedTeamRequestError &&
          [401, 403].includes(failure.status)
        )
          handleAuthorizationLost();
        else
          setError(
            failure instanceof Error
              ? failure.message
              : "Channel history is unavailable."
          );
      }
    },
    [client, handleAuthorizationLost, team.id, user.id]
  );

  const loadRootReplies = useCallback(
    async (root: CollaborationMessage, before: number | null = null) => {
      const capturedAuthorityKey = authorityKey;
      const capturedOwnerKey = `${user.id}:${team.id}`;
      try {
        const page = await client.loadMessages(
          team.id,
          root.threadId,
          before,
          50,
          root.id
        );
        if (
          !mountedRef.current ||
          authorityKeyRef.current !== capturedAuthorityKey ||
          navigationOwner.current !== capturedOwnerKey ||
          selectedThreadRef.current !== root.threadId ||
          openRootRef.current?.id !== root.id
        )
          return;
        setThreadReplies((current) =>
          before === null
            ? page.items.filter((message) => message.rootMessageId === root.id)
            : mergeTeamMessages(
                current,
                page.items.filter(
                  (message) => message.rootMessageId === root.id
                )
              )
        );
        setThreadHasOlder(page.hasOlder);
        setThreadBeforeSequence(page.nextBeforeSequence);
        const updatedRoot = messages.find((message) => message.id === root.id);
        if (updatedRoot) setOpenRootMessage(updatedRoot);
      } catch (failure) {
        if (
          failure instanceof HostedTeamRequestError &&
          [401, 403].includes(failure.status)
        )
          handleAuthorizationLost();
      }
    },
    [authorityKey, client, handleAuthorizationLost, messages, team.id, user.id]
  );

  const openMessageThread = useCallback(
    (root: CollaborationMessage) => {
      const capturedAuthority = authority;
      const capturedAuthorityKey = authorityKey;
      const capturedDraftGeneration = ++threadDraftEditGeneration.current;
      setOpenRootAuthorityKey(capturedAuthorityKey);
      setThreadDraftText("");
      setOpenRootMessage(root);
      openRootRef.current = root;
      setThreadReplies([]);
      setThreadBeforeSequence(null);
      setThreadHasOlder(false);
      setThreadPendingSend(null);
      setThreadSendStatus(null);
      setThreadEditDrafts(new Map());
      setThreadRequests([]);
      if (capturedAuthority && drafts)
        void drafts
          .load({ ...capturedAuthority, rootMessageId: root.id })
          .then((stored) => {
            if (
              authorityKeyRef.current !== capturedAuthorityKey ||
              openRootRef.current?.id !== root.id
            )
              return;
            if (threadDraftEditGeneration.current === capturedDraftGeneration)
              setThreadDraftText(stored?.text ?? "");
            setThreadPendingSend(stored?.pendingSend ?? null);
            setThreadSendStatus(stored?.pendingSend ? "pending" : null);
            if (stored?.pendingSend)
              void sendThreadReplyRef.current(
                stored.pendingSend.body,
                stored.pendingSend.clientMessageId,
                stored.pendingSend
              );
          })
          .catch(() => {
            if (
              authorityKeyRef.current === capturedAuthorityKey &&
              openRootRef.current?.id === root.id
            )
              setError("The encrypted reply draft could not be opened.");
          });
      void loadRootReplies(root);
    },
    [authority, authorityKey, drafts, loadRootReplies]
  );

  const saveReplyDraft = useCallback(
    (rootMessageId: string, text: string, pending = threadPendingSend) => {
      if (!authority || !drafts) return;
      const capturedAuthorityKey = authorityKey;
      const scopedAuthority = { ...authority, rootMessageId };
      const value = { text, pendingSend: pending, receiptAckPending: null };
      draftByAuthority.current.set(JSON.stringify(scopedAuthority), value);
      void drafts.save(scopedAuthority, value).catch(() => {
        if (
          authorityKeyRef.current === capturedAuthorityKey &&
          openRootRef.current?.id === rootMessageId
        )
          setError(
            "The encrypted reply draft could not be saved on this device."
          );
      });
    },
    [authority, authorityKey, drafts, threadPendingSend]
  );

  const sendThreadReply = useCallback(
    async (
      text: string,
      clientMessageId?: string,
      pendingIdentity?: NonNullable<StudioTeamDraft["pendingSend"]>
    ) => {
      const root = openRootMessage;
      if (!root || !authority || !drafts || !text.trim()) return;
      const scopedAuthority = { ...authority, rootMessageId: root.id };
      const identity =
        pendingIdentity ??
        (threadPendingSend?.body === text
          ? threadPendingSend
          : {
              clientMessageId: clientMessageId ?? crypto.randomUUID(),
              body: text,
              createdAt: new Date().toISOString()
            });
      const sendKey = `${JSON.stringify(scopedAuthority)}:${identity.clientMessageId}`;
      if (threadSendInFlight.current.has(sendKey)) return;
      threadSendInFlight.current.add(sendKey);
      const scopedKey = JSON.stringify(scopedAuthority);
      const currentDraft = draftByAuthority.current.get(scopedKey);
      const retryingExistingSend =
        currentDraft?.pendingSend?.clientMessageId ===
          identity.clientMessageId ||
        threadPendingSend?.clientMessageId === identity.clientMessageId;
      const pendingDraft = teamDraftForReplyAttempt(
        currentDraft,
        identity,
        retryingExistingSend,
        threadDraftText
      );
      draftByAuthority.current.set(scopedKey, pendingDraft);
      setThreadPendingSend(identity);
      setThreadSendStatus("pending");
      setThreadDraftText(pendingDraft.text);
      try {
        await drafts.save(scopedAuthority, pendingDraft);
      } catch {
        const latest = draftByAuthority.current.get(scopedKey) ?? pendingDraft;
        const restored = resolvePendingSend(
          latest,
          identity.clientMessageId,
          "not-sent",
          identity.body
        );
        draftByAuthority.current.set(scopedKey, restored);
        if (
          authorityKeyRef.current === authorityKey &&
          openRootRef.current?.id === root.id
        ) {
          setThreadPendingSend(restored.pendingSend);
          setThreadSendStatus(null);
          setThreadDraftText(restored.text);
          setError(
            "The reply could not be saved on this device, so it was not sent."
          );
        }
        threadSendInFlight.current.delete(sendKey);
        return false;
      }
      if (
        !navigator.onLine ||
        (!connected &&
          realtimeConnectedOwner.current !== `${user.id}:${team.id}`)
      ) {
        threadSendInFlight.current.delete(sendKey);
        return false;
      }
      try {
        const receipt = await client.sendMessage(
          team.id,
          root.threadId,
          identity.body,
          identity.clientMessageId,
          root.id
        );
        const message = receipt.message;
        if (receipt.acceptedBody !== identity.body)
          throw new HostedTeamRequestError(
            "The accepted reply body did not match this pending send.",
            502
          );
        if (message.rootMessageId !== root.id)
          throw new HostedTeamRequestError(
            "Koed returned a reply for a different thread root.",
            502
          );
        const current =
          authorityKeyRef.current === authorityKey &&
          openRootRef.current?.id === root.id;
        const latest = draftByAuthority.current.get(scopedKey) ?? pendingDraft;
        const settled = resolvePendingSend(
          latest,
          identity.clientMessageId,
          "accepted",
          identity.body
        );
        draftByAuthority.current.set(scopedKey, settled);
        await drafts.save(scopedAuthority, settled);
        if (current) {
          if (message.rootMessageId !== null)
            setThreadReplies((items) => mergeTeamMessages(items, [message]));
          setThreadPendingSend(settled.pendingSend);
          setThreadSendStatus(null);
          setThreadDraftText(settled.text);
          setOpenRootMessage((item) =>
            item?.id === root.id
              ? { ...item, replyCount: item.replyCount + 1 }
              : item
          );
        }
        return true;
      } catch (failure) {
        if (
          failure instanceof HostedTeamRequestError &&
          [401, 403].includes(failure.status)
        )
          handleAuthorizationLost();
        else if (
          authorityKeyRef.current === authorityKey &&
          openRootRef.current?.id === root.id
        ) {
          setThreadSendStatus(
            failure instanceof HostedTeamRequestError &&
              [400, 404, 422].includes(failure.status)
              ? "retry_failed"
              : "uncertain"
          );
          setError(
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
      authorityKey,
      client,
      connected,
      drafts,
      handleAuthorizationLost,
      openRootMessage,
      team.id,
      threadDraftText,
      threadPendingSend,
      user.id
    ]
  );

  const retryPendingThreadReply = useEffectEvent(
    (pendingIdentity?: NonNullable<StudioTeamDraft["pendingSend"]>) => {
      const pending = pendingIdentity ?? threadPendingSend;
      if (!pending || (!pendingIdentity && threadSendStatus !== "pending"))
        return;
      void sendThreadReply(pending.body, pending.clientMessageId, pending);
    }
  );
  useLayoutEffect(() => {
    sendThreadReplyRef.current = sendThreadReply;
  }, [sendThreadReply]);

  const startThreadEdit = useCallback(
    async (message: CollaborationMessage) => {
      if (!authority || !drafts) return;
      const rootId = openRootRef.current?.id;
      const saved = await drafts
        .load({ ...authority, editMessageId: message.id })
        .catch(() => {
          if (
            authorityKeyRef.current === authorityKey &&
            openRootRef.current?.id === rootId
          )
            setError("The encrypted edit draft could not be opened.");
          return null;
        });
      if (
        authorityKeyRef.current !== authorityKey ||
        openRootRef.current?.id !== rootId
      )
        return;
      const edit: ThreadEditDraft = saved?.edit
        ? { text: saved.text, ...saved.edit }
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
      if (!authority || !drafts) return;
      setThreadEditDrafts((current) => new Map(current).set(message.id, edit));
      const capturedAuthorityKey = authorityKey;
      const capturedRootId = openRootRef.current?.id;
      void drafts
        .save(
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
        .catch(() => {
          if (
            authorityKeyRef.current === capturedAuthorityKey &&
            openRootRef.current?.id === capturedRootId
          )
            setError(
              "The encrypted edit draft could not be saved on this device."
            );
        });
    },
    [authority, authorityKey, drafts]
  );

  const saveThreadEdit = useCallback(
    async (message: CollaborationMessage, edit: ThreadEditDraft) => {
      if (!connected || !drafts || !openRootMessage) return;
      const capturedAuthorityKey = authorityKey;
      const capturedAuthority = authority;
      const capturedRootId = openRootMessage.id;
      try {
        const updated = await client.editMessage(
          team.id,
          message.threadId,
          message.id,
          edit.text,
          edit.expectedVersion
        );
        const current =
          authorityKeyRef.current === authorityKey &&
          openRootRef.current?.id === openRootMessage.id;
        if (current) {
          setMessages((items) => mergeTeamMessages(items, [updated]));
          if (updated.rootMessageId !== null)
            setThreadReplies((items) => mergeTeamMessages(items, [updated]));
          setOpenRootMessage((item) =>
            item?.id === updated.id ? updated : item
          );
          setThreadEditDrafts((items) => {
            const next = new Map(items);
            next.delete(message.id);
            return next;
          });
        }
        if (capturedAuthority)
          await drafts.delete({
            ...capturedAuthority,
            editMessageId: message.id
          });
        if (!current) return;
      } catch (failure) {
        if (
          failure instanceof HostedTeamRequestError &&
          [401, 403].includes(failure.status)
        ) {
          handleAuthorizationLost();
          return;
        }
        try {
          const page = await client.loadMessages(
            team.id,
            message.threadId,
            message.sequence + 1,
            1,
            message.rootMessageId
          );
          if (
            authorityKeyRef.current !== capturedAuthorityKey ||
            openRootRef.current?.id !== capturedRootId
          )
            return;
          const latest = page.items.find((item) => item.id === message.id);
          if (latest && latest.version > edit.expectedVersion)
            persistThreadEdit(
              message,
              editDraftAfterConflict(
                { text: edit.text, edit },
                { version: latest.version, bodyText: latest.body }
              ).edit!
            );
          setError(
            failure instanceof Error
              ? failure.message
              : "The message edit could not be saved."
          );
        } catch {
          if (
            authorityKeyRef.current === capturedAuthorityKey &&
            openRootRef.current?.id === capturedRootId
          )
            setError(
              "The edit could not be saved and the latest message could not be loaded."
            );
        }
      }
    },
    [
      authority,
      authorityKey,
      client,
      connected,
      drafts,
      handleAuthorizationLost,
      openRootMessage,
      persistThreadEdit,
      team.id
    ]
  );

  const toggleThreadReaction = useCallback(
    async (message: CollaborationMessage, emoji: string) => {
      if (!connected) return;
      const capturedAuthorityKey = authorityKeyRef.current;
      const capturedRoot = openRootRef.current;
      if (
        !capturedAuthorityKey ||
        !messageReactionMayStart({
          message,
          teamId: team.id,
          threadId: activeThread?.id ?? "",
          openRootMessageId:
            capturedRoot?.teamId === team.id &&
            capturedRoot.threadId === activeThread?.id
              ? capturedRoot.id
              : null
        })
      )
        return;
      try {
        const reaction = message.reactions.find((item) => item.emoji === emoji);
        const updated = await client.setMessageReaction(
          team.id,
          message.threadId,
          message.id,
          emoji,
          !reaction?.reacted
        );
        if (authorityKeyRef.current !== capturedAuthorityKey) return;
        setMessages((items) => mergeTeamMessages(items, [updated]));
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
          setThreadReplies((items) => mergeTeamMessages(items, [updated]));
        if (
          currentRootId &&
          currentRootId === capturedRoot?.id &&
          updated.id === currentRootId
        )
          setOpenRootMessage((item) =>
            item?.id === updated.id ? updated : item
          );
      } catch (failure) {
        if (
          authorityKeyRef.current === capturedAuthorityKey &&
          failure instanceof HostedTeamRequestError &&
          [401, 403].includes(failure.status)
        )
          handleAuthorizationLost();
      }
    },
    [activeThread?.id, client, connected, handleAuthorizationLost, team.id]
  );

  const markThreadReplyVisible = useCallback(
    (message: CollaborationMessage) => {
      const root = openRootRef.current;
      const capturedAuthorityKey = authorityKeyRef.current;
      if (
        !root ||
        message.rootMessageId !== root.id ||
        !connected ||
        !visibleReplyReadMayAdvance({
          rootMessageId: root.id,
          replyMessageId: message.id,
          sequence: message.sequence,
          senderId: message.sender.id,
          principalUserId: user.id,
          focused:
            document.visibilityState === "visible" && document.hasFocus(),
          rootPaneVisible: openRootRef.current?.id === root.id,
          lastReportedSequence:
            threadReadReported.current.get(
              `${capturedAuthorityKey}:${root.id}`
            ) ?? 0
        })
      )
        return;
      const readKey = `${capturedAuthorityKey}:${root.id}`;
      if (message.sequence <= (threadReadReported.current.get(readKey) ?? 0))
        return;
      threadReadReported.current.set(readKey, message.sequence);
      void client
        .markRead(team.id, message.threadId, message.id, root.id)
        .then(() => {
          if (
            authorityKeyRef.current !== capturedAuthorityKey ||
            openRootRef.current?.id !== root.id
          )
            return;
          setMessages((items) =>
            items.map((item) =>
              item.id === root.id
                ? {
                    ...item,
                    unreadReplyCount: Math.max(0, item.unreadReplyCount - 1)
                  }
                : item
            )
          );
          setOpenRootMessage((item) =>
            item?.id === root.id
              ? {
                  ...item,
                  unreadReplyCount: Math.max(0, item.unreadReplyCount - 1)
                }
              : item
          );
        })
        .catch(() => undefined);
    },
    [client, connected, team.id, user.id]
  );

  const updateThreadDraft = useCallback(
    (text: string) => {
      threadDraftEditGeneration.current += 1;
      setThreadDraftText(text);
      const root = openRootRef.current;
      if (root) saveReplyDraft(root.id, text);
    },
    [saveReplyDraft]
  );

  const cancelThreadEdit = useCallback(
    (message: CollaborationMessage) => {
      setThreadEditDrafts((current) => {
        const next = new Map(current);
        next.delete(message.id);
        return next;
      });
      if (authority && drafts)
        void drafts.delete({ ...authority, editMessageId: message.id });
    },
    [authority, drafts]
  );

  const reviewThreadEdit = useCallback(
    async (message: CollaborationMessage) => {
      const edit = threadEditDrafts.get(message.id);
      if (!edit || !authority || !openRootMessage) return;
      const capturedAuthorityKey = authorityKey;
      const capturedRootId = openRootMessage.id;
      try {
        const page = await client.loadMessages(
          team.id,
          message.threadId,
          message.sequence + 1,
          1,
          message.rootMessageId
        );
        if (
          authorityKeyRef.current !== capturedAuthorityKey ||
          openRootRef.current?.id !== capturedRootId
        )
          return;
        const latest = page.items.find((item) => item.id === message.id);
        if (!latest) return;
        const conflicted = editDraftAfterConflict(
          { text: edit.text, edit },
          { version: latest.version, bodyText: latest.body }
        );
        const reviewed = editDraftAfterConflictReview(conflicted);
        if (!reviewed.edit) return;
        persistThreadEdit(message, { ...reviewed.edit, text: reviewed.text });
        setMessages((items) => mergeTeamMessages(items, [latest]));
        if (latest.rootMessageId !== null)
          setThreadReplies((items) => mergeTeamMessages(items, [latest]));
        setOpenRootMessage((item) => (item?.id === latest.id ? latest : item));
      } catch (failure) {
        if (
          authorityKeyRef.current === capturedAuthorityKey &&
          openRootRef.current?.id === capturedRootId
        )
          setError(
            failure instanceof Error
              ? failure.message
              : "The latest saved message could not be loaded."
          );
      }
    },
    [
      authority,
      authorityKey,
      client,
      openRootMessage,
      persistThreadEdit,
      team.id,
      threadEditDrafts
    ]
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      navigationGeneration.current += 1;
    };
  }, []);
  useEffect(() => {
    const update = () => {
      const online = navigator.onLine;
      setBrowserOnline(online);
      if (online) retryPendingThreadReply();
    };
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  useEffect(() => {
    const { currentOwnerKey, generation, priorThreadId } =
      beginNavigationRefresh();
    let current = true;
    void loadNavigationSnapshot().then(
      (snapshot) => {
        if (!current) return;
        applyNavigationSnapshot(
          snapshot,
          currentOwnerKey,
          generation,
          priorThreadId
        );
      },
      (failure: unknown) => {
        if (
          !current ||
          !studioRequestMayApply({
            capturedGeneration: generation,
            currentGeneration: navigationGeneration.current,
            mounted: mountedRef.current
          })
        )
          return;
        if (
          failure instanceof HostedTeamRequestError &&
          [401, 403].includes(failure.status)
        )
          handleAuthorizationLost();
        else
          setError(
            failure instanceof Error
              ? failure.message
              : "Team channels are unavailable."
          );
      }
    );
    return () => {
      current = false;
    };
  }, [
    applyNavigationSnapshot,
    beginNavigationRefresh,
    handleAuthorizationLost,
    loadNavigationSnapshot
  ]);
  useEffect(() => {
    let active = true;
    void loadHostedLaunchOptions()
      .then((options) => {
        if (active)
          setLocalProjectsState({
            owner: localProjectsOwner,
            loaded: true,
            projects: options.projects.map((project) => ({
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
  }, [localProjectsOwner]);
  useEffect(() => {
    if (!drafts) return;
    void drafts.retainAuthorizedTeams({
      backendId: typeof window === "undefined" ? "" : window.location.origin,
      principalUserId: user.id,
      teamIds: allTeams.map((item) => item.id)
    });
  }, [allTeams, drafts, user.id]);
  useEffect(() => {
    if (!teamAuthorizedBySnapshot && navigationLoadedOwner === ownerKey) {
      if (!revokedRef.current) {
        revokedRef.current = true;
        draftByAuthority.current.clear();
        navigationGeneration.current += 1;
        if (drafts) {
          const capturedOwnerKey = ownerKey;
          const capturedReadOwnerKey = readOwnerKey;
          const capturedGeneration = navigationGeneration.current;
          const finishRevocation = () => {
            if (
              mountedRef.current &&
              navigationOwner.current === capturedOwnerKey
            )
              handleAuthorizationLostFromEffect(
                capturedReadOwnerKey,
                capturedGeneration
              );
          };
          void drafts
            .deleteTeam({
              backendId,
              principalUserId: user.id,
              teamId: team.id
            })
            .then(finishRevocation, finishRevocation);
        } else onAuthorizationLost();
      }
      return;
    }
    if (!activeThreadId || !activeThreadKind || !authority || !drafts) return;
    let current = true;
    const authorize =
      activeThreadKind === "dm" || activeThreadKind === "group_dm"
        ? client
            .listDirectMessages(team.id)
            .then((threads) =>
              threads.some(
                (thread) =>
                  thread.id === activeThreadId &&
                  (thread.kind === "dm" || thread.kind === "group_dm")
              )
            )
        : Promise.resolve(true);
    void authorize
      .then(async (authorized) => {
        if (!current || revokedRef.current) return null;
        if (!authorized) {
          setMessages([]);
          setDraftText("");
          setPendingSend(null);
          setHydrated(false);
          setHydratedKey(null);
          setError(
            "This direct message is no longer available to your account."
          );
          const fallback =
            channels.find((thread) => thread.name === "general")?.id ??
            channels[0]?.id ??
            projects[0]?.thread.id ??
            "";
          selectedThreadRef.current = fallback;
          setThreadId(fallback);
          return null;
        }
        void loadPage(activeThreadId);
        await drafts.retainAuthorizedTeams({
          backendId: authority.backendId,
          principalUserId: user.id,
          teamIds: allTeams.map((item) => item.id)
        });
        return {
          stored: await drafts.load(authority),
          cached: draftByAuthority.current.get(JSON.stringify(authority))
        };
      })
      .then((stored) => {
        if (!stored) return;
        if (!current || revokedRef.current) return;
        const draft = stored.cached ?? teamDraftForHydration(stored.stored);
        draftByAuthority.current.set(JSON.stringify(authority), draft);
        setDraftText(draft.text);
        setPendingSend(draft.pendingSend);
        setHydrated(true);
        setHydratedKey(JSON.stringify(authority));
      })
      .catch((failure: unknown) => {
        if (!current || revokedRef.current) return;
        if (
          failure instanceof HostedTeamRequestError &&
          [401, 403].includes(failure.status)
        )
          handleAuthorizationLost();
        else
          setError(
            activeThreadKind === "dm" || activeThreadKind === "group_dm"
              ? "Direct message access could not be checked. Try again."
              : "Encrypted draft recovery is unavailable in this browser."
          );
      });
    return () => {
      current = false;
    };
  }, [
    activeThreadId,
    activeThreadKind,
    allTeams,
    backendId,
    authority,
    authorityKey,
    channels,
    client,
    drafts,
    handleAuthorizationLost,
    loadPage,
    navigationLoadedOwner,
    ownerKey,
    readOwnerKey,
    onAuthorizationLost,
    projects,
    team.id,
    teamAuthorizedBySnapshot,
    user.id
  ]);
  useEffect(() => {
    if (!drafts || !authority || !draftReady) return;
    const value: StudioTeamDraft = {
      text: draftText,
      pendingSend,
      updatedAt: new Date().toISOString()
    };
    const persist = () =>
      revokedRef.current ? Promise.resolve() : drafts.save(authority, value);
    const timer = window.setTimeout(
      () =>
        void persist().catch(() =>
          setError("Draft could not be encrypted and saved.")
        ),
      200
    );
    return () => {
      window.clearTimeout(timer);
      void persist().catch(() => undefined);
    };
  }, [authority, authorityKey, draftText, drafts, draftReady, pendingSend]);
  useEffect(() => {
    const capturedOwnerKey = ownerKey;
    const unsubscribe = client.subscribeTeam(
      team.id,
      async (event) => {
        const resource = event.resource;
        const currentThreadId = selectedThreadRef.current;
        const update = event.update;
        const capturedAuthorityKey = authorityKeyRef.current;
        const capturedRoot = openRootRef.current;
        if (
          update &&
          typeof update === "object" &&
          "type" in update &&
          (update.type === "message_created" ||
            update.type === "message_updated") &&
          "message" in update &&
          update.message &&
          typeof update.message === "object"
        ) {
          const message = update.message as CollaborationMessage;
          if (
            message.teamId === team.id &&
            message.threadId === currentThreadId &&
            navigationOwner.current === capturedOwnerKey &&
            authorityKeyRef.current === capturedAuthorityKey
          ) {
            setMessages((current) => mergeTeamMessages(current, [message]));
            if (
              capturedRoot &&
              capturedRoot.teamId === team.id &&
              capturedRoot.threadId === currentThreadId &&
              openRootRef.current?.id === capturedRoot.id
            ) {
              if (
                message.id === capturedRoot.id &&
                message.rootMessageId === null
              )
                setOpenRootMessage((current) =>
                  current?.id === capturedRoot.id ? message : current
                );
              else if (message.rootMessageId === capturedRoot.id)
                setThreadReplies((current) =>
                  mergeTeamMessages(current, [message])
                );
            }
          }
        }
        if (
          update &&
          typeof update === "object" &&
          "type" in update &&
          update.type === "public_square_invalidated"
        ) {
          if ("teamId" in update && update.teamId === team.id) {
            await refreshSquare();
          }
        }
        if (
          update &&
          typeof update === "object" &&
          "type" in update &&
          update.type === "team_agent_request_invalidated" &&
          "teamId" in update &&
          update.teamId === team.id &&
          "kind" in update
        ) {
          if (update.kind === "offers") {
            setAgentOfferRevision((revision) => revision + 1);
            await refreshSquare();
          } else setAgentRequestRevision((revision) => revision + 1);
        }
        if (
          resource &&
          typeof resource === "object" &&
          "threadId" in resource &&
          resource.threadId === currentThreadId
        )
          await loadPage(currentThreadId);
        await refreshNavigation();
      },
      handleAuthorizationLost,
      (connected) => {
        if (
          mountedRef.current &&
          navigationOwner.current === capturedOwnerKey &&
          !revokedRef.current
        ) {
          realtimeConnectedOwner.current = connected ? capturedOwnerKey : "";
          setRealtimeConnection({ owner: capturedOwnerKey, connected });
          if (connected) retryPendingThreadReply();
        }
      }
    );
    return () => {
      unsubscribe();
      if (realtimeConnectedOwner.current === capturedOwnerKey)
        realtimeConnectedOwner.current = "";
    };
  }, [
    client,
    handleAuthorizationLost,
    loadPage,
    refreshNavigation,
    refreshSquare,
    team.id,
    ownerKey
  ]);
  useEffect(() => {
    if (
      !navigationReady ||
      !activeThread ||
      !visibleRead ||
      visibleRead.teamId !== team.id ||
      visibleRead.threadId !== activeThread.id ||
      !document.hasFocus() ||
      document.visibilityState !== "visible" ||
      visibleRead.sequence <= readCursor ||
      visibleRead.sequence <= 0
    )
      return;
    const capturedOwnerKey = `${user.id}:${team.id}`;
    const capturedReadOwnerKey = readOwnerKey;
    const capturedThreadId = activeThread.id;
    const capturedReadEpoch = readSelectionRef.current.epoch;
    void client
      .markRead(team.id, capturedThreadId, visibleRead.id)
      .then(() => {
        if (
          navigationOwner.current === capturedOwnerKey &&
          selectedThreadRef.current === capturedThreadId &&
          readSelectionRef.current.ownerKey === capturedReadOwnerKey &&
          readSelectionRef.current.threadId === capturedThreadId &&
          readSelectionRef.current.epoch === capturedReadEpoch
        )
          setReadCursor(visibleRead.sequence);
      })
      .catch(() => undefined);
  }, [
    activeThread,
    client,
    navigationReady,
    readOwnerKey,
    readCursor,
    team.id,
    user.id,
    visibleRead
  ]);

  const send = async (body: string) => {
    if (!activeThread || !authority || !drafts || !draftReady) return false;
    if (visiblePendingSend) {
      setError("Resolve the earlier send before sending edited text.");
      return false;
    }
    const capturedAuthority = authority;
    const capturedKey = authorityKey;
    const capturedTeamId = team.id;
    const capturedOwnerKey = `${user.id}:${team.id}`;
    const capturedThreadId = activeThread.id;
    if (!capturedKey) return false;
    const identity = {
      clientMessageId: crypto.randomUUID(),
      body,
      createdAt: new Date().toISOString()
    };
    draftByAuthority.current.set(capturedKey, {
      text: "",
      pendingSend: identity
    });
    setPendingSend(identity);
    setDraftText("");
    let requestStarted = false;
    try {
      await drafts.save(capturedAuthority, { text: "", pendingSend: identity });
      if (
        revokedRef.current ||
        !mountedRef.current ||
        navigationOwner.current !== capturedOwnerKey
      )
        return false;
      requestStarted = true;
      const receipt = await client.sendMessage(
        capturedTeamId,
        capturedThreadId,
        identity.body,
        identity.clientMessageId
      );
      const message = receipt.message;
      if (receipt.acceptedBody !== identity.body)
        throw new HostedTeamRequestError(
          "The accepted message body did not match this pending send.",
          502
        );
      if (
        revokedRef.current ||
        !mountedRef.current ||
        navigationOwner.current !== capturedOwnerKey
      )
        return false;
      const currentlySelected =
        navigationOwner.current === capturedOwnerKey &&
        studioSelectionMatches(
          { teamId: capturedTeamId, threadId: capturedThreadId },
          { teamId: team.id, threadId: selectedThreadRef.current }
        );
      if (currentlySelected)
        setMessages((current) => mergeTeamMessages(current, [message]));
      const latest = draftByAuthority.current.get(capturedKey) ?? {
        text: "",
        pendingSend: identity
      };
      const settled = resolvePendingSend(
        latest,
        identity.clientMessageId,
        "accepted",
        identity.body
      );
      draftByAuthority.current.set(capturedKey, settled);
      try {
        await drafts.save(capturedAuthority, settled);
      } catch {
        if (currentlySelected && authorityKey === capturedKey)
          setError(
            "Message sent. The edited draft update could not be saved in this browser."
          );
        return;
      }
      if (currentlySelected && authorityKey === capturedKey) {
        setPendingSend(settled.pendingSend);
        setDraftText(settled.text);
        setError(null);
      }
      return message.delivery === "sent";
    } catch (failure) {
      if (
        !mountedRef.current ||
        revokedRef.current ||
        navigationOwner.current !== capturedOwnerKey
      )
        return false;
      const latest = draftByAuthority.current.get(capturedKey) ?? {
        text: "",
        pendingSend: identity
      };
      const definitiveRejection =
        failure instanceof HostedTeamRequestError &&
        [400, 404, 422].includes(failure.status);
      const settled =
        requestStarted && !definitiveRejection
          ? retainPendingSendAfterUncertainOutcome(latest, identity)
          : resolvePendingSend(
              latest,
              identity.clientMessageId,
              "not-sent",
              body
            );
      draftByAuthority.current.set(capturedKey, settled);
      await drafts.save(capturedAuthority, settled).catch(() => undefined);
      if (
        navigationOwner.current === capturedOwnerKey &&
        studioSelectionMatches(
          { teamId: capturedTeamId, threadId: capturedThreadId },
          { teamId: team.id, threadId: selectedThreadRef.current }
        ) &&
        authorityKey === capturedKey
      ) {
        setPendingSend(settled.pendingSend);
        setDraftText(settled.text);
      }
      if (
        failure instanceof HostedTeamRequestError &&
        [401, 403].includes(failure.status)
      )
        handleAuthorizationLost();
      else if (
        studioSelectionMatches(
          { teamId: capturedTeamId, threadId: capturedThreadId },
          { teamId: team.id, threadId: selectedThreadRef.current }
        ) &&
        authorityKey === capturedKey
      )
        setError(
          requestStarted
            ? "Send status is unknown. Retry the original send identity before sending another message."
            : "Not sent. The draft is saved on this device; retry after reconnecting."
        );
      return false;
    }
  };

  const completeAgentMention = async (
    intent: NonNullable<typeof pendingAgentMention>,
    teamProjectId: string,
    rootMessageId: string | null = null
  ): Promise<boolean> => {
    const targetRootMessageId = rootMessageId ?? intent.rootMessageId ?? null;
    const capturedTeamId = team.id;
    const capturedThreadId = activeThread?.id;
    if (
      targetRootMessageId &&
      openRootRef.current?.id !== targetRootMessageId
    ) {
      setError(
        "This Agent request belongs to a different message thread. Reopen that thread to continue."
      );
      return false;
    }
    setAgentMentionBusy(true);
    setError(null);
    try {
      if (intent.agent.kind === "colleague") {
        await teamAgentRequestsClient.createRequest(capturedTeamId, {
          idempotencyKey: intent.idempotencyKey,
          teamProjectId,
          channelId: capturedThreadId ?? "",
          ...(targetRootMessageId
            ? { rootMessageId: targetRootMessageId }
            : {}),
          agentId: intent.agent.id,
          requestText: intent.text
        });
        setAgentRequestRevision((revision) => revision + 1);
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
      if (connection.localProjectId === null) {
        setError(
          "Connect this Team Project to a local Project in Public Square before opening your Agent."
        );
        return false;
      }
      const sent = targetRootMessageId
        ? await sendThreadReply(intent.text)
        : await send(intent.text);
      if (!sent) return false;
      if (
        team.id !== capturedTeamId ||
        selectedThreadRef.current !== capturedThreadId
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
            recentMessages: (targetRootMessageId && openRootMessage
              ? [openRootMessage, ...threadReplies]
              : visibleMessages
            ).map((message) => ({
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
      setError(
        failure instanceof Error
          ? failure.message
          : "The Agent request could not be completed."
      );
      return false;
    } finally {
      setAgentMentionBusy(false);
    }
  };

  const sendThreadComposer = async (
    text: string,
    selection: ChatComposerSelection
  ) => {
    if (!selection.agentId) {
      await sendThreadReply(text);
      return;
    }
    const agent = teamAgentMentions.options.find(
      (candidate) => candidate.id === selection.agentId
    );
    const root = openRootRef.current;
    if (!agent || !root) {
      setError("This Agent cannot be routed from the selected thread.");
      return;
    }
    const intent = {
      agent,
      text,
      idempotencyKey: crypto.randomUUID(),
      rootMessageId: root.id
    };
    if (activeThread?.kind === "team_project_channel") {
      await completeAgentMention(intent, activeThread.teamProjectId, root.id);
    } else if (visibleProjects.length === 0) {
      setError("Share a Team Project before requesting an Agent.");
    } else {
      setPendingAgentMention(intent);
    }
  };

  const sendTeamComposer = async (
    text: string,
    selection: ChatComposerSelection
  ) => {
    if (!selection.agentId || activeDirectMessage) {
      if (await send(text)) {
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
      setError(
        "This Agent is no longer available. Refresh Team Agents and try again."
      );
      return;
    }
    const intent = { agent, text, idempotencyKey: crypto.randomUUID() };
    if (activeThread?.kind === "team_project_channel") {
      await completeAgentMention(intent, activeThread.teamProjectId);
    } else {
      if (visibleProjects.length === 0) {
        setError("Share a Team Project before requesting an Agent.");
        return;
      }
      setPendingAgentMention(intent);
    }
  };

  const reconcile = async () => {
    if (!pendingSend || !activeThread || !authority || !drafts) return;
    const pending = pendingSend;
    const capturedAuthority = authority;
    const capturedKey = authorityKey;
    const capturedThreadId = activeThread.id;
    const capturedOwnerKey = `${user.id}:${team.id}`;
    try {
      const receipt = await client.sendMessage(
        team.id,
        capturedThreadId,
        pending.body,
        pending.clientMessageId
      );
      const message = receipt.message;
      if (receipt.acceptedBody !== pending.body)
        throw new HostedTeamRequestError(
          "The accepted message body did not match this pending send.",
          502
        );
      if (
        revokedRef.current ||
        !mountedRef.current ||
        navigationOwner.current !== capturedOwnerKey
      )
        return;
      const currentlySelected =
        navigationOwner.current === capturedOwnerKey &&
        studioSelectionMatches(
          { teamId: team.id, threadId: capturedThreadId },
          { teamId: team.id, threadId: selectedThreadRef.current }
        );
      if (currentlySelected)
        setMessages((current) => mergeTeamMessages(current, [message]));
      const latest = draftByAuthority.current.get(capturedKey!) ?? {
        text: draftText,
        pendingSend: pending
      };
      const settled = resolvePendingSend(
        latest,
        pending.clientMessageId,
        "accepted",
        pending.body
      );
      draftByAuthority.current.set(capturedKey!, settled);
      try {
        await drafts.save(capturedAuthority, settled);
      } catch {
        if (currentlySelected && authorityKey === capturedKey)
          setError(
            "Message sent. The edited draft update could not be saved in this browser."
          );
        return;
      }
      if (currentlySelected && authorityKey === capturedKey) {
        setPendingSend(settled.pendingSend);
        setDraftText(settled.text);
        setError(null);
      }
    } catch (failure) {
      if (
        !mountedRef.current ||
        revokedRef.current ||
        navigationOwner.current !== capturedOwnerKey
      )
        return;
      if (
        failure instanceof HostedTeamRequestError &&
        [401, 403].includes(failure.status)
      )
        handleAuthorizationLost();
      else if (
        studioSelectionMatches(
          { teamId: team.id, threadId: capturedThreadId },
          { teamId: team.id, threadId: selectedThreadRef.current }
        ) &&
        authorityKey === capturedKey
      )
        setError(
          "Send status is still unknown. Keep the original send identity and try again."
        );
    }
  };

  const createChannel = async (name: string) => {
    const generation = navigationGeneration.current;
    try {
      const thread = await client.createChannel(
        team.id,
        name,
        null,
        crypto.randomUUID()
      );
      if (
        !studioRequestMayApply({
          capturedGeneration: generation,
          currentGeneration: navigationGeneration.current,
          mounted: mountedRef.current
        })
      )
        return;
      setChannels((current) => [
        ...current.filter((item) => item.id !== thread.id),
        thread
      ]);
      setThreadId(thread.id);
      setCreateOpen(false);
    } catch (failure) {
      if (
        !studioRequestMayApply({
          capturedGeneration: generation,
          currentGeneration: navigationGeneration.current,
          mounted: mountedRef.current
        })
      )
        return;
      if (
        failure instanceof HostedTeamRequestError &&
        [401, 403].includes(failure.status)
      ) {
        handleAuthorizationLost();
        return;
      }
      setError(
        failure instanceof Error ? failure.message : "Channel creation failed."
      );
    }
  };

  const startDirectMessage = async (participantUserIds: string[]) => {
    const generation = navigationGeneration.current;
    const ownerKey = `${user.id}:${team.id}`;
    const enabledMemberIds = new Set(
      people
        .filter((person) => person.membershipState === "enabled")
        .map((person) => person.id)
    );
    const participants = participantUserIds.slice().sort();
    if (
      !directMessageParticipantsAreEligible({
        principalUserId: user.id,
        participantUserIds: participants,
        enabledMemberIds
      })
    )
      throw new Error("Choose an enabled teammate to message.");
    const requestKey = directMessageAttemptKey(team.id, user.id, participants);
    const requestId =
      directMessageRequestIds.current.get(requestKey) ?? crypto.randomUUID();
    directMessageRequestIds.current.set(requestKey, requestId);
    try {
      const thread =
        participants.length === 1
          ? await client.startDirectMessage(team.id, participants[0], requestId)
          : await client.startGroupDirectMessage(
              team.id,
              participants,
              requestId
            );
      if (
        !studioRequestMayApply({
          capturedGeneration: generation,
          currentGeneration: navigationGeneration.current,
          mounted: mountedRef.current
        }) ||
        ownerKey !== `${user.id}:${team.id}` ||
        revokedRef.current
      )
        return;
      directMessageRequestIds.current.delete(requestKey);
      setDirectMessages((current) => [
        ...current.filter((item) => item.id !== thread.id),
        thread
      ]);
      setThreadId(thread.id);
      selectedThreadRef.current = thread.id;
      setError(null);
    } catch (failure) {
      if (
        failure instanceof HostedTeamRequestError &&
        [400, 404, 422].includes(failure.status)
      )
        directMessageRequestIds.current.delete(requestKey);
      if (
        failure instanceof HostedTeamRequestError &&
        [401, 403].includes(failure.status)
      )
        handleAuthorizationLost();
      throw failure;
    }
  };
  const updateDraft = (value: string) => {
    if (authorityKey && hydratedKey === authorityKey)
      draftByAuthority.current.set(authorityKey, { text: value, pendingSend });
    setDraftText(value);
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 bg-background">
      <SidebarProvider>
        <TeamChannelNavigation
          teamName={team.name}
          channels={activeThreads
            .filter(
              (thread) => thread.kind !== "dm" && thread.kind !== "group_dm"
            )
            .map((thread) => ({ id: thread.id, name: thread.name }))}
          people={visiblePeople.map((person) => ({
            id: person.id,
            name: person.displayName
          }))}
          principalUserId={user.id}
          directMessages={visibleDirectMessages.filter(
            (
              thread
            ): thread is Extract<
              CollaborationThread,
              { kind: "dm" | "group_dm" }
            > => thread.kind === "dm" || thread.kind === "group_dm"
          )}
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
            setThreadId(id);
          }}
          onCreate={() => {
            setForYouOpen(false);
            setSquareOpen(false);
            setCreateOpen(true);
          }}
          onNewDirectMessage={(participantIds) => {
            setForYouOpen(false);
            setSquareOpen(false);
            return startDirectMessage(participantIds);
          }}
        />
        <div className="relative min-h-0 min-w-0 flex-1">
          <TeamShell
            chatLayout={!forYouOpen && !squareOpen}
            heading={
              forYouOpen ? "For you" : squareOpen ? "Public Square" : undefined
            }
            wallpaper={!forYouOpen && (squareOpen || !activeDirectMessage)}
            crumbs={
              !forYouOpen && !squareOpen && activeDirectMessage
                ? [team.name, activeDirectMessageTitle]
                : undefined
            }
            subheader={
              !forYouOpen && !squareOpen && !activeDirectMessage ? (
                <ChannelHeader
                  channelName={activeThread?.name ?? "Select a channel"}
                  project={null}
                  agents={[]}
                  members={people
                    .filter((person) => person.membershipState === "enabled")
                    .map((person) => ({
                      id: person.id,
                      name: person.displayName
                    }))}
                />
              ) : undefined
            }
          >
            {forYouOpen ? (
              <TeamAgentRequestInbox
                key={`requests:${user.id}:${team.id}`}
                teamId={team.id}
                viewerId={user.id}
                authorityKey={`${typeof window === "undefined" ? "" : window.location.origin}:${user.id}:${team.id}`}
                refreshRevision={agentRequestRevision}
                client={teamAgentRequestsClient}
                onAuthorizationLost={handleAuthorizationLost}
                onReview={(request) => void openRequestReview(request)}
                onViewWork={openRequestWork}
              />
            ) : squareOpen ? (
              <PublicSquare
                viewerId={user.id}
                onOpenInbox={() => {
                  setSquareOpen(false);
                  setForYouOpen(true);
                }}
                onOpenOwnerConversation={(item) => {
                  if (
                    item.ownerId !== user.id ||
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
                key={`${user.id}:${team.id}`}
                teamName={team.name}
                teamId={team.id}
                focusJobId={focusSquareJobId}
                authorityKey={`${typeof window === "undefined" ? "" : window.location.origin}:${user.id}:${team.id}`}
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
                  team.membership.role === "owner" ||
                  team.membership.role === "admin"
                }
                onUnshareProject={square.unshareProject}
              />
            ) : (
              <>
                <div className="flex min-h-0 min-w-0 flex-1">
                  <div className="min-h-0 min-w-0 flex-1">
                    <SharedChatUI
                      mode={{ kind: "human", controls: "formatting" }}
                      scopeKey={`team:${authorityKey ?? "unselected"}`}
                      messages={sharedChannelMessages}
                      className="h-full"
                      viewportClassName="pt-4"
                      listClassName={`mx-auto min-w-0 max-w-3xl space-y-4 ${activeDirectMessage ? "" : "space-y-3"}`}
                      emptyState={
                        <p className="mx-auto max-w-3xl text-sm text-subtle">
                          {activeDirectMessage
                            ? `Private to ${activeDirectMessageTitle}. Agents are not in this thread.`
                            : "No messages yet. Start the conversation."}
                        </p>
                      }
                      composer={
                        !forYouOpen && !squareOpen ? (
                          <footer className="border-t border-border bg-background p-4">
                            <div className="mx-auto max-w-3xl no-drag">
                              {visiblePendingSend && (
                                <div className="mb-2 flex items-center justify-between rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-muted">
                                  <span>
                                    Previous send may have been accepted.
                                    Reconcile before retrying.
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => void reconcile()}
                                    className="font-medium text-foreground hover:underline"
                                  >
                                    Reconcile send
                                  </button>
                                </div>
                              )}
                              {pendingAgentMention &&
                                !pendingAgentMention.rootMessageId && (
                                  <div className="mb-2 rounded-lg border border-border bg-surface px-3 py-2">
                                    <p className="mb-2 text-xs text-subtle">
                                      Choose a Team Project for{" "}
                                      {pendingAgentMention.agent.name}.
                                    </p>
                                    <div className="flex flex-wrap gap-2">
                                      {visibleProjects.map((project) => (
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
                                        onClick={() =>
                                          setPendingAgentMention(null)
                                        }
                                        className="rounded-md px-2.5 py-1.5 text-xs text-subtle hover:bg-surface-hover"
                                      >
                                        Cancel
                                      </button>
                                    </div>
                                  </div>
                                )}
                              <ChatComposer
                                placeholder={
                                  activeDirectMessage
                                    ? `Message ${activeDirectMessageTitle}`
                                    : `Message #${activeThread?.name ?? "channel"}`
                                }
                                projectName={
                                  activeDirectMessage
                                    ? team.name
                                    : (activeThread?.name ?? team.name)
                                }
                                branch="shared"
                                value={visibleDraftText}
                                onChange={updateDraft}
                                onSend={(text, selection) =>
                                  sendTeamComposer(text, selection)
                                }
                                agents={
                                  activeDirectMessage
                                    ? []
                                    : teamAgentMentions.options
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
                                  drafts &&
                                  hydrated &&
                                  hydratedKey === authorityKey
                                )}
                                footer={
                                  visiblePendingSend
                                    ? "Resolve the previous send before sending this edit."
                                    : activeDirectMessage
                                      ? "Direct messages stay among these people."
                                      : "Your @Agent message is sent to this channel; the private chat opens with a bounded quote and a prompt to discuss before work starts."
                                }
                              />
                            </div>
                          </footer>
                        ) : null
                      }
                      renderMessage={(sharedMessage) => {
                        const message = sharedMessage.source;
                        return (
                          <HostedMessage
                            message={message}
                            forwardRequests={
                              !activeDirectMessage &&
                              message.sender.id !== user.id
                                ? forwardableTeamRequestsForChannelMessage({
                                    requests: channelRequests,
                                    message,
                                    viewerId: user.id,
                                    teamId: team.id
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
                            onReplyInThread={
                              activeDirectMessage
                                ? undefined
                                : () => openMessageThread(message)
                            }
                            onEditMessage={
                              !activeDirectMessage &&
                              connected &&
                              message.sender.id === user.id
                                ? () => {
                                    openMessageThread(message);
                                    void startThreadEdit(message);
                                  }
                                : undefined
                            }
                            onToggleReaction={
                              !activeDirectMessage && connected
                                ? toggleThreadReaction
                                : undefined
                            }
                            principalUserId={user.id}
                            directMessagePrincipalUserId={
                              activeDirectMessage ? user.id : undefined
                            }
                            onVisible={() => {
                              if (
                                message.sender.id !== user.id &&
                                activeThread?.id === message.threadId &&
                                selectedThreadRef.current ===
                                  message.threadId &&
                                message.teamId === team.id &&
                                document.visibilityState === "visible" &&
                                document.hasFocus()
                              ) {
                                setVisibleRead((current) =>
                                  !current ||
                                  message.sequence > current.sequence
                                    ? {
                                        id: message.id,
                                        sequence: message.sequence,
                                        teamId: team.id,
                                        threadId: message.threadId
                                      }
                                    : current
                                );
                              }
                            }}
                          />
                        );
                      }}
                    >
                      {!activeDirectMessage && activeThread && (
                        <TeamChannelAgentRequests
                          teamId={team.id}
                          channelId={activeThread.id}
                          viewerId={user.id}
                          authorityKey={`${typeof window === "undefined" ? "" : window.location.origin}:${user.id}:${team.id}`}
                          refreshRevision={agentRequestRevision}
                          client={teamAgentRequestsClient}
                          onAuthorizationLost={handleAuthorizationLost}
                          onReview={(request) =>
                            void openRequestReview(request)
                          }
                          onViewWork={openRequestWork}
                          onRequestsChanged={setChannelRequests}
                          originRootMessageId={null}
                        />
                      )}
                      {visiblePage && hasOlder && beforeSequence && (
                        <button
                          type="button"
                          onClick={() =>
                            activeThread &&
                            void loadPage(activeThread.id, beforeSequence)
                          }
                          className="mx-auto block text-xs text-muted hover:text-foreground"
                        >
                          Load older messages
                        </button>
                      )}
                    </SharedChatUI>
                  </div>
                  {!activeDirectMessage && visibleOpenRoot && (
                    <TeamMessageThreadPane
                      key={`${authorityKey}:${visibleOpenRoot.id}`}
                      root={visibleOpenRoot}
                      replies={threadReplies}
                      hasOlderReplies={threadHasOlder}
                      principalUserId={user.id}
                      connected={connected}
                      replyDraft={threadDraftText}
                      pendingSend={threadPendingSend}
                      pendingStatus={threadSendStatus}
                      editDrafts={threadEditDrafts}
                      agents={teamAgentMentions.options}
                      agentRequests={
                        activeThread &&
                        activeThread.kind !== "dm" &&
                        activeThread.kind !== "group_dm" ? (
                          <>
                            <TeamChannelAgentRequests
                              key={`thread-requests:${authorityKey}:${visibleOpenRoot.id}`}
                              teamId={team.id}
                              channelId={activeThread.id}
                              originRootMessageId={visibleOpenRoot.id}
                              viewerId={user.id}
                              authorityKey={`${typeof window === "undefined" ? "" : window.location.origin}:${user.id}:${team.id}:root:${visibleOpenRoot.id}`}
                              refreshRevision={agentRequestRevision}
                              client={teamAgentRequestsClient}
                              onAuthorizationLost={handleAuthorizationLost}
                              onReview={(request) =>
                                void openRequestReview(request)
                              }
                              onViewWork={openRequestWork}
                              onRequestsChanged={setThreadRequests}
                            />
                            {pendingAgentMention?.rootMessageId ===
                              visibleOpenRoot.id && (
                              <div className="border-b border-border px-3 py-2">
                                <p className="mb-2 text-xs text-subtle">
                                  Choose a Team Project for{" "}
                                  {pendingAgentMention.agent.name}.
                                </p>
                                <div className="flex flex-wrap gap-2">
                                  {visibleProjects.map((project) => (
                                    <button
                                      key={project.id}
                                      type="button"
                                      disabled={agentMentionBusy}
                                      onClick={() =>
                                        void completeAgentMention(
                                          pendingAgentMention,
                                          project.id,
                                          visibleOpenRoot.id
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
                          </>
                        ) : undefined
                      }
                      forwardRequestsByMessage={Object.fromEntries(
                        threadReplies.map((message) => [
                          message.id,
                          forwardableTeamRequestsForReply({
                            requests: threadRequests,
                            message,
                            viewerId: user.id,
                            teamId: team.id,
                            threadId: visibleOpenRoot.threadId,
                            rootMessageId: visibleOpenRoot.id
                          })
                        ])
                      )}
                      forwardRequestTextById={Object.fromEntries(
                        threadRequests.map((request) => [
                          request.id,
                          visibleOpenRoot.body
                        ])
                      )}
                      onClose={() => {
                        setOpenRootMessage(null);
                        openRootRef.current = null;
                        setOpenRootAuthorityKey(null);
                        setThreadReplies([]);
                      }}
                      onReplyDraftChange={updateThreadDraft}
                      onSendReply={(text, selection) =>
                        sendThreadComposer(text, selection)
                      }
                      onRetryPending={async () => {
                        if (threadPendingSend)
                          await sendThreadReply(
                            threadPendingSend.body,
                            threadPendingSend.clientMessageId
                          );
                      }}
                      onStartEdit={(message) => void startThreadEdit(message)}
                      onCancelEdit={cancelThreadEdit}
                      onEditDraftChange={(message, text) => {
                        const current = threadEditDrafts.get(message.id);
                        if (current)
                          persistThreadEdit(message, { ...current, text });
                      }}
                      onSaveEdit={(message, draft) =>
                        void saveThreadEdit(message, draft)
                      }
                      onReviewEditConflict={(message) =>
                        void reviewThreadEdit(message)
                      }
                      onToggleReaction={(message, emoji) =>
                        void toggleThreadReaction(message, emoji)
                      }
                      onForwardAnswer={(request, message) =>
                        void forwardChannelAnswer(request, message)
                      }
                      onReplyVisible={markThreadReplyVisible}
                      onLoadOlderReplies={() =>
                        visibleOpenRoot &&
                        threadBeforeSequence !== null &&
                        void loadRootReplies(
                          visibleOpenRoot,
                          threadBeforeSequence
                        )
                      }
                    />
                  )}
                </div>
                {error && (
                  <p
                    role="status"
                    className="mx-auto w-full max-w-3xl pt-2 text-xs text-warning"
                  >
                    {error}
                  </p>
                )}
              </>
            )}
          </TeamShell>
        </div>
      </SidebarProvider>
      {createOpen && (
        <CreateChannelModal
          teamName={team.name}
          existingNames={activeThreads.map(
            (item) => item.name?.toLowerCase() ?? ""
          )}
          onClose={() => setCreateOpen(false)}
          onCreateChat={(name) => void createChannel(name)}
          projectDisabledReason="Choose a local folder in the Koed Studio desktop app to create a Shared Project channel."
        />
      )}
    </div>
  );
}

function HostedMessage({
  message,
  onVisible,
  onReplyInThread,
  onEditMessage,
  onToggleReaction,
  principalUserId = "",
  directMessagePrincipalUserId,
  forwardRequests = [],
  forwardRequestTextById = {},
  onForwardAnswer
}: {
  message: CollaborationMessage;
  onVisible: () => void;
  onReplyInThread?: () => void;
  onEditMessage?: (message: CollaborationMessage) => void;
  onToggleReaction?: (
    message: CollaborationMessage,
    emoji: string
  ) => void | Promise<void>;
  principalUserId?: string;
  directMessagePrincipalUserId?: string;
  forwardRequests?: TeamAgentRequest[];
  forwardRequestTextById?: Record<string, string>;
  onForwardAnswer?: (request: TeamAgentRequest) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (
          entry?.isIntersecting &&
          document.visibilityState === "visible" &&
          document.hasFocus()
        )
          onVisible();
      },
      { threshold: 0.6 }
    );
    observer.observe(element);
    const focused = () => {
      const bounds = element.getBoundingClientRect();
      if (
        document.visibilityState === "visible" &&
        document.hasFocus() &&
        bounds.bottom > 0 &&
        bounds.top < window.innerHeight
      )
        onVisible();
    };
    window.addEventListener("focus", focused);
    document.addEventListener("visibilitychange", focused);
    return () => {
      observer.disconnect();
      window.removeEventListener("focus", focused);
      document.removeEventListener("visibilitychange", focused);
    };
  }, [onVisible]);
  const isDirectMessage = directMessagePrincipalUserId !== undefined;
  const isYou =
    isDirectMessage && message.sender.id === directMessagePrincipalUserId;
  return (
    <article
      ref={ref}
      data-message-id={message.id}
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
          principalUserId={directMessagePrincipalUserId ?? ""}
        />
      ) : (
        <TeamChannelMessageContent
          message={message}
          principalUserId={principalUserId}
          variant="hosted"
          onReply={onReplyInThread}
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
