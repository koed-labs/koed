import type {
  CollaborationDurableSend,
  CollaborationSelection,
  CollaborationSnapshot,
  CollaborationThreadReference
} from "@koed/shared/collaboration";
import type { PersonalDesktopApi } from "@koed/shared/personal-desktop";
import { Button, ToastProvider } from "@koed/ui";
import { AlertTriangle, LoaderCircle } from "lucide-react";
import {
  useCallback,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore
} from "react";

import {
  createCollaborationRendererClient,
  type CollaborationRendererClient
} from "../collaboration/renderer-client.js";
import type {
  PersonalMemoryInspectorEvent,
  PersonalMemoryRoute
} from "./views/personal/index.js";
import { SharesStatusView } from "./views/personal/index.js";
import {
  ActionGrantStatus,
  CollaborationAnnouncementToast
} from "./collaboration/ActionGrantStatus.js";
import { useCollaborationController } from "./collaboration/useCollaborationController.js";
import {
  createNavigationState,
  currentNavigationEntry,
  navigationReducer,
  type DesktopRoute,
  type NavigationEntry
} from "./navigation.js";
import { CommandPalette } from "./CommandPalette.js";
import {
  commandEntriesForSnapshot,
  type DesktopCommand
} from "./command-palette.js";
import { DesktopStatusStore } from "./services/desktop-commands.js";
import { PersonalMemoryStore } from "./state/personal-memory.js";
import { sessionSelectionId } from "../project-memory-ui.js";
import type { ManagedConversationDesktopApi } from "../ipc/managed-conversation-protocol.js";
import { ThemeStore } from "./state/theme.js";
import { useDesktopStatus } from "./state/use-status.js";
import {
  AppShell,
  EmptyRoute,
  ScopeLine,
  type TeamRailItem
} from "./shell/AppShell.js";
import {
  PersonalContextNavigation,
  TeamContextNavigation
} from "./shell/ContextNavigation.js";
import { InboxView } from "./views/inbox/index.js";
import {
  compactHealthSummary,
  SetupChecklist,
  setupIsReady
} from "./views/onboarding/index.js";
import { PreferencesView } from "./views/preferences/index.js";
import { DevicesModal } from "./devices/DevicesModal.js";
import "./app.css";

const CollaborationRoutes = lazy(async () => {
  const module = await import("./collaboration/CollaborationRoutes.js");
  return { default: module.CollaborationRoutes };
});

const CollaborationModalLayer = lazy(async () => {
  const module = await import("./collaboration/CollaborationRoutes.js");
  return { default: module.CollaborationModalLayer };
});

const PersonalMemoryWorkspace = lazy(async () => {
  const module = await import("./views/personal/index.js");
  return { default: module.PersonalMemoryWorkspace };
});
const PersonalMemorySharesView = lazy(async () => {
  const module = await import("./collaboration/CollaborationRoutesImpl.js");
  return { default: module.PersonalMemoryView };
});

const fallbackCollaborationClient = (): CollaborationRendererClient =>
  createCollaborationRendererClient({
    command: async () => {
      throw new Error("Koed Desktop collaboration bridge is unavailable.");
    },
    subscribe: () => () => undefined
  });

const defaultClient = createCollaborationRendererClient(
  window.koedDesktop?.collaboration ?? {
    command: async () => {
      throw new Error("Koed Desktop collaboration bridge is unavailable.");
    },
    subscribe: () => () => undefined
  }
);
const statusStore = new DesktopStatusStore();
const themeStore = new ThemeStore();
const initialEntry = (onboardingComplete: boolean): NavigationEntry => ({
  authority: { backendId: null, principalId: "local-personal" },
  route: onboardingComplete
    ? { kind: "personal-memory-projects" }
    : { kind: "onboarding" }
});

type SharesRouteStatus =
  | { state: "ready" }
  | { state: "loading" }
  | {
      action: "connect" | "reconnect" | "retry" | "review" | null;
      actionLabel: string | null;
      message: string;
      state: "unavailable";
    };

const sharesRouteStatus = (
  snapshot: CollaborationSnapshot | null,
  loadState: "loading" | "ready" | "failed"
): SharesRouteStatus => {
  if (loadState === "failed") {
    return {
      action: "retry",
      actionLabel: "Retry",
      message: "Koed could not load your Shares.",
      state: "unavailable"
    };
  }
  if (!snapshot) {
    return loadState === "loading"
      ? { state: "loading" }
      : {
          action: "retry",
          actionLabel: "Retry",
          message: "Koed could not load your Shares.",
          state: "unavailable"
        };
  }
  switch (snapshot.connection.state) {
    case "live":
      return { state: "ready" };
    case "connecting":
      return { state: "loading" };
    case "reconnecting":
      return {
        action: null,
        actionLabel: null,
        message: "Koed is reconnecting to your Team.",
        state: "unavailable"
      };
    case "access_revoked":
      return {
        action: "review",
        actionLabel: "Review Access",
        message: "Your Team access was revoked.",
        state: "unavailable"
      };
    case "unavailable":
      return {
        action: "reconnect",
        actionLabel: "Retry",
        message: "Koed could not reach your Team.",
        state: "unavailable"
      };
    case "disconnected":
      return snapshot.connection.backendId
        ? {
            action: "reconnect",
            actionLabel: "Reconnect",
            message: "Reconnect to your Team to view your Shares.",
            state: "unavailable"
          }
        : {
            action: "connect",
            actionLabel: "Connect",
            message: "Connect to a Team to view your Shares.",
            state: "unavailable"
          };
  }
};

