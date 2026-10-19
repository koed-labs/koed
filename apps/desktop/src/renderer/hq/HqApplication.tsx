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
import { HqShell, type HqShellActions } from "./HqShell.js";
import { HqSidebar, type HqAccountIdentity } from "./HqSidebar.js";
import { HqSearch } from "./HqSearch.js";
import { hqLayoutCommands, type HqCommand } from "./hq-command-palette.js";
import { hqSettingsShortcut } from "./settings/HqSettings.js";
import { reconcileHqRoute, type HqRoute } from "./hq-navigation.js";
import { usePersonalProjectsLoader } from "./use-personal-projects-loader.js";

const subscribeEmpty = () => () => undefined;
const emptySnapshot = () => null;

export function HqApplication({
  personalMemoryStore,
  personalMemoryReady,
  renderSettings,
  accountIdentity
}: {
  personalMemoryStore: PersonalMemoryStore | null;
  personalMemoryReady: boolean;
  renderSettings?: (onClose: () => void) => ReactNode;
  accountIdentity?: HqAccountIdentity;
}) {
  const [selection, setSelection] = useState<{
    route: HqRoute;
    project?: DesktopProject;
  }>({ route: { kind: "home" } });
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const shellActions = useRef<HqShellActions>(null);
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
  const projects = useMemo(
    () =>
      snapshot?.projectOrder.flatMap((id) => {
        const project = snapshot.projectsById.get(id);
        return project ? [project] : [];
      }) ?? [],
    [snapshot]
  );
  const route = reconcileHqRoute(selection.route, selection.project, projects);
  const selectRoute = (next: HqRoute) =>
    setSelection({
      route: next,
      project:
        next.kind === "home"
          ? undefined
          : projects.find(({ id }) => id === next.projectId)
    });
  const project =
    route.kind === "project" || route.kind === "conversation"
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
  const title =
    route.kind === "conversation"
      ? conversation?.name || "Conversation"
      : route.kind === "project"
        ? project?.name || "Project"
        : "HQ";
  // A successful graph read with unavailable metadata is incomplete, even
  // though the shared store deliberately does not expose a global error.
  const incompleteProjects = Boolean(
    snapshot &&
    snapshot.revision > 0 &&
    !snapshot.projectsLoaded &&
    !snapshot.loading
  );
  const destinations: HqCommand[] = projects.flatMap((item) => [
    ...(item.contextKind === "independent"
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
  destinations.push(...hqLayoutCommands(Boolean(renderSettings)));
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
        shellActions.current?.toggleContext();
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
        title={title}
        route={route}
        sidebar={({ compact }) => (
          <HqSidebar
            compact={compact}
            accountIdentity={accountIdentity}
            onOpenSettings={renderSettings ? openSettings : undefined}
            groupsReady={Boolean(snapshot?.projectsLoaded)}
            loading={
              !snapshot ||
              snapshot.loading ||
              (!snapshot.projectsLoaded &&
                !snapshot.error &&
                !incompleteProjects)
            }
            projectsError={Boolean(snapshot?.error) || incompleteProjects}
            projects={projects}
            route={route}
            onRetryProjects={() => {
              void personalMemoryStore?.loadProjects();
            }}
            onOpenSearchAndCommands={() => {
              if (!settingsOpen) setSearchOpen(true);
            }}
            onSelectProject={(projectId) =>
              selectRoute({ kind: "project", projectId })
            }
            onSelectConversation={(projectId, sessionId) =>
              selectRoute({ kind: "conversation", projectId, sessionId })
            }
          />
        )}
      >
        <section
          data-hq-route={route.kind}
          data-hq-project-id={project?.id}
          data-hq-session-id={
            route.kind === "conversation" ? route.sessionId : undefined
          }
          aria-label={title}
          className="hq-destination"
        >
          <p
            className="hq-destination__empty"
            role={
              route.kind !== "home" &&
              (!project || (route.kind === "conversation" && !conversation))
                ? "status"
                : undefined
            }
          >
            {route.kind !== "home" &&
            (!project || (route.kind === "conversation" && !conversation))
              ? `This ${route.kind === "project" ? "Project" : "Conversation"} is no longer available.`
              : route.kind === "home"
                ? "Choose a Project or Conversation from the sidebar."
                : route.kind === "project"
                  ? "Your Project workspace will appear here."
                  : "Your Conversation will appear here."}
          </p>
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
