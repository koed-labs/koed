import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode
} from "react";
import {
  sessionSelectionId,
  type DesktopProject
} from "../../project-memory-ui.js";
import type { PersonalMemoryStore } from "../state/personal-memory.js";
import type { ManagedConversationLifecycle } from "../state/use-managed-conversation-lifecycle.js";
import type { ManagedConversationDesktopApi } from "../../ipc/managed-conversation-protocol.js";
import type { ProjectHqConversationDesktopApi } from "../../ipc/project-hq-conversation-protocol.js";
import type { PersonalDesktopProjectThread } from "@koed/shared/personal-desktop";
import {
  parseKoedTextActionArguments,
  type KoedTextActionProjection
} from "@koed/shared/koed-text-action-contract";
import type { PersonalDesktopApi } from "@koed/shared/personal-desktop";
import type { ManagedProjectDesktopApi } from "../../ipc/managed-project-protocol.js";
import type { ProjectsDesktopApi } from "../../ipc/projects-protocol.js";
import { ProjectsStore } from "./useProjects.js";
import { AgentsStore } from "./agents/agents-store.js";
import { HqOnboarding } from "./onboarding/HqOnboarding.js";
import {
  hqSuggestedProjectName,
  readHqOnboarding
} from "./onboarding/onboarding-preference.js";
import { visibleHqProjects } from "./project-navigation.js";
import type { MarkdownPlatformAdapters } from "@koed/memory-ui";
import type {
  CollaborationActionGrantProjection,
  CollaborationRendererClient
} from "../../collaboration/renderer-client.js";
import type { DesktopApi } from "../../types.js";
import {
  HqActiveConversation,
  HqBlankConversation
} from "./conversation/HqConversation.js";
import {
  findHqConversationDraft,
  withPendingHqConversations
} from "./conversation/hq-conversation-threads.js";
import { HqShell, type HqShellActions } from "./HqShell.js";
import { HqSidebar, type HqAccountIdentity } from "./HqSidebar.js";
import {
  HqChatDeleteControls,
  type ChatDeleteNotice,
  type ChatDeleteRequest
} from "./HqChatDeleteControls.js";
import { HqSearch } from "./HqSearch.js";
import { hqLayoutCommands, type HqCommand } from "./hq-command-palette.js";
import { HqSettings, hqSettingsShortcut } from "./settings/HqSettings.js";
import type {
  HqSettingsProps,
  HqSettingsSection
} from "./settings/HqSettings.js";
import { reconcileHqRoute, type HqRoute } from "./hq-navigation.js";
import { usePersonalProjectsLoader } from "./use-personal-projects-loader.js";
import { useProjectMenuActions } from "./useProjectMenuActions.js";
import { NowView } from "./now/NowView.js";
import { HqProjectConversation } from "./project/HqProjectConversation.js";
import { HqProjectThread } from "./project/HqProjectThread.js";
import { Pixelkin } from "./agents/Pixelkin.js";
import type { ProjectThreadV2 } from "@koed/shared/project-thread-contract";
import "./project/hq-project-context-tabs.css";
import { HqProjectView } from "./project/HqProjectView.js";
import { SharedProjectStore } from "./shared-project/shared-project-store.js";
import { HqShareSheet } from "./share-project/HqShareSheet.js";
import { nowConversationDestination, type NowNeed } from "./now/now-model.js";
import { PERSONAL_DESKTOP_INITIAL_EVENT_LIMIT } from "@koed/shared/personal-desktop";
import {
  resolveHqCitationMessageTarget,
  type HqCitationMessageTarget
} from "./conversation/hq-citation-message-target.js";

const subscribeEmpty = () => () => undefined;
const emptySnapshot = () => null;
const emptyApprovals: readonly CollaborationActionGrantProjection[] = [];
const approvalsEmptySnapshot = () => emptyApprovals;
const emptyPersonalProjects: readonly import("@koed/shared").Project[] = [];

