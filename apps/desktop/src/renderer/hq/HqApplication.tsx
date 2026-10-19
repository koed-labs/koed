import {
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode
} from "react";
import { sessionSelectionId } from "../../project-memory-ui.js";
import type { PersonalMemoryStore } from "../state/personal-memory.js";
import { HqShell, type HqShellActions } from "./HqShell.js";
import { HqSidebar, type HqAccountIdentity } from "./HqSidebar.js";
import { HqSearch } from "./HqSearch.js";
import { hqLayoutCommands, type HqCommand } from "./hq-command-palette.js";
import type { HqRoute } from "./hq-navigation.js";
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
  const [route, setRoute] = useState<HqRoute>({ kind: "home" });
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const shellActions = useRef<HqShellActions>(null);
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
  const project =
    route.kind === "project" || route.kind === "conversation"
      ? projects.find(({ id }) => id === route.projectId)
      : undefined;
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
  const openSettings = () => {
    shellActions.current?.dismissOverlays();
    setSettingsOpen(true);
  };
  const invoke = (command: HqCommand) => {
    const action = command.action;
    switch (action.kind) {
      case "route":
        setRoute(action.route);
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
            onOpenSearchAndCommands={() => setSearchOpen(true)}
            onSelectProject={(projectId) =>
              setRoute({ kind: "project", projectId })
            }
            onSelectConversation={(projectId, sessionId) =>
              setRoute({ kind: "conversation", projectId, sessionId })
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
          <p className="hq-destination__empty">
            {route.kind === "home"
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
      {settingsOpen && renderSettings
        ? renderSettings(() => setSettingsOpen(false))
        : null}
    </>
  );
}
