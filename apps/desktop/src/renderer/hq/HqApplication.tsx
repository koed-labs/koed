import {
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
import type { PersonalDesktopApi } from "@koed/shared/personal-desktop";
import type { ManagedProjectDesktopApi } from "../../ipc/managed-project-protocol.js";
import type { ProjectsDesktopApi } from "../../ipc/projects-protocol.js";
import { ProjectsStore } from "./useProjects.js";
import { AgentsStore } from "./agents/agents-store.js";
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
import { hqSettingsShortcut } from "./settings/HqSettings.js";
import { reconcileHqRoute, type HqRoute } from "./hq-navigation.js";
import { usePersonalProjectsLoader } from "./use-personal-projects-loader.js";
import { useProjectMenuActions } from "./useProjectMenuActions.js";
import { NowView } from "./now/NowView.js";
import { HqProjectConversation } from "./project/HqProjectConversation.js";
import { HqProjectView } from "./project/HqProjectView.js";
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
  localAiClients
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
    onChatRestored?: (sessionId: string, batchId: string | null) => void
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
}) {
  const [selection, setSelection] = useState<{
    route: HqRoute;
    project?: DesktopProject;
  }>({ route: { kind: "home" } });
  const [searchOpen, setSearchOpen] = useState(false);
  const [citationFocus, setCitationFocus] = useState<{
    projectId: string;
    sessionId: string;
    eventId: string;
    generation: number;
  } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  const [artifactContext, setArtifactContext] = useState<string | null>(null);
  const [nowMemoryOpen, setNowMemoryOpen] = useState(false);
  const [nowMemoryHost, setNowMemoryHost] = useState<HTMLDivElement | null>(
    null
  );
  const [closeInspectorSignal, setCloseInspectorSignal] = useState(0);
  const [sourcesPanelHost, setSourcesPanelHost] =
    useState<HTMLDivElement | null>(null);
  const shellActions = useRef<HqShellActions>(null);
  const [projectsStore] = useState(() =>
    projectsApi ? new ProjectsStore(projectsApi) : null
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
          void projectsStore.refresh();
          void personalMemoryStore?.loadProjects({ silent: true });
          return;
        }
        if (update.kind !== "realtime") return;
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
  const chiefAgent =
    agentsSnapshot &&
    agentsSnapshot.ownerId === visibilityOwnerId &&
    agentsSnapshot.profileKey === visibilityProfileKey
      ? (agentsSnapshot.agents.find((agent) => agent.isChiefOfStaff) ?? null)
      : null;
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
    mode: "delete" | "forget"
  ) => {
    if (!visibilityOwnerId || !visibilityProfileKey || chatBusyRef.current)
      return;
    chatIntentEpoch.current++;
    const token = chatToken();
    setChatDeleteRequest({ projectId, sessionId, title, mode, running: null });
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
      const requestedBatchId = crypto.randomUUID();
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
    onOpenProject: (projectId) => selectRoute({ kind: "project", projectId })
  });
  const personalProject =
    route.kind === "project"
      ? personalProjects.find(({ id }) => id === route.projectId)
      : undefined;
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
  destinations.push(
    ...hqLayoutCommands(Boolean(renderSettings), contextAvailable)
  );
  const openSettings = useCallback(() => {
    if (!renderSettings || settingsOpen) return;
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
  }, [renderSettings, settingsOpen]);
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
        inspectorOpen={sourcesOpen}
        panelHostRef={setSourcesPanelHost}
        contextLabel={artifactContext}
        onClearContext={() => {
          setCloseInspectorSignal((value) => value + 1);
          setSourcesOpen(false);
          setArtifactContext(null);
        }}
      />
    ) : undefined;
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
  return (
    <>
      <HqShell
        actionsRef={shellActions}
        contextAvailable={contextAvailable}
        contextContent={
          route.kind === "home" && nowMemoryOpen ? (
            <div className="hq-now-memory-host" ref={setNowMemoryHost} />
          ) : (
            projectHqContent
          )
        }
        title={title}
        route={route}
        sidebar={({ compact }) => (
          <HqSidebar
            compact={compact}
            revealProject={revealProject}
            accountIdentity={accountIdentity}
            onOpenSettings={renderSettings ? openSettings : undefined}
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
                  onSelectConversation={openNowNeed}
                />
              ) : null}
            </>
          ) : route.kind === "home" ? (
            <NowView
              key={visibilityOwnerId ?? "no-owner"}
              projects={projects}
              personalProjects={projectsStore ? personalProjects : undefined}
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
              onSelectConversation={openNowNeed}
            />
          ) : route.kind === "project" && personalProject && projectsApi ? (
            <HqProjectView
              key={`${visibilityOwnerId ?? "no-owner"}:${visibilityProfileKey ?? "no-profile"}:${personalProject.id}`}
              project={personalProject}
              personalProjects={personalProjects}
              graphProjects={projects}
              projectsApi={projectsApi}
              curatedMemoryApi={window.koedDesktop?.curatedMemory}
              agentsApi={agentsApi}
              conversationsApi={managedConversations}
              managedProject={managedProject ?? null}
              lifecycle={managedConversationLifecycle}
              ownerId={visibilityOwnerId}
              profileKey={visibilityProfileKey}
              ownedAgents={
                agentsSnapshot &&
                agentsSnapshot.ownerId === visibilityOwnerId &&
                agentsSnapshot?.profileKey === visibilityProfileKey
                  ? agentsSnapshot.agents
                  : []
              }
              panelHost={sourcesPanelHost}
              onSourcesOpenChange={(open) => {
                setSourcesOpen(open);
                if (open) shellActions.current?.showContext();
              }}
              onContextChange={setArtifactContext}
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
      {projectMenu.ui}
      <HqSearch
        destinations={destinations}
        open={searchOpen}
        onOpenChange={setSearchOpen}
        onInvoke={invoke}
      />
      {settingsOpen && renderSettings
        ? renderSettings(closeSettings, (sessionId, batchId) => {
            setChatDeleteNotice((notice) =>
              notice?.kind === "deleted" &&
              notice.sessionId === sessionId &&
              notice.batchId === batchId
                ? null
                : notice
            );
          })
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