export function HqApplication({
  personalMemoryStore,
  personalMemoryReady,
  personalMemoryApi,
  projectsApi,
  agentsApi,
  visibilityClient,
  visibilityOwnerId,
  visibilityProfileKey,
  visibilityRevision,
  visibilityConnected,
  renderSettings,
  accountIdentity,
  managedConversations,
  projectHqConversation,
  managedProject,
  managedConversationLifecycle,
  markdownAdapters,
  onResolveIndependent,
  authorizeManagedConversationTransfer,
  localAiClients,
  projectTeamTabRequest,
  onProjectTeamUnreadChange,
  catchUpEnabled = true
}: {
  personalMemoryStore: PersonalMemoryStore | null;
  personalMemoryReady: boolean;
  personalMemoryApi?: PersonalDesktopApi;
  projectsApi?: ProjectsDesktopApi | null;
  agentsApi?: DesktopApi["agents"];
  visibilityClient?: CollaborationRendererClient;
  visibilityOwnerId?: string | null;
  visibilityProfileKey?: string | null;
  visibilityRevision?: string | null;
  visibilityConnected?: boolean;
  renderSettings?: (
    onClose: () => void,
    onChatRestored?: (sessionId: string, batchId: string | null) => void,
    initialSection?: HqSettingsSection
  ) => ReactNode;
  accountIdentity?: HqAccountIdentity;
  managedConversations?: ManagedConversationDesktopApi | null;
  projectHqConversation?: ProjectHqConversationDesktopApi | null;
  managedProject?: ManagedProjectDesktopApi | null;
  managedConversationLifecycle?: ManagedConversationLifecycle;
  markdownAdapters?: MarkdownPlatformAdapters;
  onResolveIndependent?: () => Promise<DesktopProject | null>;
  authorizeManagedConversationTransfer?: CollaborationRendererClient["authorizeManagedConversationTransfer"];
  localAiClients?: DesktopApi["localAiClients"];
  projectTeamTabRequest?: {
    personalProjectId: string;
    workspaceProjectId: string;
    teamBackendId: string;
    nonce: string;
  } | null;
  onProjectTeamUnreadChange?: (value: {
    personalProjectId: string;
    workspaceProjectId: string;
    teamBackendId: string;
    unreadCount: number;
    latestSequence: number;
    lastReadSequence: number;
  }) => void;
  catchUpEnabled?: boolean;
}) {
  const [selection, setSelection] = useState<{
    route: HqRoute;
    project?: DesktopProject;
  }>({ route: { kind: "home" } });
  const [searchOpen, setSearchOpen] = useState(false);
  const [shareProjectId, setShareProjectId] = useState<string | null>(null);
  useEffect(() => {
    setShareProjectId(null);
  }, [visibilityOwnerId, visibilityProfileKey]);
  const [citationFocus, setCitationFocus] = useState<{
    projectId: string;
    sessionId: string;
    eventId: string;
    generation: number;
  } | null>(null);
  const [focusDueItem, setFocusDueItem] = useState<{
    projectId: string;
    itemId: string;
  } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [onboardingRevision, setOnboardingRevision] = useState(0);
  const [settingsSection, setSettingsSection] =
    useState<HqSettingsSection>("general");
  const [chatDeleteRequest, setChatDeleteRequest] =
    useState<ChatDeleteRequest | null>(null);
  const [chatDeleteNotice, setChatDeleteNotice] =
    useState<ChatDeleteNotice | null>(null);
  const [chatDeleteBusy, setChatDeleteBusy] = useState(false);
  const [pendingChatDeletionIds, setPendingChatDeletionIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [moveNotice, setMoveNotice] = useState<{
    sessionId: string;
    fromProjectId: string | null;
    toProjectId: string | null;
    message: string;
    undoable: boolean;
    pending?: boolean;
    moveBatchId?: string;
  } | null>(null);
  const [revealProject, setRevealProject] = useState<{
    id: string;
    token: number;
  } | null>(null);
  const moveNoticeRef = useRef(moveNotice);
  moveNoticeRef.current = moveNotice;
  const moveBusyRef = useRef(false);
  const moveEpoch = useRef(0);
  const chatIntentEpoch = useRef(0);
  const chatBusyRef = useRef(false);
  const chatAuthority = useRef({
    ownerId: visibilityOwnerId,
    profileKey: visibilityProfileKey
  });
  chatAuthority.current = {
    ownerId: visibilityOwnerId,
    profileKey: visibilityProfileKey
  };
  const chatRequestRef = useRef(chatDeleteRequest);
  chatRequestRef.current = chatDeleteRequest;
  const chatNoticeRef = useRef(chatDeleteNotice);
  chatNoticeRef.current = chatDeleteNotice;
  const chatToken = () => ({
    ownerId: visibilityOwnerId,
    profileKey: visibilityProfileKey,
    epoch: chatIntentEpoch.current
  });
  const chatCurrent = (token: ReturnType<typeof chatToken>) =>
    chatIntentEpoch.current === token.epoch &&
    chatAuthority.current.ownerId === token.ownerId &&
    chatAuthority.current.profileKey === token.profileKey;
  useEffect(() => {
    chatIntentEpoch.current++;
    chatBusyRef.current = false;
    setChatDeleteBusy(false);
    setChatDeleteRequest(null);
    setChatDeleteNotice(null);
    setPendingChatDeletionIds(new Set());
    moveEpoch.current++;
    moveBusyRef.current = false;
    setMoveNotice(null);
    setRevealProject(null);
  }, [visibilityOwnerId, visibilityProfileKey]);
  useEffect(() => {
    if (!personalMemoryApi?.listPendingSessionDeletions) return;
    let active = true;
    const token = chatToken();
    void personalMemoryApi
      .listPendingSessionDeletions()
      .then((operations) => {
        if (active && chatCurrent(token)) {
          setPendingChatDeletionIds(
            new Set(operations.map((item) => item.sessionId))
          );
          if (operations[0])
            setChatDeleteNotice(
              (current) =>
                current ?? {
                  kind: "pending",
                  sessionId: operations[0]!.sessionId,
                  batchId: operations[0]!.batchId,
                  message:
                    "Deletion pending. Koed will finish after the source freeze and running work complete."
                }
            );
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [personalMemoryApi, visibilityOwnerId, visibilityProfileKey]);
  useEffect(() => {
    if (!personalMemoryApi?.listPendingSessionForgets) return;
    let active = true;
    const token = chatToken();
    void personalMemoryApi
      .listPendingSessionForgets()
      .then((operations) => {
        if (active && chatCurrent(token) && operations[0])
          setChatDeleteNotice(
            (current) =>
              current ?? {
                kind: "forget_pending",
                sessionId: operations[0]!.sessionId,
                batchId: operations[0]!.batchId,
                message:
                  "Forget pending. Koed is stopping the agent before removing Personal recall."
              }
          );
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [personalMemoryApi, visibilityOwnerId, visibilityProfileKey]);
  const [blankOpen, setBlankOpen] = useState(false);
  const [inventoryTarget, setInventoryTarget] = useState<NowNeed | null>(null);
  const [blankProjectId, setBlankProjectId] = useState<string | null>(null);
  const [blankProjectError, setBlankProjectError] = useState("");
  const [blankIntent, setBlankIntent] = useState(0);
  const [blankLaunchPending, setBlankLaunchPending] = useState(false);
  const [attachAfterStart, setAttachAfterStart] = useState<string | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [sharedRefreshSignal, setSharedRefreshSignal] = useState(0);
  const [artifactContext, setArtifactContext] = useState<string | null>(null);
  const [documentWorkItemIntent, setDocumentWorkItemIntent] = useState<{
    id: string;
    projectId: string;
    ownerId: string | null;
    profileKey: string | null;
    prompt: string;
    sourceId: string;
  } | null>(null);
  const [nowMemoryOpen, setNowMemoryOpen] = useState(false);
  const [nowMemoryHost, setNowMemoryHost] = useState<HTMLDivElement | null>(
    null
  );
  const [closeInspectorSignal, setCloseInspectorSignal] = useState(0);
  const [sourcesPanelHost, setSourcesPanelHost] =
    useState<HTMLDivElement | null>(null);
  const shellActions = useRef<HqShellActions>(null);
  const [projectTab, setProjectTab] = useState<"hq" | "team">("hq");
  const [rightColumnVisible, setRightColumnVisible] = useState(true);
  const [documentVisible, setDocumentVisible] = useState(
    () => document.visibilityState === "visible"
  );
  useEffect(() => {
    const onVisibilityChange = () =>
      setDocumentVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);
  const [projectTeamUnread, setProjectTeamUnread] = useState({
    unreadCount: 0,
    latestSequence: 0,
    lastReadSequence: 0
  });
  const [projectTeamPeople, setProjectTeamPeople] = useState<
    ProjectThreadV2["people"]
  >([]);
  const [projectTeamHost, setProjectTeamHost] = useState<HTMLDivElement | null>(
    null
  );
  const [projectsStore] = useState(() =>
    projectsApi ? new ProjectsStore(projectsApi) : null
  );
  const [sharedProjectStore] = useState(() =>
    projectsApi ? new SharedProjectStore(projectsApi) : null
  );
  const [agentsStore] = useState(() =>
    agentsApi ? new AgentsStore(agentsApi) : null
  );
  const agentsSnapshot = useSyncExternalStore(
    agentsStore?.subscribe ?? subscribeEmpty,
    agentsStore?.current ?? emptySnapshot
  );
  useEffect(() => {
    agentsStore?.setOwner(
      visibilityOwnerId ?? null,
      visibilityProfileKey ?? null
    );
  }, [agentsStore, visibilityOwnerId, visibilityProfileKey]);
  useEffect(() => {
    projectsStore?.setOwner(
      visibilityOwnerId ?? null,
      visibilityProfileKey ?? null
    );
  }, [projectsStore, visibilityOwnerId, visibilityProfileKey]);
  useEffect(
    () =>
      visibilityClient?.subscribe((current, update) => {
        if (
          !projectsStore ||
          !visibilityOwnerId ||
          !visibilityProfileKey ||
          current.navigation.personalOwner.id !== visibilityOwnerId
        )
          return;
        const currentKey = `${current.connection.backendId ?? "local"}|${current.connection.connectedAt ?? ""}|${visibilityClient.currentRemoteUrl() ?? ""}`;
        if (currentKey !== visibilityProfileKey) return;
        if (update.authoritativeRecovery || update.kind === "connection") {
          setSharedRefreshSignal((value) => value + 1);
          void projectsStore.refresh();
          void personalMemoryStore?.loadProjects({ silent: true });
          return;
        }
        if (update.kind !== "realtime") return;
        setSharedRefreshSignal((value) => value + 1);
        const changed = update.realtimeUpdate;
        if (changed?.type === "project_changed") {
          projectsStore.projectChanged(
            visibilityOwnerId,
            visibilityProfileKey,
            changed.projectId,
            changed.project
          );
          void personalMemoryStore?.loadProjects({ silent: true });
        }
      }),
    [
      projectsStore,
      visibilityClient,
      visibilityOwnerId,
      visibilityProfileKey,
      personalMemoryStore
    ]
  );
  const personalProjectsSnapshot = useSyncExternalStore(
    projectsStore?.subscribe ?? subscribeEmpty,
    projectsStore?.current ?? emptySnapshot,
    projectsStore?.current ?? emptySnapshot
  );
  const personalProjects =
    projectsStore &&
    personalProjectsSnapshot?.ownerId === visibilityOwnerId &&
    personalProjectsSnapshot?.profileKey === visibilityProfileKey
      ? (personalProjectsSnapshot?.projects ?? emptyPersonalProjects)
      : emptyPersonalProjects;
  const [sharedPeopleCounts, setSharedPeopleCounts] = useState<
    Record<string, number>
  >({});
  const sharedRosterKey = personalProjects
    .filter((project) => project.workspaceProjectId && project.teamBackendId)
    .map(
      (project) =>
        `${project.id}:${project.workspaceProjectId}:${project.teamBackendId}`
    )
    .join("|");
  useEffect(() => {
    let active = true;
    setSharedPeopleCounts({});
    if (
      !projectsApi?.sharedMembers ||
      !visibilityOwnerId ||
      !visibilityProfileKey
    )
      return;
    const linked = personalProjects.filter(
      (project) => project.workspaceProjectId && project.teamBackendId
    );
    void Promise.all(
      linked.map(async (project) => {
        try {
          const roster = await projectsApi.sharedMembers!(
            project.workspaceProjectId!,
            project.teamBackendId!
          );
          return [project.id, roster.people.length] as const;
        } catch {
          return null;
        }
      })
    ).then((counts) => {
      if (active)
        setSharedPeopleCounts(
          Object.fromEntries(
            counts.filter(
              (item): item is readonly [string, number] => item !== null
            )
          )
        );
    });
    return () => {
      active = false;
    };
  }, [
    projectsApi,
    visibilityOwnerId,
    visibilityProfileKey,
    sharedRosterKey,
    sharedRefreshSignal
  ]);
  const chiefAgent =
    agentsSnapshot &&
    agentsSnapshot.ownerId === visibilityOwnerId &&
    agentsSnapshot.profileKey === visibilityProfileKey
      ? (agentsSnapshot.agents.find((agent) => agent.isChiefOfStaff) ?? null)
      : null;
  const ownedAgents =
    agentsSnapshot?.ownerId === visibilityOwnerId &&
    agentsSnapshot?.profileKey === visibilityProfileKey
      ? (agentsSnapshot?.agents ?? [])
      : [];
  const agentIdentity = `${visibilityOwnerId ?? ""}\0${visibilityProfileKey ?? ""}`;
  const [conversationAgentState, setConversationAgentState] = useState<{
    identity: string;
    projects: Record<string, Readonly<Record<string, string>>>;
  }>({ identity: "", projects: {} });
  const onConversationAgentsChange = useCallback(
    (projectId: string, bySession: Readonly<Record<string, string>>) => {
      setConversationAgentState((previous) => {
        const projects =
          previous.identity === agentIdentity ? previous.projects : {};
        if (
          previous.identity === agentIdentity &&
          JSON.stringify(projects[projectId] ?? {}) ===
            JSON.stringify(bySession)
        )
          return previous;
        return {
          identity: agentIdentity,
          projects: { ...projects, [projectId]: bySession }
        };
      });
    },
    [agentIdentity]
  );
  const conversationAgents = useMemo(() => {
    const result: Record<string, import("@koed/shared/agent-contract").Agent> =
      {};
    if (
      !agentsSnapshot ||
      conversationAgentState.identity !== agentIdentity ||
      agentsSnapshot?.ownerId !== visibilityOwnerId ||
      agentsSnapshot?.profileKey !== visibilityProfileKey
    )
      return result;
    for (const entries of Object.values(conversationAgentState.projects))
      for (const [sessionId, agentId] of Object.entries(entries)) {
        const agent = agentsSnapshot.agents.find(
          (agent) => agent.id === agentId
        );
        if (agent) result[sessionId] = agent;
      }
    return result;
  }, [
    conversationAgentState,
    agentIdentity,
    agentsSnapshot,
    visibilityOwnerId,
    visibilityProfileKey
  ]);
  const projectsAuthorityCurrent = Boolean(
    projectsStore &&
    personalProjectsSnapshot?.ownerId === visibilityOwnerId &&
    personalProjectsSnapshot?.profileKey === visibilityProfileKey
  );
  const firstClassLoaded =
    projectsAuthorityCurrent && Boolean(personalProjectsSnapshot?.loaded);
  const firstClassError =
    projectsAuthorityCurrent && Boolean(personalProjectsSnapshot?.error);
  const settingsReturnFocus = useRef<HTMLElement | null>(null);
  usePersonalProjectsLoader({
    personalMemoryReady,
    store: personalMemoryStore
  });
  const snapshot = useSyncExternalStore(
    personalMemoryStore?.subscribe ?? subscribeEmpty,
    personalMemoryStore?.current ?? emptySnapshot,
    personalMemoryStore?.current ?? emptySnapshot
  );
  const approvals = useSyncExternalStore(
    visibilityClient?.subscribeActionGrants ?? subscribeEmpty,
    visibilityClient?.currentActionGrants ?? approvalsEmptySnapshot,
    approvalsEmptySnapshot
  );
  const capturedProjects = useMemo(
    () =>
      snapshot?.projectOrder.flatMap((id) => {
        const project = snapshot.projectsById.get(id);
        return project ? [project] : [];
      }) ?? [],
    [snapshot]
  );
  const blockedConversationSessions = useMemo(() => {
    const blocked = new Set<string>();
    if (!projectsStore) return blocked;
    const active = new Set(personalProjects.map(({ id }) => id));
    for (const project of capturedProjects)
      for (const thread of project.threads)
        if (
          thread.conversationTrashedAt ||
          (thread.personalProjectId && !active.has(thread.personalProjectId))
        )
          blocked.add(`${project.id}\u0000${sessionSelectionId(thread)}`);
    return blocked;
  }, [capturedProjects, personalProjects, projectsStore]);
  const projects = useMemo(() => {
    const merged = withPendingHqConversations(
      capturedProjects,
      managedConversationLifecycle?.drafts
    );
    return projectsStore
      ? firstClassLoaded
        ? visibleHqProjects(personalProjects, capturedProjects, merged)
        : merged.map((project) => ({ ...project, threads: [] }))
      : merged;
  }, [
    capturedProjects,
    managedConversationLifecycle?.drafts,
    projectsStore,
    firstClassLoaded,
    personalProjects
  ]);
  const citationNavigationRef = useRef({
    generation: 0,
    ownerId: visibilityOwnerId,
    profileKey: visibilityProfileKey,
    api: personalMemoryApi,
    store: personalMemoryStore
  });
  if (
    citationNavigationRef.current.ownerId !== visibilityOwnerId ||
    citationNavigationRef.current.profileKey !== visibilityProfileKey ||
    citationNavigationRef.current.api !== personalMemoryApi ||
    citationNavigationRef.current.store !== personalMemoryStore
  ) {
    citationNavigationRef.current = {
      generation: citationNavigationRef.current.generation + 1,
      ownerId: visibilityOwnerId,
      profileKey: visibilityProfileKey,
      api: personalMemoryApi,
      store: personalMemoryStore
    };
  }
  const citationProjectsRef = useRef(projects);
  citationProjectsRef.current = projects;
  const citationBlockedRef = useRef(blockedConversationSessions);
  citationBlockedRef.current = blockedConversationSessions;
  const route =
    selection.route.kind === "project" && projectsStore
      ? selection.route
      : reconcileHqRoute(selection.route, selection.project, projects);
  const routeRef = useRef(route);
  routeRef.current = route;
  useEffect(() => {
    const projectId = route.kind === "project" ? route.projectId : null;
    setDocumentWorkItemIntent((current) =>
      current &&
      (current.projectId !== projectId ||
        current.ownerId !== (visibilityOwnerId ?? null) ||
        current.profileKey !== (visibilityProfileKey ?? null))
        ? null
        : current
    );
  }, [
    route.kind,
    route.kind === "project" ? route.projectId : null,
    visibilityOwnerId,
    visibilityProfileKey
  ]);
  useEffect(() => {
    if (route.kind !== "home") setNowMemoryOpen(false);
  }, [route.kind]);
  const routeEpoch = useRef(0);
  const contextAvailable =
    (route.kind === "project" &&
      (projectsStore
        ? personalProjects.some(({ id }) => id === route.projectId)
        : projects.some(
            (item) =>
              item.id === route.projectId && item.contextKind === "project"
          ))) ||
    (route.kind === "home" && nowMemoryOpen);
  const resolveBlankProject = useCallback(() => {
    if (!onResolveIndependent) return;
    if (!snapshot?.projectsLoaded) {
      setBlankProjectError("Load Projects before starting a Conversation.");
      return;
    }
    setBlankProjectError("");
    void onResolveIndependent()
      .then((resolved) => {
        if (!resolved) throw new Error("Chats project is unavailable.");
        setBlankProjectId(resolved.id);
        void personalMemoryStore?.loadProjects({ silent: true });
      })
      .catch((cause: unknown) =>
        setBlankProjectError(
          cause instanceof Error
            ? cause.message
            : "Chats project is unavailable."
        )
      );
  }, [onResolveIndependent, personalMemoryStore, snapshot?.projectsLoaded]);
  useEffect(() => {
    if (
      selection.route.kind === "home" &&
      snapshot?.projectsLoaded &&
      !blankProjectId &&
      !blankProjectError
    )
      resolveBlankProject();
  }, [
    selection.route.kind,
    snapshot?.projectsLoaded,
    blankProjectId,
    blankProjectError,
    resolveBlankProject
  ]);
  const selectRoute = (next: HqRoute) => {
    setFocusDueItem(null);
    routeEpoch.current++;
    setCitationFocus(null);
    setInventoryTarget(null);
    setBlankOpen(false);
    setBlankLaunchPending(false);
    setAttachAfterStart(null);
    setSelection({
      route: next,
      project:
        next.kind === "home"
          ? undefined
          : citationProjectsRef.current.find(({ id }) => id === next.projectId)
    });
  };
  const openCitationMessage = async (
    target: HqCitationMessageTarget
  ): Promise<boolean> => {
    const authority = citationNavigationRef.current;
    const api = authority.api;
    if (!authority.ownerId || !authority.profileKey || !api || !authority.store)
      return false;
    const initialRoute = resolveHqCitationMessageTarget(
      target,
      citationProjectsRef.current,
      citationBlockedRef.current
    );
    if (!initialRoute) return false;
    const navigationEpoch = routeEpoch.current;
    try {
      const events = await api.loadEventPage({
        projectId: target.projectId,
        threadId: target.threadId,
        limit: PERSONAL_DESKTOP_INITIAL_EVENT_LIMIT,
        eventIds: [target.messageId]
      });
      if (
        citationNavigationRef.current !== authority ||
        routeEpoch.current !== navigationEpoch ||
        events.length !== 1 ||
        events[0]?.id !== target.messageId ||
        events[0].invalidatedAt
      )
        return false;
      const currentRoute = resolveHqCitationMessageTarget(
        target,
        citationProjectsRef.current,
        citationBlockedRef.current
      );
      if (!currentRoute) return false;
      selectRoute(currentRoute);
      setCitationFocus({
        projectId: target.projectId,
        sessionId: target.sessionId,
        eventId: target.messageId,
        generation: authority.generation
      });
      return true;
    } catch {
      return false;
    }
  };
  const openChatDeleteRequest = (
    projectId: string,
    sessionId: string,
    title: string,
    mode: "delete" | "forget",
    textActionId?: string
  ) => {
    if (!visibilityOwnerId || !visibilityProfileKey || chatBusyRef.current)
      return;
    chatIntentEpoch.current++;
    const token = chatToken();
    setChatDeleteRequest({
      projectId,
      sessionId,
      title,
      mode,
      running: null,
      ...(textActionId ? { textActionId } : {})
    });
    if (!managedConversations?.list) {
      setChatDeleteRequest(null);
      setChatDeleteNotice({
        kind: "error",
        sessionId,
        message: "Cannot check whether an agent is working in this chat."
      });
      return;
    }
    void managedConversations
      .list()
      .then((result) => {
        if (!chatCurrent(token)) return;
        if (!result.complete)
          throw new Error("Incomplete managed Conversation list");
        const running = result.executions.some(
          (execution) =>
            execution.sessionId === sessionId &&
            !["stopped", "failed", "fenced"].includes(execution.state)
        );
        setChatDeleteRequest((current) =>
          current?.sessionId === sessionId && current.mode === mode
            ? { ...current, running }
            : current
        );
      })
      .catch(() => {
        if (
          !chatCurrent(token) ||
          chatRequestRef.current?.sessionId !== sessionId
        )
          return;
        setChatDeleteRequest(null);
        setChatDeleteNotice({
          kind: "error",
          sessionId,
          message: "Cannot check whether an agent is working in this chat."
        });
      });
  };
  const offerMemorySourceChatForget = async (
    sourceSessionId: string
  ): Promise<boolean> => {
    const authority = citationNavigationRef.current;
    if (
      !authority.ownerId ||
      !authority.profileKey ||
      !authority.store ||
      !personalMemoryApi?.forgetSession
    )
      return false;
    try {
      await authority.store.loadProjects({ silent: true });
      if (citationNavigationRef.current !== authority) return false;
      const fresh = authority.store.current();
      const matches = [...fresh.projectsById.values()].flatMap(
        (sourceProject) =>
          sourceProject.threads
            .filter(
              (sourceThread) =>
                sourceThread.sessionId === sourceSessionId &&
                !sourceThread.conversationTrashedAt
            )
            .map((sourceThread) => ({ sourceProject, sourceThread }))
      );
      if (matches.length !== 1 || chatBusyRef.current) return false;
      const { sourceProject, sourceThread } = matches[0]!;
      openChatDeleteRequest(
        sourceProject.id,
        sourceSessionId,
        sourceThread.name,
        "forget"
      );
      return true;
    } catch {
      return false;
    }
  };
  const confirmChatDelete = async () => {
    if (
      !chatDeleteRequest ||
      chatBusyRef.current ||
      chatDeleteRequest.running === null
    )
      return;
    chatBusyRef.current = true;
    setChatDeleteBusy(true);
    const target = chatDeleteRequest;
    const token = chatToken();
    const originalRouteEpoch = routeEpoch.current;
    let submittedBatchId: string | null = null;
    try {
      if (target.mode === "forget") {
        if (!personalMemoryApi?.forgetSession) return;
        const requestedBatchId = crypto.randomUUID();
        submittedBatchId = requestedBatchId;
        const forgotten = await personalMemoryApi.forgetSession({
          sessionId: target.sessionId,
          batchId: requestedBatchId
        });
        if (!chatCurrent(token)) return;
        if (forgotten.batchId !== requestedBatchId)
          throw new Error("Conversation Forget response identity changed.");
        setChatDeleteRequest(null);
        if (forgotten.pending) {
          setChatDeleteNotice({
            kind: "forget_pending",
            sessionId: target.sessionId,
            batchId: forgotten.batchId,
            message: `Forget pending for ${target.title}. Koed is stopping the agent before removing Personal recall.`
          });
          return;
        }
        await personalMemoryStore?.loadProjects({ silent: true });
        if (!chatCurrent(token)) return;
        if (
          routeEpoch.current === originalRouteEpoch &&
          routeRef.current.kind === "conversation" &&
          routeRef.current.sessionId === target.sessionId
        )
          selectRoute({ kind: "home" });
        setChatDeleteNotice({
          kind: "forgotten",
          sessionId: target.sessionId,
          batchId: forgotten.batchId,
          message: `${target.title} forgotten from Personal recall.`
        });
        return;
      }
      if (!personalMemoryApi?.trashSession) return;
      const requestedBatchId = target.textActionId ?? crypto.randomUUID();
      submittedBatchId = requestedBatchId;
      let result = await personalMemoryApi.trashSession({
        sessionId: target.sessionId,
        batchId: requestedBatchId
      });
      if (!chatCurrent(token)) return;
      if (
        result.sessionId !== target.sessionId ||
        result.batchId !== requestedBatchId
      )
        throw new Error("Conversation deletion response identity changed.");
      if (personalMemoryApi.reviewSessionDeletion) {
        for (const review of result.pendingReviews) {
          result = await personalMemoryApi.reviewSessionDeletion({
            sessionId: target.sessionId,
            batchId: result.batchId,
            actionGrantId: review.actionGrantId
          });
          if (!chatCurrent(token)) return;
          if (
            result.sessionId !== target.sessionId ||
            result.batchId !== requestedBatchId
          )
            throw new Error("Conversation deletion review identity changed.");
        }
      }
      setChatDeleteRequest(null);
      if (result.complete) {
        setPendingChatDeletionIds((current) => {
          const next = new Set(current);
          next.delete(target.sessionId);
          return next;
        });
        await personalMemoryStore?.loadProjects({ silent: true });
        if (!chatCurrent(token)) return;
        if (
          routeEpoch.current === originalRouteEpoch &&
          routeRef.current.kind === "conversation" &&
          routeRef.current.sessionId === target.sessionId
        )
          selectRoute({ kind: "home" });
        setChatDeleteNotice({
          kind: "deleted",
          sessionId: target.sessionId,
          batchId: result.batchId,
          message: `${target.title} moved to Deleted.`
        });
      } else {
        setPendingChatDeletionIds((current) =>
          new Set(current).add(target.sessionId)
        );
        setChatDeleteNotice({
          kind: "pending",
          sessionId: target.sessionId,
          batchId: result.batchId,
          message: `Deletion pending for ${target.title}. Koed is waiting for the source freeze or running work to finish.`
        });
      }
    } catch (error) {
      if (!chatCurrent(token)) return;
      setChatDeleteRequest(null);
      if (submittedBatchId) {
        setPendingChatDeletionIds((current) =>
          target.mode === "delete"
            ? new Set(current).add(target.sessionId)
            : current
        );
        setChatDeleteNotice({
          kind: target.mode === "forget" ? "forget_pending" : "pending",
          sessionId: target.sessionId,
          batchId: submittedBatchId,
          message: `${target.mode === "forget" ? "Forget" : "Deletion"} pending for ${target.title}. Check its status to reconcile this exact batch.`
        });
      } else {
        setChatDeleteNotice({
          kind: "error",
          sessionId: target.sessionId,
          message:
            error instanceof Error
              ? error.message
              : "Could not delete this chat."
        });
      }
    } finally {
      if (chatCurrent(token)) {
        chatBusyRef.current = false;
        setChatDeleteBusy(false);
      }
    }
  };
  const retryChatDelete = async () => {
    const notice = chatDeleteNotice;
    if (!notice || chatBusyRef.current) return;
    chatBusyRef.current = true;
    setChatDeleteBusy(true);
    const token = chatToken();
    const originalRouteEpoch = routeEpoch.current;
    try {
      if (notice.kind === "forget_pending") {
        if (!notice.batchId || !personalMemoryApi?.progressSessionForget)
          return;
        try {
          const result = await personalMemoryApi.progressSessionForget({
            sessionId: notice.sessionId,
            batchId: notice.batchId
          });
          if (!chatCurrent(token) || chatNoticeRef.current !== notice) return;
          if (result.batchId !== notice.batchId)
            throw new Error("Conversation Forget response identity changed.");
          if (!result.pending) {
            await personalMemoryStore?.loadProjects({ silent: true });
            if (!chatCurrent(token) || chatNoticeRef.current !== notice) return;
            if (
              routeEpoch.current === originalRouteEpoch &&
              routeRef.current.kind === "conversation" &&
              routeRef.current.sessionId === notice.sessionId
            )
              selectRoute({ kind: "home" });
            setChatDeleteNotice({
              kind: "forgotten",
              sessionId: notice.sessionId,
              batchId: result.batchId,
              message: "Conversation forgotten from Personal recall."
            });
          }
        } catch (error) {
          if (!chatCurrent(token) || chatNoticeRef.current !== notice) return;
          setChatDeleteNotice({
            ...notice,
            message:
              error instanceof Error
                ? error.message
                : "Forget is still pending."
          });
        }
        return;
      }
      if (!notice.batchId || !personalMemoryApi?.progressSessionDeletion)
        return;
      try {
        let result = await personalMemoryApi.progressSessionDeletion({
          sessionId: notice.sessionId,
          batchId: notice.batchId
        });
        if (!chatCurrent(token) || chatNoticeRef.current !== notice) return;
        if (
          result.sessionId !== notice.sessionId ||
          result.batchId !== notice.batchId
        )
          throw new Error("Conversation deletion response identity changed.");
        if (personalMemoryApi.reviewSessionDeletion) {
          for (const review of result.pendingReviews) {
            result = await personalMemoryApi.reviewSessionDeletion({
              sessionId: notice.sessionId,
              batchId: result.batchId,
              actionGrantId: review.actionGrantId
            });
            if (!chatCurrent(token) || chatNoticeRef.current !== notice) return;
            if (
              result.sessionId !== notice.sessionId ||
              result.batchId !== notice.batchId
            )
              throw new Error("Conversation deletion review identity changed.");
          }
        }
        if (result.complete) {
          setPendingChatDeletionIds((current) => {
            const next = new Set(current);
            next.delete(result.sessionId);
            return next;
          });
          await personalMemoryStore?.loadProjects({ silent: true });
          if (!chatCurrent(token) || chatNoticeRef.current !== notice) return;
          if (
            routeEpoch.current === originalRouteEpoch &&
            routeRef.current.kind === "conversation" &&
            routeRef.current.sessionId === result.sessionId
          )
            selectRoute({ kind: "home" });
          setChatDeleteNotice({
            kind: "deleted",
            sessionId: result.sessionId,
            batchId: result.batchId,
            message: "Conversation moved to Deleted."
          });
        }
      } catch (error) {
        if (!chatCurrent(token) || chatNoticeRef.current !== notice) return;
        setChatDeleteNotice({
          ...notice,
          message:
            error instanceof Error
              ? error.message
              : "Deletion is still pending."
        });
      }
    } finally {
      if (chatCurrent(token)) {
        chatBusyRef.current = false;
        setChatDeleteBusy(false);
      }
    }
  };
  const undoChatDelete = async () => {
    const notice = chatDeleteNotice;
    if (!notice || !notice.batchId || chatBusyRef.current) return;
    chatBusyRef.current = true;
    setChatDeleteBusy(true);
    const token = chatToken();
    try {
      if (notice.kind === "forgotten") {
        if (!personalMemoryApi?.undoForgetSession) return;
        await personalMemoryApi.undoForgetSession({
          sessionId: notice.sessionId,
          batchId: notice.batchId
        });
      } else {
        if (!personalMemoryApi?.restoreSession) return;
        await personalMemoryApi.restoreSession({
          sessionId: notice.sessionId,
          batchId: notice.batchId
        });
      }
      if (!chatCurrent(token) || chatNoticeRef.current !== notice) return;
      await personalMemoryStore?.loadProjects({ silent: true });
      if (!chatCurrent(token) || chatNoticeRef.current !== notice) return;
      setChatDeleteNotice(null);
    } catch (error) {
      if (!chatCurrent(token) || chatNoticeRef.current !== notice) return;
      setChatDeleteNotice({
        kind: "error",
        sessionId: notice.sessionId,
        message:
          error instanceof Error
            ? error.message
            : "Could not restore this chat."
      });
    } finally {
      if (chatCurrent(token)) {
        chatBusyRef.current = false;
        setChatDeleteBusy(false);
      }
    }
  };
  const projectMenu = useProjectMenuActions({
    api: projectsApi,
    store: projectsStore,
    ownerId: visibilityOwnerId,
    profileKey: visibilityProfileKey,
    suggestedProjectName:
      visibilityOwnerId && visibilityProfileKey
        ? hqSuggestedProjectName(
            readHqOnboarding(visibilityOwnerId, visibilityProfileKey).role
          )
        : undefined,
    onOpenProject: (projectId) => selectRoute({ kind: "project", projectId })
  });
  const personalProject =
    route.kind === "project"
      ? personalProjects.find(({ id }) => id === route.projectId)
      : undefined;
  const projectTeamIdentity =
    visibilityOwnerId &&
    visibilityProfileKey &&
    personalProject?.workspaceProjectId &&
    personalProject.teamBackendId
      ? {
          ownerId: visibilityOwnerId,
          profileKey: visibilityProfileKey,
          personalProjectId: personalProject.id,
          workspaceProjectId: personalProject.workspaceProjectId,
          teamBackendId: personalProject.teamBackendId
        }
      : null;
  const projectTeamIdentityKey = projectTeamIdentity
    ? `${projectTeamIdentity.ownerId}:${projectTeamIdentity.profileKey}:${projectTeamIdentity.personalProjectId}:${projectTeamIdentity.workspaceProjectId}:${projectTeamIdentity.teamBackendId}`
    : "";
  useEffect(() => {
    setProjectTab("hq");
    setProjectTeamPeople([]);
    setProjectTeamUnread({
      unreadCount: 0,
      latestSequence: 0,
      lastReadSequence: 0
    });
    if (projectTeamIdentity)
      onProjectTeamUnreadChange?.({
        personalProjectId: projectTeamIdentity.personalProjectId,
        workspaceProjectId: projectTeamIdentity.workspaceProjectId,
        teamBackendId: projectTeamIdentity.teamBackendId,
        unreadCount: 0,
        latestSequence: 0,
        lastReadSequence: 0
      });
    return () => {
      if (projectTeamIdentity)
        onProjectTeamUnreadChange?.({
          personalProjectId: projectTeamIdentity.personalProjectId,
          workspaceProjectId: projectTeamIdentity.workspaceProjectId,
          teamBackendId: projectTeamIdentity.teamBackendId,
          unreadCount: 0,
          latestSequence: 0,
          lastReadSequence: 0
        });
    };
  }, [projectTeamIdentityKey]);
  useEffect(() => {
    if (!projectTeamTabRequest || !visibilityOwnerId || !visibilityProfileKey)
      return;
    const linked = personalProjects.find(
      (candidate) =>
        candidate.id === projectTeamTabRequest.personalProjectId &&
        candidate.workspaceProjectId ===
          projectTeamTabRequest.workspaceProjectId &&
        candidate.teamBackendId === projectTeamTabRequest.teamBackendId
    );
    if (!linked) return;
    selectRoute({ kind: "project", projectId: linked.id });
    setProjectTab("team");
    shellActions.current?.showContext();
  }, [
    projectTeamTabRequest?.nonce,
    visibilityOwnerId,
    visibilityProfileKey,
    personalProjects,
    projectTeamIdentityKey
  ]);
  const projectTeamUnreadChange = useCallback(
    (value: {
      unreadCount: number;
      latestSequence: number;
      lastReadSequence: number;
    }) => {
      setProjectTeamUnread((previous) =>
        value.latestSequence >= previous.latestSequence ? value : previous
      );
      if (projectTeamIdentity)
        onProjectTeamUnreadChange?.({
          personalProjectId: projectTeamIdentity.personalProjectId,
          workspaceProjectId: projectTeamIdentity.workspaceProjectId,
          teamBackendId: projectTeamIdentity.teamBackendId,
          ...value
        });
    },
    [projectTeamIdentityKey, onProjectTeamUnreadChange]
  );
  const projectPresentation = useMemo<DesktopProject | undefined>(
    () =>
      personalProject
        ? {
            id: personalProject.id,
            name: personalProject.name,
            path: personalProject.folderPath,
            eventCount: 0,
            threads: [],
            contextKind: "project",
            catalogued: false,
            discoveredAt: null,
            lastSeenAt: null,
            localProjectId: null,
            branch: null,
            remoteDisplay: null,
            isWorktree: false
          }
        : undefined,
    [personalProject]
  );
  const project =
    route.kind === "conversation"
      ? projects.find(({ id }) => id === route.projectId)
      : route.kind === "project"
        ? (projectPresentation ??
          projects.find(({ id }) => id === route.projectId))
        : undefined;
  useEffect(() => {
    if (project && (route !== selection.route || project !== selection.project))
      setSelection({ route, project });
  }, [route, project, selection]);
  const conversation =
    route.kind === "conversation"
      ? project?.threads.find(
          (thread) => sessionSelectionId(thread) === route.sessionId
        )
      : undefined;
  const selectedConversationBlocked =
    route.kind === "conversation" &&
    blockedConversationSessions.has(
      `${route.projectId}\u0000${route.sessionId}`
    );
  const inventoryThread: PersonalDesktopProjectThread | undefined =
    route.kind === "conversation" &&
    !selectedConversationBlocked &&
    inventoryTarget?.executionId === route.sessionId &&
    inventoryTarget.projectId === route.projectId &&
    inventoryTarget.sessionId &&
    inventoryTarget.threadId &&
    project
      ? {
          id: inventoryTarget.threadId,
          name: `Conversation in ${project.name}`,
          sessionId: inventoryTarget.sessionId,
          sourceAiClient: null,
          projectId: project.id,
          projectName: project.name,
          projectPath: project.path,
          projectAssignmentSource: null,
          eventCount: 0,
          invalidatedCount: 0,
          latestAt: inventoryTarget.createdAt,
          sample: "",
          presentation: null
        }
      : undefined;
  const draftEntry =
    route.kind === "conversation" && !selectedConversationBlocked
      ? findHqConversationDraft(
          managedConversationLifecycle?.drafts,
          route.projectId,
          route.sessionId
        )
      : null;
  const draft = draftEntry?.[1] ?? null;
  const conversationThread = conversation ?? draft?.thread ?? inventoryThread;
  const openNowNeed = (need: NowNeed) => {
    if (
      need.projectId &&
      need.sessionId &&
      blockedConversationSessions.has(
        `${need.projectId}\u0000${need.sessionId}`
      )
    )
      return;
    const destination = nowConversationDestination(need, projects);
    if (!destination) return;
    selectRoute({
      kind: "conversation",
      projectId: destination.projectId,
      sessionId: destination.routeId
    });
    if (destination.synthetic) setInventoryTarget(need);
  };
  const title =
    route.kind === "conversation"
      ? conversationThread?.name || "Conversation"
      : route.kind === "project"
        ? personalProjects.find(({ id }) => id === route.projectId)?.name ||
          project?.name ||
          "Project"
        : "Now";
  // A successful graph read with unavailable metadata is incomplete, even
  // though the shared store deliberately does not expose a global error.
  const incompleteProjects = Boolean(
    snapshot &&
    snapshot.revision > 0 &&
    !snapshot.projectsLoaded &&
    !snapshot.loading
  );
  const destinations: HqCommand[] = projects.flatMap((item) => [
    ...(projectsStore || item.contextKind === "independent"
      ? []
      : [
          {
            id: `project:${item.id}`,
            label: item.name,
            scope: "Project",
            action: {
              kind: "route" as const,
              route: { kind: "project" as const, projectId: item.id }
            }
          }
        ]),
    ...item.threads
      .filter((thread) => thread.threadKind !== "subagent")
      .map(
        (thread): HqCommand => ({
          id: `conversation:${item.id}:${thread.id}`,
          label: thread.name || "Conversation",
          scope: item.name,
          action: {
            kind: "route",
            route: {
              kind: "conversation",
              projectId: item.id,
              sessionId: sessionSelectionId(thread)
            }
          }
        })
      )
  ]);
  if (projectsStore)
    for (const item of personalProjects)
      destinations.push({
        id: `project:${item.id}`,
        label: item.name,
        scope: "Project",
        action: {
          kind: "route",
          route: { kind: "project", projectId: item.id }
        }
      });
  if (projectsStore && visibilityClient)
    for (const item of personalProjects)
      if (!item.workspaceProjectId)
        destinations.push({
          id: `share-project:${item.id}`,
          label: `Share ${item.name}`,
          scope: "Share Project",
          action: { kind: "share-project", projectId: item.id }
        });
  destinations.push(
    ...hqLayoutCommands(Boolean(renderSettings), contextAvailable)
  );
  const openSettings = useCallback(
    (section: HqSettingsSection = "general") => {
      if (!renderSettings) return;
      setSettingsSection(section);
      if (settingsOpen) return;
      const active = document.activeElement;
      settingsReturnFocus.current =
        active instanceof HTMLElement &&
        active !== document.body &&
        active !== document.documentElement &&
        active.tabIndex >= 0 &&
        !active.closest('[role="dialog"]')
          ? active
          : (document.querySelector<HTMLElement>("button.hq-account") ??
            document.querySelector<HTMLElement>(
              'button[aria-label="Search and commands"]'
            ));
      shellActions.current?.dismissOverlays();
      setSearchOpen(false);
      setSettingsOpen(true);
    },
    [renderSettings, settingsOpen]
  );
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    requestAnimationFrame(() => {
      const opener = settingsReturnFocus.current;
      const fallback = [
        document.querySelector<HTMLElement>("button.hq-account"),
        document.querySelector<HTMLElement>(
          'button[aria-label="Show project navigation"]'
        ),
        document.querySelector<HTMLElement>(
          'button[aria-label="Search and commands"]'
        )
      ].find((element) => element && element.getClientRects().length > 0);
      (opener?.isConnected && opener.getClientRects().length
        ? opener
        : fallback
      )?.focus();
    });
  }, []);
  const applyTextAction = async (action: KoedTextActionProjection) => {
    if (
      !visibilityOwnerId ||
      action.ownerUserId !== visibilityOwnerId ||
      !visibilityProfileKey ||
      action.state !== "claimed"
    )
      return false;
    const owner = visibilityOwnerId;
    const profile = visibilityProfileKey;
    const stillCurrent = () =>
      chatAuthority.current.ownerId === owner &&
      chatAuthority.current.profileKey === profile;
    const args = parseKoedTextActionArguments(action.name, action.arguments);
    if (!stillCurrent()) return false;
    const moveOne = async (
      sessionId: string,
      fromProjectId: string | null,
      toProjectId: string | null
    ): Promise<boolean> => {
      if (!personalMemoryApi?.assignSessionProject || !stillCurrent())
        return false;
      let result = await personalMemoryApi.assignSessionProject(
        toProjectId
          ? {
              action: "move",
              sessionId,
              targetProjectId: toProjectId,
              expectedProjectId: fromProjectId,
              textActionId: action.id
            }
          : {
              action: "loose",
              sessionId,
              expectedProjectId: fromProjectId,
              textActionId: action.id
            }
      );
      if (!stillCurrent()) return false;
      if (result.pending && result.batchId && result.pendingReviews?.length) {
        if (!personalMemoryApi.reviewSessionMove) return false;
        const reviewed = new Set<string>();
        for (let attempt = 0; attempt < 16 && result.pending; attempt++) {
          const next = result.pendingReviews?.find(
            (item) => !reviewed.has(item.actionGrantId)
          );
          if (!next || !stillCurrent()) break;
          reviewed.add(next.actionGrantId);
          const status = await personalMemoryApi.reviewSessionMove({
            sessionId,
            batchId: result.batchId!,
            actionGrantId: next.actionGrantId
          });
          if (!stillCurrent()) return false;
          result = {
            projectId: status.projectId,
            pending: status.pending,
            batchId: status.batchId,
            pendingReviews: status.pendingReviews
          };
        }
      }
      return (
        !result.pending && result.projectId === toProjectId && stillCurrent()
      );
    };
    switch (action.name) {
      case "koed_project_create": {
        if (!projectsApi) return false;
        const project = await projectsApi.create({
          name: String(args.name),
          folderPath:
            typeof args.folderPath === "string" ? args.folderPath : null,
          idempotencyKey: action.effectKey,
          textActionId: action.id
        });
        if (!stillCurrent()) return false;
        projectsStore?.projectChanged(owner, profile, project.id, project);
        await projectsStore?.refresh();
        if (!stillCurrent()) return false;
        selectRoute({ kind: "project", projectId: project.id });
        return true;
      }
      case "koed_todo_add": {
        if (
          typeof action.snapshot.workspaceProjectId === "string" &&
          typeof action.snapshot.teamBackendId === "string"
        ) {
          if (!window.koedDesktop?.managedTextActions) return false;
          await window.koedDesktop.managedTextActions.applyTeamTodoAdd(
            action.executionId,
            action.id,
            action.revision
          );
          return stillCurrent();
        }
        if (!projectsApi?.workItemCreate) return false;
        const title = String(args.title);
        await projectsApi.workItemCreate(String(args.projectId), {
          kind: "todo",
          title,
          goal: typeof args.goal === "string" ? args.goal : title,
          origin: "koed_text_action",
          idempotencyKey: action.effectKey,
          dueOn: typeof args.dueOn === "string" ? args.dueOn : null,
          textActionId: action.id
        });
        return stillCurrent();
      }
      case "koed_todo_send": {
        if (
          typeof action.snapshot.workspaceProjectId === "string" &&
          typeof action.snapshot.teamBackendId === "string"
        ) {
          if (
            !projectsApi?.sharedDispatchWorkItem ||
            typeof action.snapshot.teamProjectVersion !== "number" ||
            typeof action.snapshot.teamMemberVersion !== "number" ||
            typeof action.snapshot.workItemVersion !== "number"
          )
            return false;
          await projectsApi.sharedDispatchWorkItem(
            String(args.projectId),
            String(args.workItemId),
            String(args.agentId),
            action.snapshot.teamProjectVersion,
            action.snapshot.teamMemberVersion,
            action.snapshot.workItemVersion,
            action.id
          );
          return stillCurrent();
        }
        if (
          !projectsApi?.workItemDispatch ||
          typeof action.snapshot.workItemVersion !== "number"
        )
          return false;
        await projectsApi.workItemDispatch(
          String(args.projectId),
          String(args.workItemId),
          String(args.agentId),
          action.snapshot.workItemVersion,
          undefined,
          action.id
        );
        return stillCurrent();
      }
      case "koed_chat_move": {
        return moveOne(
          String(args.sessionId),
          (action.snapshot.currentProjectId as string | null) ?? null,
          typeof args.projectId === "string" ? args.projectId : null
        );
      }
      case "koed_project_move_chats": {
        if (
          !Array.isArray(action.snapshot.chats) ||
          !Array.isArray(args.sessionIds)
        )
          return false;
        let allComplete = true;
        for (const sessionId of args.sessionIds) {
          const pinned = action.snapshot.chats.find(
            (entry) =>
              entry &&
              typeof entry === "object" &&
              (entry as { sessionId?: unknown }).sessionId === sessionId
          );
          if (!pinned || typeof pinned !== "object" || !stillCurrent())
            return false;
          // Prepare every exact session once even if an earlier batch needs
          // Native review. A restart then resumes existing batches only.
          const complete = await moveOne(
            String(sessionId),
            (pinned as { currentProjectId?: string | null }).currentProjectId ??
              null,
            String(args.projectId)
          );
          if (!stillCurrent()) return false;
          allComplete &&= complete;
        }
        await personalMemoryStore?.loadProjects({ silent: true });
        return allComplete && stillCurrent();
      }
      case "koed_hq_open":
        selectRoute({ kind: "project", projectId: String(args.projectId) });
        return stillCurrent();
      case "koed_settings_open":
        if (!renderSettings) return false;
        openSettings((args.section ?? "general") as HqSettingsSection);
        return stillCurrent();
      case "koed_settings_set_theme":
        if (!renderSettings || !window.koedDesktop?.theme) return false;
        {
          const view = renderSettings(() => undefined);
          if (
            !isValidElement<HqSettingsProps>(view) ||
            view.type !== HqSettings
          )
            return false;
          const requested = args.theme as "system" | "light" | "dark";
          view.props.onThemeChange(requested);
          // The button callback schedules a ThemeStore write. Confirm the
          // persisted Desktop preference before recording the text effect.
          for (let attempt = 0; attempt < 12 && stillCurrent(); attempt++) {
            if ((await window.koedDesktop.theme.get()) === requested)
              return true;
            await new Promise((resolve) => window.setTimeout(resolve, 100));
          }
          return false;
        }
      case "koed_chat_create": {
        if (
          !onResolveIndependent ||
          !managedConversations ||
          !managedConversationLifecycle ||
          (blankOpen && blankLaunchPending)
        )
          return false;
        const selectedProjectId =
          typeof args.projectId === "string" ? args.projectId : null;
        if (
          selectedProjectId &&
          !projects.some(
            (item) =>
              item.id === selectedProjectId && item.contextKind === "project"
          )
        )
          return false;
        setBlankOpen(true);
        setBlankIntent((value) => value + 1);
        setBlankProjectId(selectedProjectId);
        setSelection({ route: { kind: "home" } });
        if (!selectedProjectId) resolveBlankProject();
        return stillCurrent();
      }
      default:
        return false;
    }
  };
  const resumeTextActionMove = async (action: KoedTextActionProjection) => {
    if (
      !personalMemoryApi?.lookupTextActionMove ||
      !personalMemoryApi.resumeTextActionMove ||
      !personalMemoryApi.reviewSessionMove
    )
      return false;
    const owner = visibilityOwnerId;
    const profile = visibilityProfileKey;
    const stillCurrent = () =>
      chatAuthority.current.ownerId === owner &&
      chatAuthority.current.profileKey === profile;
    const args = parseKoedTextActionArguments(action.name, action.arguments);
    const sessionIds =
      action.name === "koed_chat_move"
        ? [String(args.sessionId)]
        : action.name === "koed_project_move_chats" &&
            Array.isArray(args.sessionIds)
          ? args.sessionIds.map(String)
          : [];
    if (!sessionIds.length || !stillCurrent()) return false;
    let allComplete = true;
    for (const sessionId of sessionIds) {
      let status = await personalMemoryApi.lookupTextActionMove({
        sessionId,
        actionId: action.id
      });
      if (!stillCurrent() || !status) return false;
      const batchId = status.batchId;
      const reviewed = new Set<string>();
      for (let attempt = 0; attempt < 16 && status.pending; attempt++) {
        const next = status.pendingReviews.find(
          (item) => !reviewed.has(item.actionGrantId)
        );
        if (next) {
          reviewed.add(next.actionGrantId);
          status = await personalMemoryApi.reviewSessionMove({
            sessionId,
            batchId,
            actionGrantId: next.actionGrantId
          });
        } else {
          status = await personalMemoryApi.resumeTextActionMove({
            sessionId,
            actionId: action.id,
            batchId
          });
          if (!status.pendingReviews.length && status.pending) break;
        }
        if (!stillCurrent() || status.batchId !== batchId) return false;
      }
      allComplete &&= status.complete;
    }
    if (allComplete && stillCurrent())
      await personalMemoryStore?.loadProjects({ silent: true });
    return allComplete && stillCurrent();
  };
  const reviewTextActionNative = (action: KoedTextActionProjection) => {
    if (
      action.ownerUserId !== visibilityOwnerId ||
      action.state !== "awaiting_review" ||
      action.reviewKind !== "native"
    )
      return;
    if (
      action.name === "koed_project_delete" &&
      typeof action.snapshot.projectId === "string" &&
      typeof action.snapshot.projectVersion === "number" &&
      typeof action.snapshot.executionSetHash === "string"
    ) {
      projectMenu.openDelete(action.snapshot.projectId, {
        actionId: action.effectKey,
        expectedVersion: action.snapshot.projectVersion,
        expectedExecutionSetHash: action.snapshot.executionSetHash
      });
      return;
    }
    if (
      action.name === "koed_chat_delete" &&
      typeof action.snapshot.sessionId === "string" &&
      personalMemoryStore
    ) {
      const matches = [
        ...personalMemoryStore.current().projectsById.values()
      ].flatMap((sourceProject) =>
        sourceProject.threads
          .filter(
            (sourceThread) =>
              sourceThread.sessionId === action.snapshot.sessionId &&
              !sourceThread.conversationTrashedAt
          )
          .map((sourceThread) => ({ sourceProject, sourceThread }))
      );
      if (matches.length !== 1) return;
      const { sourceProject, sourceThread } = matches[0]!;
      openChatDeleteRequest(
        sourceProject.id,
        action.snapshot.sessionId,
        sourceThread.name,
        "delete",
        action.effectKey
      );
    }
  };
  useEffect(() => {
    if (!renderSettings) return;
    const keyDown = (event: KeyboardEvent) => {
      if (
        !hqSettingsShortcut(event) ||
        document.querySelector(
          '[role="dialog"]:not(.hq-search):not([data-hq-sidebar-dialog])'
        )
      )
        return;
      event.preventDefault();
      openSettings();
    };
    window.addEventListener("keydown", keyDown);
    return () => window.removeEventListener("keydown", keyDown);
  }, [openSettings, renderSettings]);
  const invoke = (command: HqCommand) => {
    const action = command.action;
    switch (action.kind) {
      case "route":
        selectRoute(action.route);
        break;
      case "toggle-sidebar":
        shellActions.current?.toggleSidebar();
        break;
      case "toggle-context":
        if (contextAvailable) shellActions.current?.toggleContext();
        break;
      case "settings":
        if (renderSettings) openSettings();
        break;
      case "share-project":
        setShareProjectId(action.projectId);
        break;
    }
  };
  const projectHqContent =
    route.kind === "project" &&
    project &&
    contextAvailable &&
    projectHqConversation &&
    managedConversations &&
    managedConversationLifecycle &&
    personalMemoryStore ? (
      <HqProjectConversation
        key={`${visibilityOwnerId ?? "no-owner"}:${visibilityProfileKey ?? "no-profile"}:${project.id}`}
        project={project}
        chiefName={chiefAgent?.name ?? "Chief of Staff"}
        chiefAgent={chiefAgent}
        agentsApi={agentsApi}
        helperAgents={ownedAgents}
        ownerIdentity={`${visibilityOwnerId ?? ""}:${visibilityProfileKey ?? ""}`}
        catchUpEnabled={catchUpEnabled}
        activityRevision={`${visibilityRevision ?? ""}:${sharedRefreshSignal}`}
        foreground={documentVisible && projectTab === "hq"}
        teamUnreadCount={
          projectTeamIdentity?.personalProjectId === project.id
            ? projectTeamUnread.unreadCount
            : 0
        }
        onOpenTeam={
          projectTeamIdentity?.personalProjectId === project.id
            ? () => {
                if (
                  projectTeamIdentity.personalProjectId !== project.id ||
                  route.kind !== "project" ||
                  route.projectId !== project.id
                )
                  return;
                setProjectTab("team");
                shellActions.current?.showContext();
              }
            : undefined
        }
        chiefInstanceId={chiefAgent?.aiClientInstanceId ?? null}
        api={projectHqConversation}
        managedConversations={managedConversations}
        managedProject={managedProject ?? null}
        store={personalMemoryStore}
        lifecycle={managedConversationLifecycle}
        markdownAdapters={
          markdownAdapters ?? {
            openExternal: () => undefined,
            writeClipboard: (value) => navigator.clipboard.writeText(value)
          }
        }
        onOfferChatForget={offerMemorySourceChatForget}
        onTextActionApply={applyTextAction}
        onTextActionNativeReview={reviewTextActionNative}
        onTextActionResumeMove={resumeTextActionMove}
        ownerId={visibilityOwnerId ?? undefined}
        profileKey={visibilityProfileKey ?? undefined}
        inspectorOpen={sourcesOpen}
        panelHostRef={setSourcesPanelHost}
        contextLabel={artifactContext}
        documentWorkItemIntent={
          documentWorkItemIntent?.projectId === project.id &&
          documentWorkItemIntent.ownerId === (visibilityOwnerId ?? null) &&
          documentWorkItemIntent.profileKey === (visibilityProfileKey ?? null)
            ? documentWorkItemIntent
            : null
        }
        onDocumentWorkItemIntentConsumed={(id) =>
          setDocumentWorkItemIntent((current) =>
            current?.id === id ? null : current
          )
        }
        onClearContext={() => {
          setCloseInspectorSignal((value) => value + 1);
          setSourcesOpen(false);
          setArtifactContext(null);
        }}
      />
    ) : undefined;
  const projectContextContent =
    route.kind === "project" &&
    projectTeamIdentity &&
    visibilityClient &&
    sharedProjectStore ? (
      <div className="hq-project-context-tabs">
        <div
          className="hq-project-context-tabs__tabs"
          role="tablist"
          aria-label="Project conversation"
        >
          <button
            type="button"
            role="tab"
            aria-selected={projectTab === "hq"}
            onClick={() => setProjectTab("hq")}
          >
            {chiefAgent ? <Pixelkin agent={chiefAgent} size={18} /> : null}
            Just me
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={projectTab === "team"}
            onClick={() => setProjectTab("team")}
          >
            <span
              className="hq-project-context-tabs__avatars"
              aria-hidden="true"
            >
              {projectTeamPeople.slice(0, 2).map((person) => (
                <span
                  key={person.userId}
                  title={person.displayName ?? "Team member"}
                >
                  {(person.displayName ?? "T").slice(0, 1).toUpperCase()}
                </span>
              ))}
            </span>
            Team
            {projectTeamUnread.unreadCount ? (
              <i className="hq-project-context-tabs__unread">
                {projectTeamUnread.unreadCount}
              </i>
            ) : null}
          </button>
        </div>
        <div
          hidden={projectTab !== "hq"}
          className="hq-project-context-tabs__content"
        >
          {projectHqContent}
        </div>
        <div
          hidden={projectTab !== "team"}
          className="hq-project-context-tabs__content"
        >
          <div ref={setProjectTeamHost} className="hq-project-thread-host" />
        </div>
      </div>
    ) : (
      projectHqContent
    );
  const assignPlacement = async (
    sessionId: string,
    fromProjectId: string | null,
    toProjectId: string | null,
    undo = false,
    undoBatchId?: string
  ) => {
    if (!personalMemoryApi || !personalMemoryStore || moveBusyRef.current)
      return;
    moveBusyRef.current = true;
    const epoch = ++moveEpoch.current;
    const ownerId = visibilityOwnerId;
    const profileKey = visibilityProfileKey;
    const current = () =>
      moveEpoch.current === epoch &&
      chatAuthority.current.ownerId === ownerId &&
      chatAuthority.current.profileKey === profileKey;
    try {
      let result = await personalMemoryApi.assignSessionProject(
        undoBatchId
          ? {
              action: "undo_move",
              sessionId,
              batchId: undoBatchId,
              expectedProjectId: fromProjectId
            }
          : toProjectId
            ? {
                action: "move",
                sessionId,
                targetProjectId: toProjectId,
                expectedProjectId: fromProjectId
              }
            : { action: "loose", sessionId, expectedProjectId: fromProjectId }
      );
      if (!current()) return;
      if (
        result.pending &&
        result.batchId &&
        result.pendingReviews?.length &&
        personalMemoryApi.reviewSessionMove
      ) {
        const reviewed = new Set<string>();
        for (let attempt = 0; attempt < 16 && result.pending; attempt++) {
          const next = result.pendingReviews?.find(
            (item) => !reviewed.has(item.actionGrantId)
          );
          if (!next) break;
          reviewed.add(next.actionGrantId);
          const status = await personalMemoryApi.reviewSessionMove({
            sessionId,
            batchId: result.batchId!,
            actionGrantId: next.actionGrantId
          });
          if (!current()) return;
          result = {
            projectId: status.projectId,
            pending: status.pending,
            batchId: status.batchId,
            pendingReviews: status.pendingReviews,
            ...(status.complete ? { moveBatchId: status.batchId } : {})
          };
        }
      }
      if (result.pending) {
        setMoveNotice({
          sessionId,
          fromProjectId,
          toProjectId,
          message:
            "Move pending. Waiting for sharing approval or reconnection.",
          undoable: false,
          pending: true
        });
        return;
      }
      await personalMemoryStore.loadProjects({ silent: true });
      if (!current()) return;
      if (toProjectId) setRevealProject({ id: toProjectId, token: epoch });
      if (
        routeRef.current.kind === "conversation" &&
        routeRef.current.sessionId === sessionId
      )
        setSelection({
          route: {
            kind: "conversation",
            projectId: toProjectId ?? "lp_chats",
            sessionId
          }
        });
      setMoveNotice(
        undo
          ? null
          : {
              sessionId,
              fromProjectId,
              toProjectId,
              message: toProjectId
                ? `Moved to ${personalProjects.find((project) => project.id === toProjectId)?.name ?? "Project"}.`
                : "Removed from the project.",
              undoable: true,
              moveBatchId: result.moveBatchId
            }
      );
    } catch (error) {
      if (current())
        setMoveNotice({
          sessionId,
          fromProjectId,
          toProjectId,
          message:
            error instanceof Error ? error.message : "Chat could not be moved.",
          undoable: false
        });
    } finally {
      if (current()) moveBusyRef.current = false;
    }
  };
  const needsOnboarding = Boolean(
    agentsApi &&
    visibilityOwnerId &&
    visibilityProfileKey &&
    !readHqOnboarding(visibilityOwnerId, visibilityProfileKey).completed
  );
  void onboardingRevision;
  if (needsOnboarding && visibilityOwnerId && visibilityProfileKey)
    return (
      <div className="hq-onboarding-shell">
        <HqShell title="Getting started" contextAvailable={false}>
          <HqOnboarding
            key={`${visibilityOwnerId}:${visibilityProfileKey}`}
            ownerId={visibilityOwnerId}
            profileKey={visibilityProfileKey}
            agentsApi={agentsApi}
            localAiClients={localAiClients}
            personalMemoryApi={personalMemoryApi}
            curatedMemoryApi={window.koedDesktop?.curatedMemory}
            onComplete={() => {
              void agentsStore?.refresh();
              setOnboardingRevision((value) => value + 1);
            }}
          />
        </HqShell>
      </div>
    );
  return (
    <>
      <HqShell
        actionsRef={shellActions}
        onRightColumnVisibilityChange={setRightColumnVisible}
        contextAvailable={contextAvailable}
        contextContent={
          route.kind === "home" && nowMemoryOpen ? (
            <div className="hq-now-memory-host" ref={setNowMemoryHost} />
          ) : (
            projectContextContent
          )
        }
        title={title}
        route={route}
        sidebar={({ compact }) => (
          <HqSidebar
            compact={compact}
            conversationAgents={conversationAgents}
            revealProject={revealProject}
            accountIdentity={accountIdentity}
            onOpenSettings={renderSettings ? () => openSettings() : undefined}
            groupsReady={
              projectsStore
                ? firstClassLoaded
                : Boolean(snapshot?.projectsLoaded)
            }
            loading={
              projectsStore
                ? !firstClassLoaded && !firstClassError
                : !snapshot ||
                  snapshot.loading ||
                  (!snapshot.projectsLoaded &&
                    !snapshot.error &&
                    !incompleteProjects)
            }
            projectsError={
              projectsStore
                ? firstClassError
                : Boolean(snapshot?.error) || incompleteProjects
            }
            projects={projects}
            personalProjects={projectsStore ? personalProjects : undefined}
            sharedPeopleCounts={sharedPeopleCounts}
            pendingDeletionIds={pendingChatDeletionIds}
            route={route}
            onRetryProjects={() => {
              void personalMemoryStore?.loadProjects();
              void projectsStore?.refresh();
            }}
            onOpenSearchAndCommands={() => {
              if (!settingsOpen) setSearchOpen(true);
            }}
            onSelectProject={(projectId) =>
              selectRoute({ kind: "project", projectId })
            }
            onCreateProject={
              projectsStore && firstClassLoaded
                ? projectMenu.openCreate
                : undefined
            }
            onDeleteProject={
              projectsStore && firstClassLoaded
                ? projectMenu.openDelete
                : undefined
            }
            onShareProject={
              projectsApi && visibilityClient ? setShareProjectId : undefined
            }
            onDeleteConversation={
              personalMemoryApi?.trashSession
                ? (projectId, sessionId, title) =>
                    openChatDeleteRequest(projectId, sessionId, title, "delete")
                : undefined
            }
            onForgetConversation={
              personalMemoryApi?.forgetSession
                ? (projectId, sessionId, title) =>
                    openChatDeleteRequest(projectId, sessionId, title, "forget")
                : undefined
            }
            onOpenNow={() => selectRoute({ kind: "home" })}
            nowActive={route.kind === "home" && !blankOpen}
            onSelectConversation={(projectId, sessionId) =>
              selectRoute({ kind: "conversation", projectId, sessionId })
            }
            onMoveConversation={
              personalMemoryApi && firstClassLoaded
                ? (sessionId, fromProjectId, toProjectId) => {
                    const thread = projects
                      .flatMap((project) => project.threads)
                      .find(
                        (item) =>
                          item.sessionId === sessionId &&
                          item.personalProjectId === fromProjectId
                      );
                    if (
                      !thread ||
                      thread.originDevice ||
                      !visibilityOwnerId ||
                      !visibilityProfileKey
                    )
                      return;
                    void assignPlacement(sessionId, fromProjectId, toProjectId);
                  }
                : undefined
            }
            onNewConversation={
              managedConversations &&
              managedConversationLifecycle &&
              onResolveIndependent
                ? () => {
                    if (blankOpen && blankLaunchPending) {
                      setBlankProjectError(
                        "Resolve the current Conversation launch before starting another."
                      );
                      return;
                    }
                    setBlankOpen(true);
                    setBlankIntent((value) => value + 1);
                    setBlankProjectId(null);
                    setSelection({ route: { kind: "home" } });
                    resolveBlankProject();
                  }
                : undefined
            }
          />
        )}
      >
        <section
          data-hq-route={route.kind}
          data-hq-project-id={
            route.kind === "project" ? route.projectId : project?.id
          }
          data-hq-session-id={
            route.kind === "conversation" ? route.sessionId : undefined
          }
          aria-label={title}
          className="hq-destination"
        >
          {(blankOpen || route.kind === "home") &&
          managedConversationLifecycle ? (
            <>
              {blankProjectError ? (
                <div role="alert">
                  {blankProjectError}{" "}
                  <button type="button" onClick={resolveBlankProject}>
                    Retry
                  </button>
                </div>
              ) : null}
              <HqBlankConversation
                key={blankIntent}
                variant={route.kind === "home" && !blankOpen ? "now" : "blank"}
                api={managedConversations ?? null}
                localAiClients={localAiClients}
                projects={projects}
                project={
                  projects.find(({ id }) => id === blankProjectId) ?? null
                }
                onProjectChange={setBlankProjectId}
                lifecycle={managedConversationLifecycle}
                managedProject={managedProject ?? null}
                onLaunchAttempt={() => setBlankLaunchPending(true)}
                onStarted={(projectId, sessionId, attachRequested) => {
                  selectRoute({ kind: "conversation", projectId, sessionId });
                  if (attachRequested) setAttachAfterStart(sessionId);
                }}
              />
              {route.kind === "home" && !blankOpen ? (
                <NowView
                  key={visibilityOwnerId ?? "no-owner"}
                  projects={projects}
                  personalProjects={
                    projectsStore ? personalProjects : undefined
                  }
                  projectsApi={projectsApi}
                  api={managedConversations}
                  ownerId={visibilityOwnerId}
                  profileKey={visibilityProfileKey}
                  memoryPanelHost={nowMemoryHost}
                  onMemoryPanelOpenChange={(open) => {
                    setNowMemoryOpen(open);
                    if (open) shellActions.current?.showContext();
                  }}
                  onOpenCitationMessage={openCitationMessage}
                  lifecycle={managedConversationLifecycle}
                  approvals={approvals}
                  blockedConversationSessions={blockedConversationSessions}
                  projectsReady={
                    projectsStore
                      ? firstClassLoaded
                      : Boolean(snapshot?.projectsLoaded)
                  }
                  projectsLoading={
                    projectsStore
                      ? !firstClassLoaded && !firstClassError
                      : Boolean(snapshot?.loading)
                  }
                  projectsError={
                    projectsStore
                      ? firstClassError
                      : Boolean(snapshot?.error) || incompleteProjects
                  }
                  onSelectProject={(projectId) =>
                    selectRoute({ kind: "project", projectId })
                  }
                  onSelectDueItem={(projectId, itemId) => {
                    selectRoute({ kind: "project", projectId });
                    setFocusDueItem({ projectId, itemId });
                  }}
                  onSelectConversation={openNowNeed}
                />
              ) : null}
            </>
          ) : route.kind === "home" ? (
            <NowView
              key={visibilityOwnerId ?? "no-owner"}
              projects={projects}
              personalProjects={projectsStore ? personalProjects : undefined}
              projectsApi={projectsApi}
              api={managedConversations}
              ownerId={visibilityOwnerId}
              profileKey={visibilityProfileKey}
              memoryPanelHost={nowMemoryHost}
              onMemoryPanelOpenChange={(open) => {
                setNowMemoryOpen(open);
                if (open) shellActions.current?.showContext();
              }}
              onOpenCitationMessage={openCitationMessage}
              lifecycle={managedConversationLifecycle}
              approvals={approvals}
              blockedConversationSessions={blockedConversationSessions}
              projectsReady={
                projectsStore
                  ? firstClassLoaded
                  : Boolean(snapshot?.projectsLoaded)
              }
              projectsLoading={
                projectsStore
                  ? !firstClassLoaded && !firstClassError
                  : Boolean(snapshot?.loading)
              }
              projectsError={
                projectsStore
                  ? firstClassError
                  : Boolean(snapshot?.error) || incompleteProjects
              }
              onSelectProject={(projectId) =>
                selectRoute({ kind: "project", projectId })
              }
              onSelectDueItem={(projectId, itemId) => {
                selectRoute({ kind: "project", projectId });
                setFocusDueItem({ projectId, itemId });
              }}
              onSelectConversation={openNowNeed}
            />
          ) : route.kind === "project" && personalProject && projectsApi ? (
            <HqProjectView
              key={`${visibilityOwnerId ?? "no-owner"}:${visibilityProfileKey ?? "no-profile"}:${personalProject.id}`}
              project={personalProject}
              personalProjects={personalProjects}
              graphProjects={projects}
              projectsApi={projectsApi}
              sharedProjectStore={sharedProjectStore}
              onOpenTeamTab={
                projectTeamIdentity && visibilityClient
                  ? () => {
                      setProjectTab("team");
                      shellActions.current?.showContext();
                    }
                  : undefined
              }
              teamUnreadCount={projectTeamUnread.unreadCount}
              rightColumnVisible={rightColumnVisible}
              deleteSharedProjectSource={
                visibilityClient?.deleteWorkspaceProjectSource
              }
              sharedRefreshSignal={sharedRefreshSignal}
              focusWorkItemId={
                focusDueItem?.projectId === personalProject.id
                  ? focusDueItem.itemId
                  : null
              }
              onFocusWorkItemHandled={() => setFocusDueItem(null)}
              onShareProject={
                visibilityClient
                  ? () => setShareProjectId(personalProject.id)
                  : undefined
              }
              curatedMemoryApi={window.koedDesktop?.curatedMemory}
              agentsApi={agentsApi}
              conversationsApi={managedConversations}
              managedProject={managedProject ?? null}
              lifecycle={managedConversationLifecycle}
              ownerId={visibilityOwnerId}
              profileKey={visibilityProfileKey}
              onConversationAgentsChange={onConversationAgentsChange}
              ownedAgents={
                agentsSnapshot &&
                agentsSnapshot.ownerId === visibilityOwnerId &&
                agentsSnapshot?.profileKey === visibilityProfileKey
                  ? agentsSnapshot.agents
                  : []
              }
              chiefName={chiefAgent?.name ?? "Chief of Staff"}
              panelHost={sourcesPanelHost}
              onSourcesOpenChange={(open) => {
                setSourcesOpen(open);
                if (open) shellActions.current?.showContext();
              }}
              onContextChange={setArtifactContext}
              onMakeWorkItems={(source, kind) => {
                setDocumentWorkItemIntent({
                  id: crypto.randomUUID(),
                  projectId: personalProject.id,
                  ownerId: visibilityOwnerId ?? null,
                  profileKey: visibilityProfileKey ?? null,
                  sourceId: source.id,
                  prompt: `Turn ${source.name} into ${kind}`
                });
                setCloseInspectorSignal((value) => value + 1);
                setSourcesOpen(false);
                setArtifactContext(null);
              }}
              closeSignal={closeInspectorSignal}
              onSelectConversation={openNowNeed}
              onOpenCitationMessage={openCitationMessage}
              onOpenPrivateHq={() => {
                setCloseInspectorSignal((value) => value + 1);
                setSourcesOpen(false);
                setArtifactContext(null);
                if (
                  document.querySelector(
                    'button[aria-label="Show project context"]'
                  )
                )
                  shellActions.current?.toggleContext();
              }}
              blockedConversationSessions={blockedConversationSessions}
            />
          ) : route.kind === "conversation" &&
            project &&
            conversationThread &&
            personalMemoryStore ? (
            <HqActiveConversation
              key={route.sessionId}
              agentsApi={agentsApi}
              helperAgents={ownedAgents}
              visibilityClient={visibilityClient}
              visibilityOwnerId={visibilityOwnerId}
              visibilityRevision={visibilityRevision}
              visibilityConnected={visibilityConnected ?? false}
              api={managedConversations ?? null}
              managedProject={managedProject ?? null}
              store={personalMemoryStore}
              project={project}
              thread={conversationThread}
              onOpenCitationMessage={openCitationMessage}
              onOfferChatForget={offerMemorySourceChatForget}
              onTextActionApply={applyTextAction}
              onTextActionNativeReview={reviewTextActionNative}
              onTextActionResumeMove={resumeTextActionMove}
              visibilityProfileKey={visibilityProfileKey ?? undefined}
              focusEventId={
                citationFocus?.generation ===
                  citationNavigationRef.current.generation &&
                citationFocus.projectId === route.projectId &&
                citationFocus.sessionId === route.sessionId
                  ? citationFocus.eventId
                  : null
              }
              draft={draft}
              inventoryOnly={Boolean(
                inventoryThread && !conversation && !draft
              )}
              lifecycle={managedConversationLifecycle}
              openFilePickerOnReady={attachAfterStart === route.sessionId}
              onRetryStart={() =>
                draftEntry && managedConversationLifecycle?.retry(draftEntry[0])
              }
              markdownAdapters={
                markdownAdapters ?? {
                  openExternal: () => undefined,
                  writeClipboard: (value) =>
                    navigator.clipboard.writeText(value)
                }
              }
              authorizeTransfer={authorizeManagedConversationTransfer}
            />
          ) : (
            <p
              className="hq-destination__empty"
              role={
                !project || (route.kind === "conversation" && !conversation)
                  ? "status"
                  : undefined
              }
            >
              {(!project &&
                !(
                  route.kind === "project" &&
                  personalProjects.some(({ id }) => id === route.projectId)
                )) ||
              (route.kind === "conversation" && !conversation)
                ? `This ${route.kind === "project" ? "Project" : "Conversation"} is no longer available.`
                : route.kind === "project"
                  ? "Your Project workspace will appear here."
                  : "Your Conversation will appear here."}
            </p>
          )}
        </section>
      </HqShell>
      {projectTeamIdentity && visibilityClient && sharedProjectStore ? (
        <HqProjectThread
          key={projectTeamIdentityKey}
          client={visibilityClient}
          sharedProjectStore={sharedProjectStore}
          identity={projectTeamIdentity}
          active={
            projectTab === "team" && rightColumnVisible && documentVisible
          }
          portalHost={projectTeamHost}
          onUnread={projectTeamUnreadChange}
          onPeople={setProjectTeamPeople}
        />
      ) : null}
      {projectMenu.ui}
      <HqSearch
        destinations={destinations}
        open={searchOpen}
        onOpenChange={setSearchOpen}
        onInvoke={invoke}
      />
      {projectsApi && visibilityClient ? (
        <HqShareSheet
          open={shareProjectId !== null}
          project={
            personalProjects.find((item) => item.id === shareProjectId) ?? null
          }
          projectsApi={projectsApi}
          collaboration={visibilityClient}
          onClose={() => setShareProjectId(null)}
          onShared={() => {
            void projectsStore?.refresh();
            setSharedRefreshSignal((value) => value + 1);
          }}
          onOpenSettings={renderSettings ? () => openSettings() : undefined}
        />
      ) : null}
      {settingsOpen && renderSettings
        ? (() => {
            const view = renderSettings(closeSettings, (sessionId, batchId) => {
              setChatDeleteNotice((notice) =>
                notice?.kind === "deleted" &&
                notice.sessionId === sessionId &&
                notice.batchId === batchId
                  ? null
                  : notice
              );
            });
            return isValidElement<HqSettingsProps>(view) &&
              view.type === HqSettings
              ? cloneElement(view, { initialSection: settingsSection })
              : view;
          })()
        : null}
      <HqChatDeleteControls
        request={chatDeleteRequest}
        notice={chatDeleteNotice}
        busy={chatDeleteBusy}
        onCancel={() => {
          chatIntentEpoch.current++;
          setChatDeleteRequest(null);
        }}
        onConfirm={() => void confirmChatDelete()}
        onDismiss={() => {
          chatIntentEpoch.current++;
          chatBusyRef.current = false;
          setChatDeleteBusy(false);
          setChatDeleteNotice(null);
        }}
        onUndo={() => void undoChatDelete()}
        onRetry={() => void retryChatDelete()}
      />
      {moveNotice ? (
        <div className="hq-chat-move__notice" role="status">
          <span>{moveNotice.message}</span>
          {moveNotice.undoable ? (
            <button
              type="button"
              onClick={() => {
                const notice = moveNoticeRef.current;
                if (notice && notice.undoable)
                  void assignPlacement(
                    notice.sessionId,
                    notice.toProjectId,
                    notice.fromProjectId,
                    true,
                    notice.moveBatchId
                  );
              }}
            >
              Undo
            </button>
          ) : moveNotice.pending ? (
            <button
              type="button"
              onClick={() => {
                const notice = moveNoticeRef.current;
                if (notice?.pending)
                  void assignPlacement(
                    notice.sessionId,
                    notice.fromProjectId,
                    notice.toProjectId
                  );
              }}
            >
              Retry
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Dismiss move notice"
            onClick={() => setMoveNotice(null)}
          >
            ×
          </button>
        </div>
      ) : null}
    </>
  );
}