const selectionRoute = (selection: CollaborationSelection): DesktopRoute => {
  switch (selection.kind) {
    case "personal_memory":
      return { kind: "personal-memory-projects" };
    case "notes_to_self":
      return { kind: "personal-chat", threadId: "notes-to-self" };
    case "personal_channel":
      return { kind: "personal-chat", threadId: selection.threadId };
    case "team_people":
      return { kind: "team-people", teamId: selection.teamId };
    case "team_direct_message":
      return {
        kind: "team-direct-message",
        teamId: selection.teamId,
        threadId: selection.threadId
      };
    case "workspace_channel":
      return {
        kind: "workspace-channel",
        teamId: selection.teamId,
        workspaceId: selection.workspaceId,
        threadId: selection.threadId
      };
    case "workspace_shared_memory":
      return {
        kind: "workspace-shared-memory",
        teamId: selection.teamId,
        workspaceId: selection.workspaceId
      };
    case "shared_session":
      return {
        kind: "shared-session",
        teamId: selection.teamId,
        workspaceId: selection.workspaceId,
        sharedSessionId: selection.sharedSessionId
      };
  }
};

const selectionEntry = (
  snapshot: CollaborationSnapshot,
  selection: CollaborationSelection = snapshot.selection
): NavigationEntry => {
  return {
    route: selectionRoute(selection),
    authority: {
      backendId: "teamId" in selection ? snapshot.connection.backendId : null,
      principalId:
        "teamId" in selection
          ? (snapshot.navigation.teamPrincipal?.id ?? "unavailable")
          : snapshot.navigation.personalOwner.id,
      ...("teamId" in selection ? { teamId: selection.teamId } : {}),
      ...("workspaceId" in selection
        ? { workspaceId: selection.workspaceId }
        : {}),
      ...("threadId" in selection ? { threadId: selection.threadId } : {}),
      ...("sharedSessionId" in selection
        ? { sharedSessionId: selection.sharedSessionId }
        : {})
    }
  };
};

const routeTeamId = (route: DesktopRoute): string | null =>
  "teamId" in route ? route.teamId : null;

function StaticBreadcrumb({ labels }: { labels: readonly string[] }) {
  return (
    <nav
      aria-label={`Breadcrumb: ${labels.join(" / ")}`}
      className="desktop-breadcrumb"
    >
      {labels.map((label, index) => (
        <span key={`${index}:${label}`}>
          {index > 0 ? <span aria-hidden="true">/</span> : null}
          {index === labels.length - 1 ? <strong>{label}</strong> : label}
        </span>
      ))}
    </nav>
  );
}

const entryAuthorized = (
  entry: NavigationEntry,
  snapshot: CollaborationSnapshot
): boolean => {
  if (entry.route.kind === "inbox" || entry.route.kind === "onboarding") {
    return true;
  }
  const teamId = entry.authority.teamId ?? routeTeamId(entry.route);
  if (!teamId) {
    return (
      entry.authority.principalId === "local-personal" ||
      entry.authority.principalId === snapshot.navigation.personalOwner.id
    );
  }
  if (
    entry.authority.backendId !== snapshot.connection.backendId ||
    entry.authority.principalId !== snapshot.navigation.teamPrincipal?.id
  ) {
    return false;
  }
  const team = snapshot.navigation.teams.find(
    ({ id, lifecycle }) => id === teamId && lifecycle === "active"
  );
  if (!team) return false;
  const workspaceId =
    entry.authority.workspaceId ??
    ("workspaceId" in entry.route ? entry.route.workspaceId : undefined);
  if (
    workspaceId &&
    !team.workspaces.some(
      ({ id, lifecycle }) => id === workspaceId && lifecycle === "active"
    )
  ) {
    return false;
  }
  const threadId =
    entry.authority.threadId ??
    ("threadId" in entry.route ? entry.route.threadId : undefined);
  if (!threadId) return true;
  return (
    team.directMessages.some(({ id, lifecycle }) => {
      return id === threadId && lifecycle === "active";
    }) ||
    team.workspaces.some(({ channels }) =>
      channels.some(
        ({ id, lifecycle }) => id === threadId && lifecycle === "active"
      )
    ) ||
    (snapshot.view.kind === "shared_session" &&
      snapshot.view.companion.thread.id === threadId)
  );
};

const personalMemoryRoute = (route: DesktopRoute): PersonalMemoryRoute => {
  if (route.kind === "personal-memory-project") {
    return { kind: "project", projectId: route.projectId };
  }
  if (route.kind === "personal-memory-session") {
    return {
      kind: "session",
      projectId: route.projectId,
      sessionId: route.sessionId
    };
  }
  return { kind: "projects" };
};

