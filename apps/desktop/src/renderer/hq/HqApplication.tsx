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
import type { PersonalDesktopProjectThread } from "@koed/shared/personal-desktop";
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
import { HqSearch } from "./HqSearch.js";
import { hqLayoutCommands, type HqCommand } from "./hq-command-palette.js";
import { hqSettingsShortcut } from "./settings/HqSettings.js";
import { reconcileHqRoute, type HqRoute } from "./hq-navigation.js";
import { usePersonalProjectsLoader } from "./use-personal-projects-loader.js";
import { NowView } from "./now/NowView.js";
import { nowConversationDestination, type NowNeed } from "./now/now-model.js";

const subscribeEmpty = () => () => undefined;
const emptySnapshot = () => null;
const emptyApprovals: readonly CollaborationActionGrantProjection[] = [];
const approvalsEmptySnapshot = () => emptyApprovals;
const emptyPersonalProjects: readonly import("@koed/shared").Project[] = [];

export function HqApplication({
  personalMemoryStore,
  personalMemoryReady,
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
  managedProject,
  managedConversationLifecycle,
  markdownAdapters,
  onResolveIndependent,
  authorizeManagedConversationTransfer,
  localAiClients
}: {
  personalMemoryStore: PersonalMemoryStore | null;
  personalMemoryReady: boolean;
  projectsApi?: ProjectsDesktopApi | null;
  agentsApi?: DesktopApi["agents"];
  visibilityClient?: CollaborationRendererClient;
  visibilityOwnerId?: string | null;
  visibilityProfileKey?: string | null;
  visibilityRevision?: string | null;
  visibilityConnected?: boolean;
  renderSettings?: (onClose: () => void) => ReactNode;
  accountIdentity?: HqAccountIdentity;
  managedConversations?: ManagedConversationDesktopApi | null;
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [blankOpen, setBlankOpen] = useState(false);
  const [inventoryTarget, setInventoryTarget] = useState<NowNeed | null>(null);
  const [blankProjectId, setBlankProjectId] = useState<string | null>(null);
  const [blankProjectError, setBlankProjectError] = useState("");
  const [blankIntent, setBlankIntent] = useState(0);
  const [blankLaunchPending, setBlankLaunchPending] = useState(false);
  const [attachAfterStart, setAttachAfterStart] = useState<string | null>(null);
  const shellActions = useRef<HqShellActions>(null);
  const [projectsStore] = useState(() =>
    projectsApi ? new ProjectsStore(projectsApi) : null
  );
  const [agentsStore] = useState(() =>
    agentsApi ? new AgentsStore(agentsApi) : null
  );
  useSyncExternalStore(
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
  const route =
    selection.route.kind === "project" && projectsStore
      ? selection.route
      : reconcileHqRoute(selection.route, selection.project, projects);
  const contextAvailable =
    route.kind === "project" &&
    (projectsStore
      ? personalProjects.some(({ id }) => id === route.projectId)
      : projects.some(
          (item) =>
            item.id === route.projectId && item.contextKind === "project"
        ));
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
    setInventoryTarget(null);
    setBlankOpen(false);
    setBlankLaunchPending(false);
    setAttachAfterStart(null);
    setSelection({
      route: next,
      project:
        next.kind === "home"
          ? undefined
          : projects.find(({ id }) => id === next.projectId)
    });
  };
  const project =
    route.kind === "conversation"
      ? projects.find(({ id }) => id === route.projectId)
      : projectsStore
        ? undefined
        : route.kind === "project"
          ? projects.find(({ id }) => id === route.projectId)
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
  return (
    <>
      <HqShell
        actionsRef={shellActions}
        contextAvailable={contextAvailable}
        title={title}
        route={route}
        sidebar={({ compact }) => (
          <HqSidebar
            compact={compact}
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
            onOpenNow={() => selectRoute({ kind: "home" })}
            nowActive={route.kind === "home" && !blankOpen}
            onSelectConversation={(projectId, sessionId) =>
              selectRoute({ kind: "conversation", projectId, sessionId })
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
      <HqSearch
        destinations={destinations}
        open={searchOpen}
        onOpenChange={setSearchOpen}
        onInvoke={invoke}
      />
      {settingsOpen && renderSettings ? renderSettings(closeSettings) : null}
    </>
  );
}