const threadReference = (
  send: CollaborationDurableSend
): CollaborationThreadReference =>
  send.authority.scope === "personal"
    ? {
        scope: "personal",
        threadId: send.authority.threadId
      }
    : {
        scope: "team",
        teamId: send.authority.teamId,
        threadId: send.authority.threadId
      };

const readTheme = () => themeStore.current();

export type AppProps = {
  collaborationClient?: CollaborationRendererClient;
  completeOnboarding?: () => Promise<void> | void;
  initialCollaborationSelection?: CollaborationSelection;
  onboardingComplete?: boolean;
  managedConversations?: ManagedConversationDesktopApi | null;
  personalMemoryApi?: PersonalDesktopApi | null;
  statusReadyOverride?: boolean;
  statusStoreOverride?: DesktopStatusStore;
};

export function App({
  collaborationClient: client = defaultClient,
  completeOnboarding = () => undefined,
  initialCollaborationSelection,
  onboardingComplete = false,
  managedConversations = window.koedDesktop?.managedConversations ?? null,
  personalMemoryApi = window.koedDesktop?.personalMemory ?? null,
  statusReadyOverride,
  statusStoreOverride
}: AppProps = {}) {
  const activeStatusStore = statusStoreOverride ?? statusStore;
  const [navigation, dispatch] = useReducer(
    navigationReducer,
    undefined,
    () => {
      const initialSnapshot = client.current();
      return createNavigationState(
        initialCollaborationSelection && initialSnapshot
          ? selectionEntry(initialSnapshot, initialCollaborationSelection)
          : initialEntry(onboardingComplete)
      );
    }
  );
  const [inspector, setInspector] =
    useState<PersonalMemoryInspectorEvent | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [pendingDevicePairingLink, setPendingDevicePairingLink] = useState("");
  const [commandOpen, setCommandOpen] = useState(false);
  const [sharesLoadUnavailable, setSharesLoadUnavailable] = useState(false);
  const [managedConversationRevision, setManagedConversationRevision] =
    useState(0);
  const initialSelectionApplied = useRef(
    !initialCollaborationSelection || Boolean(client.current())
  );
  const personalMemoryStore = useMemo(
    () =>
      personalMemoryApi ? new PersonalMemoryStore(personalMemoryApi) : null,
    [personalMemoryApi]
  );
  const subscribePersonalMemory = useCallback(
    (listener: () => void) =>
      personalMemoryStore?.subscribe(listener) ?? (() => undefined),
    [personalMemoryStore]
  );
  const readPersonalMemory = useCallback(
    () => personalMemoryStore?.current() ?? null,
    [personalMemoryStore]
  );
  const personalMemorySnapshot = useSyncExternalStore(
    subscribePersonalMemory,
    readPersonalMemory,
    readPersonalMemory
  );
  const desktopStatus = useDesktopStatus(activeStatusStore);
  const localSetupReady =
    statusReadyOverride ??
    (desktopStatus.status ? setupIsReady(desktopStatus.status) : undefined);
  const theme = useSyncExternalStore(
    themeStore.subscribe,
    readTheme,
    readTheme
  );
  const collaboration = useCollaborationController(
    client,
    localSetupReady ?? false
  );
  const route = currentNavigationEntry(navigation).route;
  const snapshot = collaboration.snapshot;
  const liveHealthRefreshKey = useRef<string | null>(null);
  const activeTeamId = routeTeamId(route);
  const commands = useMemo(
    () => commandEntriesForSnapshot(snapshot, activeTeamId),
    [activeTeamId, snapshot]
  );

  useEffect(() => {
    void themeStore.load();
    if (statusReadyOverride === undefined) {
      void activeStatusStore.refresh();
    }
  }, [activeStatusStore, statusReadyOverride]);

  useEffect(() => {
    if (
      statusReadyOverride !== undefined ||
      snapshot?.connection.state !== "live"
    ) {
      return;
    }
    const key = `${snapshot.connection.backendId}:${snapshot.connection.connectedAt}`;
    if (liveHealthRefreshKey.current === key) return;
    liveHealthRefreshKey.current = key;
    void activeStatusStore.refresh();
  }, [
    activeStatusStore,
    snapshot?.connection.backendId,
    snapshot?.connection.connectedAt,
    snapshot?.connection.state,
    statusReadyOverride
  ]);

  useEffect(() => {
    const devices = window.koedDesktop?.devices;
    if (!devices) return;
    let active = true;
    const handledLinks = new Set<string>();
    const openPairingLink = (url: string) => {
      if (!active || handledLinks.has(url)) return;
      handledLinks.add(url);
      setPendingDevicePairingLink(url);
      setDevicesOpen(true);
    };
    const unsubscribe = devices.subscribePairingLinks((url) => {
      openPairingLink(url);
      void devices.consumePairingLink(url).catch(() => undefined);
    });
    void devices
      .consumePairingLink()
      .then((url) => {
        if (url) openPairingLink(url);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(
    () =>
      client.subscribe((_snapshot, update) => {
        if (
          update.kind === "realtime" &&
          (update.realtimeUpdate?.type === "managed_conversation_upserted" ||
            update.realtimeUpdate?.type === "personal_memory_upserted")
        ) {
          setManagedConversationRevision((revision) => revision + 1);
          personalMemoryStore?.refreshFromDurableEvent();
        }
      }),
    [client, personalMemoryStore]
  );

  useEffect(() => {
    if (!snapshot) return;
    if (initialCollaborationSelection && !initialSelectionApplied.current) {
      initialSelectionApplied.current = true;
      dispatch({
        type: "replace",
        entry: selectionEntry(snapshot, initialCollaborationSelection)
      });
    }
    dispatch({
      type: "reconcile-authority",
      isAuthorized: (entry) => entryAuthorized(entry, snapshot),
      fallback: {
        authority: {
          backendId: null,
          principalId: snapshot.navigation.personalOwner.id
        },
        route: { kind: "personal-memory-projects" }
      }
    });
    if (inspector && !personalMemoryStore) {
      setInspector(null);
      setInspectorOpen(false);
    }
  }, [
    inspector,
    snapshot?.connection.backendId,
    snapshot?.navigation.personalOwner.id,
    snapshot?.navigation.teamPrincipal?.id,
    snapshot?.selection,
    snapshot?.snapshotRevision
  ]);

  const navigate = (entry: NavigationEntry) => {
    setInspectorOpen(false);
    setInspector(null);
    dispatch({ type: "push", entry });
  };

  const choose = (selection: CollaborationSelection) => {
    if (snapshot) {
      navigate(selectionEntry(snapshot, selection));
    }
    collaboration.choose(selection);
  };

  const invokeCommand = (command: DesktopCommand) => {
    if (command.destination.kind === "selection") {
      choose(command.destination.selection);
      return;
    }
    navigate({
      authority: currentNavigationEntry(navigation).authority,
      route: command.destination.route
    });
  };

  const openPreferences = (
    section:
      | "general"
      | "capture"
      | "team-connection"
      | "about"
      | "advanced" = "general"
  ) =>
    navigate({
      authority: currentNavigationEntry(navigation).authority,
      route: { kind: "preferences", section }
    });

  if (route.kind === "onboarding") {
    return (
      <SetupChecklist
        onComplete={async () => {
          await completeOnboarding();
          navigate({
            authority: {
              backendId: null,
              principalId:
                snapshot?.navigation.personalOwner.id ?? "local-personal"
            },
            route: { kind: "personal-memory-projects" }
          });
        }}
        statusStore={activeStatusStore}
      />
    );
  }

  if (localSetupReady === undefined && !desktopStatus.error) {
    return (
      <main aria-live="polite" className="desktop-starting">
        Opening Koed…
      </main>
    );
  }

  if (
    localSetupReady !== true &&
    (desktopStatus.status?.state === "not_configured" ||
      desktopStatus.status === null)
  ) {
    return (
      <SetupChecklist
        onComplete={() => undefined}
        showTrustGuide={false}
        statusStore={activeStatusStore}
      />
    );
  }

  const activeScope =
    route.kind === "inbox"
      ? ("inbox" as const)
      : activeTeamId
        ? ({ teamId: activeTeamId } as const)
        : ("personal" as const);
  const team = activeTeamId
    ? (snapshot?.navigation.teams.find(({ id }) => id === activeTeamId) ?? null)
    : null;
  const teamRail: TeamRailItem[] =
    snapshot?.navigation.teams
      .filter(({ lifecycle }) => lifecycle !== "purged")
      .map((item) => ({
        connectionState:
          snapshot.connection.state === "live"
            ? "healthy"
            : snapshot.connection.state === "disconnected" ||
                snapshot.connection.state === "access_revoked"
              ? "offline"
              : "degraded",
        id: item.id,
        name: item.name,
        unreadCount: item.unreadCount
      })) ?? [];
  const currentSharesStatus = sharesRouteStatus(
    snapshot,
    collaboration.loadState
  );
  const sharesUnavailable =
    currentSharesStatus.state === "unavailable" || sharesLoadUnavailable;

  const contextNavigation =
    team && snapshot ? (
      <TeamContextNavigation
        directMessages={team.directMessages.map((thread) => ({
          id: thread.id,
          label:
            thread.name ??
            thread.participants
              .filter(({ id }) => id !== snapshot.navigation.teamPrincipal?.id)
              .map(({ displayName }) => displayName)
              .join(", ") ??
            "Direct message",
          selected:
            route.kind === "team-direct-message" &&
            route.threadId === thread.id,
          unreadCount: thread.unreadCount
        }))}
        onCreateChannel={(workspaceId) =>
          collaboration.setModal({
            kind: "workspace_channel",
            teamId: team.id,
            workspaceId
          })
        }
        onCreateWorkspace={
          team.role === "owner" || team.role === "admin"
            ? () =>
                collaboration.setModal({
                  kind: "workspace",
                  teamId: team.id
                })
            : undefined
        }
        onOpenPeople={() => choose({ kind: "team_people", teamId: team.id })}
        onOpenSharedMemory={(workspaceId) =>
          choose({
            kind: "workspace_shared_memory",
            teamId: team.id,
            workspaceId
          })
        }
        onSelectChannel={(workspaceId, threadId) =>
          choose({
            kind: "workspace_channel",
            teamId: team.id,
            workspaceId,
            threadId
          })
        }
        onSelectDirectMessage={(threadId) =>
          choose({
            kind: "team_direct_message",
            teamId: team.id,
            threadId
          })
        }
        onStartDirectMessage={() =>
          collaboration.setModal({
            kind: "direct_message",
            teamId: team.id,
            group: false
          })
        }
        peopleSelected={route.kind === "team-people"}
        role={team.role}
        teamName={team.name}
        workspaces={team.workspaces
          .filter(({ lifecycle }) => lifecycle !== "purged")
          .map((workspace) => ({
            canCreateChannel:
              workspace.lifecycle === "active" && workspace.access === "write",
            channels: workspace.channels.map((thread) => ({
              archived: thread.lifecycle === "archived",
              id: thread.id,
              label: thread.name ?? "Channel",
              selected:
                route.kind === "workspace-channel" &&
                route.threadId === thread.id,
              unreadCount: thread.unreadCount
            })),
            id: workspace.id,
            label: workspace.name,
            selected:
              "workspaceId" in route && route.workspaceId === workspace.id,
            sharedMemorySelected:
              (route.kind === "workspace-shared-memory" ||
                route.kind === "shared-session") &&
              route.workspaceId === workspace.id,
            sharedMemoryUnreadCount: workspace.sharedMemory.reduce(
              (count, memory) => count + memory.unreadCompanionCount,
              0
            )
          }))}
      />
    ) : (
      <PersonalContextNavigation
        channels={
          snapshot?.navigation.personal.channels.map((thread) => ({
            archived: thread.lifecycle === "archived",
            id: thread.id,
            label: thread.name ?? "Channel",
            selected:
              route.kind === "personal-chat" && route.threadId === thread.id,
            unreadCount: thread.unreadCount
          })) ?? []
        }
        notesSelected={
          route.kind === "personal-chat" &&
          snapshot?.selection.kind === "notes_to_self"
        }
        onCreateChannel={() =>
          collaboration.setModal({ kind: "personal_channel" })
        }
        onOpenNotes={() => choose({ kind: "notes_to_self" })}
        onOpenProjects={() =>
          navigate({
            authority: {
              backendId: null,
              principalId:
                snapshot?.navigation.personalOwner.id ?? "local-personal"
            },
            route: { kind: "personal-memory-projects" }
          })
        }
        onOpenShares={() =>
          navigate({
            authority: {
              backendId: null,
              principalId:
                snapshot?.navigation.personalOwner.id ?? "local-personal"
            },
            route: { kind: "personal-memory-shares" }
          })
        }
        onSelectChannel={(threadId) =>
          choose({ kind: "personal_channel", threadId })
        }
        projectsSelected={
          route.kind.startsWith("personal-memory") &&
          route.kind !== "personal-memory-shares"
        }
        sharesSelected={route.kind === "personal-memory-shares"}
        sharesUnavailable={sharesUnavailable}
      />
    );

  const personalBreadcrumb = (() => {
    if (!route.kind.startsWith("personal-memory")) return null;
    if (route.kind === "personal-memory-shares") {
      return <StaticBreadcrumb labels={["Personal", "Shares"]} />;
    }
    const selectedProject =
      "projectId" in route
        ? personalMemorySnapshot?.projectsById.get(route.projectId)
        : null;
    const selectedThread =
      route.kind === "personal-memory-session"
        ? selectedProject?.threads.find(
            (thread) => sessionSelectionId(thread) === route.sessionId
          )
        : null;
    return (
      <nav className="desktop-breadcrumb" aria-label="Breadcrumb">
        <span>Personal</span>
        <span aria-hidden="true">/</span>
        <button
          type="button"
          onClick={() =>
            navigate({
              authority: {
                backendId: null,
                principalId:
                  snapshot?.navigation.personalOwner.id ?? "local-personal"
              },
              route: { kind: "personal-memory-projects" }
            })
          }
        >
          Projects
        </button>
        {selectedProject ? (
          <>
            <span aria-hidden="true">/</span>
            {route.kind === "personal-memory-session" ? (
              <button
                type="button"
                onClick={() =>
                  navigate({
                    authority: {
                      backendId: null,
                      principalId:
                        snapshot?.navigation.personalOwner.id ??
                        "local-personal"
                    },
                    route: {
                      kind: "personal-memory-project",
                      projectId: selectedProject.id
                    }
                  })
                }
              >
                {selectedProject.name}
              </button>
            ) : (
              <strong>{selectedProject.name}</strong>
            )}
          </>
        ) : null}
        {route.kind === "personal-memory-session" ? (
          <>
            <span aria-hidden="true">/</span>
            <strong>{selectedThread?.name || "Captured Session"}</strong>
          </>
        ) : null}
      </nav>
    );
  })();
  const collaborationBreadcrumb = (() => {
    if (route.kind === "inbox") {
      return <StaticBreadcrumb labels={["Inbox"]} />;
    }
    if (route.kind === "personal-chat") {
      if (
        route.threadId === "notes-to-self" ||
        snapshot?.selection.kind === "notes_to_self"
      ) {
        return <StaticBreadcrumb labels={["Notes to self"]} />;
      }
      const channel = snapshot?.navigation.personal.channels.find(
        ({ id }) => id === route.threadId
      );
      return (
        <StaticBreadcrumb labels={["Personal", channel?.name ?? "Channel"]} />
      );
    }
    if (!team || !("teamId" in route)) return null;
    if (route.kind === "team-people") {
      return <StaticBreadcrumb labels={[team.name, "People"]} />;
    }
    if (route.kind === "team-direct-message") {
      const thread = team.directMessages.find(
        ({ id }) => id === route.threadId
      );
      const otherPeople = thread?.participants
        .filter(({ id }) => id !== snapshot?.navigation.teamPrincipal?.id)
        .map(({ displayName }) => displayName)
        .join(", ");
      return (
        <StaticBreadcrumb
          labels={[
            team.name,
            "Direct messages",
            thread?.name || otherPeople || "Direct message"
          ]}
        />
      );
    }
    const workspace = team.workspaces.find(
      ({ id }) => id === route.workspaceId
    );
    const workspaceName = workspace?.name ?? "Workspace";
    if (route.kind === "workspace-channel") {
      const channel = workspace?.channels.find(
        ({ id }) => id === route.threadId
      );
      return (
        <StaticBreadcrumb
          labels={[team.name, workspaceName, channel?.name ?? "Channel"]}
        />
      );
    }
    if (route.kind === "workspace-shared-memory") {
      return (
        <StaticBreadcrumb
          labels={[team.name, workspaceName, "Shared Memory"]}
        />
      );
    }
    const session = workspace?.sharedMemory.find(
      ({ id }) => id === route.sharedSessionId
    );
    return (
      <StaticBreadcrumb
        labels={[
          team.name,
          workspaceName,
          "Shared Memory",
          session?.title ?? "Captured Session"
        ]}
      />
    );
  })();
  const scopeLine =
    personalBreadcrumb ??
    collaborationBreadcrumb ??
    "Personal · Private to you";

  let content;
  if (route.kind === "inbox") {
    content = (
      <InboxView
        activeApprovals={collaboration.actionGrants
          .filter(
            ({ state }) =>
              state === "awaiting_approval" ||
              state === "awaiting_review" ||
              state === "approved" ||
              state === "executing"
          )
          .map((grant) => ({
            expiresAt: grant.expiresAt,
            id: grant.id,
            scope: "Protected operation",
            title: grant.operation
          }))}
        error={collaboration.error}
        loading={collaboration.loadState === "loading"}
        onOpenPreferences={openPreferences}
        onOpenSelection={choose}
        onCopyOutbox={async (send) => {
          if (send.body) {
            await collaboration.markdownAdapters.writeClipboard(send.body);
          }
        }}
        onRefresh={async () => {
          await client.load();
        }}
        onRetryOutbox={async (send) => {
          if (!send.body) return;
          await client.retryMessage({
            body: send.body,
            clientMessageId: send.clientMessageId,
            thread: threadReference(send)
          });
        }}
        snapshot={snapshot}
      />
    );
  } else if (route.kind === "personal-memory-shares") {
    if (currentSharesStatus.state !== "ready") {
      let onAction: (() => void) | undefined;
      if (currentSharesStatus.state === "unavailable") {
        switch (currentSharesStatus.action) {
          case "retry":
            onAction = collaboration.retry;
            break;
          case "connect":
          case "review":
            onAction = () => openPreferences("team-connection");
            break;
          case "reconnect":
            onAction = () => void client.reconnect().catch(() => undefined);
            break;
          case null:
            break;
        }
      }
      content = (
        <SharesStatusView
          actionLabel={
            currentSharesStatus.state === "unavailable"
              ? (currentSharesStatus.actionLabel ?? undefined)
              : undefined
          }
          message={
            currentSharesStatus.state === "unavailable"
              ? currentSharesStatus.message
              : undefined
          }
          onAction={onAction}
          state={currentSharesStatus.state}
        />
      );
    } else if (snapshot) {
      content = (
        <Suspense fallback={<SharesStatusView state="loading" />}>
          <PersonalMemorySharesView
            client={client}
            initialSection="shares"
            initialShareKey={route.shareKey}
            markdownAdapters={collaboration.markdownAdapters}
            onAvailabilityChange={setSharesLoadUnavailable}
            onOpenProjects={() =>
              navigate({
                authority: {
                  backendId: null,
                  principalId: snapshot.navigation.personalOwner.id
                },
                route: { kind: "personal-memory-projects" }
              })
            }
            onShare={(sessionId) =>
              collaboration.setModal({
                kind: "share_personal_memory",
                sessionId
              })
            }
            onSelectShare={(shareKey) =>
              navigate({
                authority: {
                  backendId: null,
                  principalId: snapshot.navigation.personalOwner.id
                },
                route: { kind: "personal-memory-shares", shareKey }
              })
            }
            snapshot={snapshot}
          />
        </Suspense>
      );
    } else {
      content = (
        <SharesStatusView
          actionLabel="Retry"
          message="Koed could not load your Shares."
          onAction={collaboration.retry}
          state="unavailable"
        />
      );
    }
  } else if (route.kind.startsWith("personal-memory")) {
    content =
      personalMemoryStore && personalMemoryApi ? (
        <Suspense
          fallback={
            <EmptyRoute
              description="Loading protected Personal Memory."
              icon={<LoaderCircle aria-hidden="true" />}
              title="Opening Personal Memory"
            />
          }
        >
          <PersonalMemoryWorkspace
            assignSessionProject={personalMemoryApi.assignSessionProject}
            authorizeManagedConversationTransfer={
              client.authorizeManagedConversationTransfer
            }
            managedConversationRevision={managedConversationRevision}
            managedConversations={managedConversations}
            markdownAdapters={collaboration.markdownAdapters}
            onInspectEvent={(event) => {
              setInspector(event);
              setInspectorOpen(true);
            }}
            onNavigate={(next) => {
              const nextRoute: DesktopRoute =
                next.kind === "projects"
                  ? { kind: "personal-memory-projects" }
                  : next.kind === "project"
                    ? {
                        kind: "personal-memory-project",
                        projectId: next.projectId
                      }
                    : {
                        kind: "personal-memory-session",
                        projectId: next.projectId,
                        sessionId: next.sessionId
                      };
              navigate({
                authority: {
                  backendId: null,
                  principalId:
                    snapshot?.navigation.personalOwner.id ?? "local-personal"
                },
                route: nextRoute
              });
            }}
            onShareToWorkspace={({ source }) => {
              collaboration.setModal({
                kind: "share_personal_memory",
                sessionId: source.sessionId,
                ...(source.localEntry ? { localEntry: source.localEntry } : {})
              });
            }}
            route={personalMemoryRoute(route)}
            sharingRecords={
              snapshot?.navigation.personal.memory.map((entry) => ({
                entryId: entry.id,
                logicalMemoryId: entry.logicalMemoryId,
                sessionId: entry.id,
                syncState: entry.syncState
              })) ?? []
            }
            store={personalMemoryStore}
            workspaceCandidates={
              snapshot?.navigation.teams.flatMap((candidateTeam) =>
                candidateTeam.workspaces.map((workspace) => ({
                  access: workspace.access,
                  authorized: candidateTeam.lifecycle === "active",
                  lifecycle:
                    workspace.lifecycle === "purged"
                      ? "removed"
                      : workspace.lifecycle,
                  name: workspace.name,
                  teamId: candidateTeam.id,
                  teamLifecycle:
                    candidateTeam.lifecycle === "active"
                      ? "active"
                      : candidateTeam.lifecycle === "suspended"
                        ? "suspended"
                        : "removed",
                  teamName: candidateTeam.name,
                  workspaceId: workspace.id
                }))
              ) ?? []
            }
          />
        </Suspense>
      ) : (
        <EmptyRoute
          description="The protected Personal Memory bridge is unavailable in this window."
          title="Personal Memory unavailable"
        />
      );
  } else if (route.kind === "preferences") {
    content = (
      <PreferencesView
        collaborationClient={client}
        collaborationSnapshot={snapshot}
        initialSection={route.section}
        onSectionChange={(section) =>
          dispatch({
            type: "replace",
            entry: {
              authority: currentNavigationEntry(navigation).authority,
              route: { kind: "preferences", section }
            }
          })
        }
        onThemeChange={(preference) => void themeStore.set(preference)}
        statusStore={activeStatusStore}
        theme={theme.preference}
        version="0.4.4"
      />
    );
  } else if (snapshot) {
    content = (
      <Suspense
        fallback={
          <EmptyRoute
            description="Loading the authorized route."
            icon={<LoaderCircle aria-hidden="true" />}
            title="Opening view"
          />
        }
      >
        <CollaborationRoutes
          client={client}
          drafts={collaboration.drafts}
          markdownAdapters={collaboration.markdownAdapters}
          onModalChange={collaboration.setModal}
          onRequestSelection={choose}
          selectionFailure={collaboration.selectionFailure}
          selectionLoading={collaboration.selectionLoading}
          snapshot={snapshot}
        />
      </Suspense>
    );
  } else {
    content = (
      <EmptyRoute
        action={
          collaboration.loadState === "failed" ? (
            <Button onClick={collaboration.retry}>Retry</Button>
          ) : null
        }
        description={
          collaboration.error ?? "Loading the authorized collaboration state."
        }
        icon={
          collaboration.loadState === "failed" ? (
            <AlertTriangle aria-hidden="true" />
          ) : (
            <LoaderCircle aria-hidden="true" />
          )
        }
        title={
          collaboration.loadState === "failed"
            ? "Collaboration unavailable"
            : "Loading collaboration"
        }
      />
    );
  }

  return (
    <ToastProvider>
      <AppShell
        activeScope={activeScope}
        canGoBack={navigation.index > 0}
        canGoForward={navigation.index < navigation.entries.length - 1}
        contextNavigation={contextNavigation}
        health={(() => {
          const summary = compactHealthSummary(desktopStatus.status);
          return {
            label: summary.label,
            state:
              summary.state === "healthy"
                ? "healthy"
                : summary.state === "fault"
                  ? "needs_attention"
                  : "starting"
          } as const;
        })()}
        identityLabel={
          snapshot?.navigation.teamPrincipal?.displayName ??
          snapshot?.navigation.personalOwner.displayName ??
          "Local User"
        }
        inspector={
          inspector ? (
            <dl className="desktop-event-inspector">
              <div>
                <dt>Type</dt>
                <dd>{inspector.event.eventType.replaceAll("_", " ")}</dd>
              </div>
              <div>
                <dt>Captured</dt>
                <dd>{new Date(inspector.event.timestamp).toLocaleString()}</dd>
              </div>
              <div>
                <dt>Captured Session</dt>
                <dd>{inspector.thread.name ?? "Untitled session"}</dd>
              </div>
              <div>
                <dt>Project</dt>
                <dd>{inspector.project.name}</dd>
              </div>
            </dl>
          ) : undefined
        }
        inspectorLabel="Memory Event"
        inspectorOpen={inspectorOpen}
        onActivateInbox={() =>
          navigate({
            authority: currentNavigationEntry(navigation).authority,
            route: { kind: "inbox" }
          })
        }
        onActivatePersonal={() =>
          navigate({
            authority: {
              backendId: null,
              principalId:
                snapshot?.navigation.personalOwner.id ?? "local-personal"
            },
            route: { kind: "personal-memory-projects" }
          })
        }
        onActivateTeam={(teamId) => choose({ kind: "team_people", teamId })}
        onAddTeam={() => collaboration.setModal({ kind: "create_or_join" })}
        onCloseInspector={() => setInspectorOpen(false)}
        onGoBack={() => {
          setInspector(null);
          setInspectorOpen(false);
          dispatch({ type: "back" });
        }}
        onGoForward={() => {
          setInspector(null);
          setInspectorOpen(false);
          dispatch({ type: "forward" });
        }}
        onOpenCommandPalette={() => setCommandOpen(true)}
        onOpenDevices={() => setDevicesOpen(true)}
        onOpenHealth={() => openPreferences("advanced")}
        onOpenPreferences={() => openPreferences()}
        onToggleInspector={() =>
          setInspectorOpen((current) => Boolean(inspector) && !current)
        }
        personalUnreadCount={
          snapshot
            ? snapshot.navigation.personal.notesToSelf.unreadCount +
              snapshot.navigation.personal.channels.reduce(
                (total, channel) => total + channel.unreadCount,
                0
              )
            : 0
        }
        scopeLine={<ScopeLine>{scopeLine}</ScopeLine>}
        teams={teamRail}
        routeFocusKey={JSON.stringify(route)}
      >
        <CollaborationAnnouncementToast
          announcement={collaboration.announcement}
          clearAnnouncement={collaboration.clearAnnouncement}
        />
        <ActionGrantStatus
          actionGrants={collaboration.actionGrants}
          client={client}
        />
        {content}
      </AppShell>

      <CommandPalette
        commands={commands}
        onInvoke={invokeCommand}
        onOpenChange={setCommandOpen}
        open={commandOpen}
      />

      {devicesOpen ? (
        <DevicesModal
          initialPairingLink={pendingDevicePairingLink}
          onClose={() => {
            setDevicesOpen(false);
            setPendingDevicePairingLink("");
          }}
        />
      ) : null}

      {snapshot ? (
        <Suspense fallback={null}>
          <CollaborationModalLayer
            client={client}
            markdownAdapters={collaboration.markdownAdapters}
            modal={collaboration.modal}
            onModalChange={collaboration.setModal}
            onViewShare={(shareKey) => {
              collaboration.setModal(null);
              navigate({
                authority: {
                  backendId: null,
                  principalId: snapshot.navigation.personalOwner.id
                },
                route: { kind: "personal-memory-shares", shareKey }
              });
            }}
            snapshot={snapshot}
          />
        </Suspense>
      ) : null}

      <div
        aria-atomic="true"
        aria-live="polite"
        className="desktop-live-region"
      >
        {collaboration.liveAnnouncement ? (
          <span key={collaboration.liveAnnouncement.id}>
            {collaboration.liveAnnouncement.text}
          </span>
        ) : null}
      </div>
    </ToastProvider>
  );
}

export const createFallbackCollaborationClientForTests =
  fallbackCollaborationClient;
