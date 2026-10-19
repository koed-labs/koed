import type { PersonalDesktopProjectThread } from "@koed/shared/personal-desktop";
import type { DesktopProject } from "../../project-memory-ui.js";
import { sessionSelectionId } from "../../project-memory-ui.js";
import type { DesktopRoute } from "../navigation.js";
import { HqSidebarPreferencesStore } from "../state/hq-sidebar-preferences.js";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import type { ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  Clock3,
  Folder,
  FolderPlus,
  LockKeyhole,
  MessageCircle,
  Search,
  SquarePen
} from "lucide-react";

const JUST_ME_GROUP_ID = "just-me";
const PROJECT_GROUP_PREFIX = "project:";
const PROJECT_CONVERSATION_LIMIT = 3;
const LOOSE_CONVERSATION_LIMIT = 5;

export const hqProjectFoldId = (projectId: string): string =>
  `${PROJECT_GROUP_PREFIX}${projectId}`;

const visibleConversations = (
  threads: readonly PersonalDesktopProjectThread[]
): PersonalDesktopProjectThread[] =>
  threads
    .filter((thread) => thread.threadKind !== "subagent")
    .sort(
      (left, right) =>
        Date.parse(right.latestAt) - Date.parse(left.latestAt) ||
        left.id.localeCompare(right.id)
    );

const projectDomId = (projectId: string): string =>
  `hq-project-children-${encodeURIComponent(projectId)}`;

function IconAction({
  disabled,
  label,
  onClick,
  title,
  children
}: {
  disabled?: boolean;
  label: string;
  onClick?: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <button
      aria-label={label}
      className="hq-icon-button hq-sidebar__action"
      disabled={disabled}
      onClick={onClick}
      title={title}
      type="button"
    >
      {children}
    </button>
  );
}

export type HqSidebarProps = {
  groupsReady?: boolean;
  loading?: boolean;
  onCreateProject?: () => void;
  onNewConversation?: () => void;
  onOpenNow?: () => void;
  onOpenSearchAndCommands: () => void;
  onOpenSettings?: () => void;
  onSelectConversation: (projectId: string, sessionId: string) => void;
  onSelectProject: (projectId: string) => void;
  projects: readonly DesktopProject[];
  route: DesktopRoute;
};

export function HqSidebar({
  groupsReady: groupsReadyProp,
  loading = false,
  onCreateProject,
  onNewConversation,
  onOpenNow,
  onOpenSearchAndCommands,
  onSelectConversation,
  onSelectProject,
  projects,
  route
}: HqSidebarProps) {
  const groupsReady = groupsReadyProp ?? !loading;
  const preferencesStoreRef = useRef<HqSidebarPreferencesStore | null>(null);
  if (!preferencesStoreRef.current) {
    preferencesStoreRef.current = new HqSidebarPreferencesStore();
  }
  const preferencesStore = preferencesStoreRef.current;
  const preferences = useSyncExternalStore(
    preferencesStore.subscribe,
    preferencesStore.current,
    preferencesStore.current
  );
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const preservedScrollTop = useRef(0);
  const [expandedLists, setExpandedLists] = useState<ReadonlySet<string>>(
    () => new Set()
  );

  useEffect(() => {
    void preferencesStore.load();
    return () => preferencesStore.dispose();
  }, [preferencesStore]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpenSearchAndCommands();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onOpenSearchAndCommands]);

  useLayoutEffect(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = preservedScrollTop.current;
    }
  });

  const sortedProjects = useMemo(
    () => projects.filter((project) => project.contextKind !== "independent"),
    [projects]
  );
  const foldGroupIds = useMemo(
    () => [
      JUST_ME_GROUP_ID,
      ...sortedProjects.map(({ id }) => hqProjectFoldId(id))
    ],
    [sortedProjects]
  );
  useEffect(() => {
    if (groupsReady) preferencesStore.reconcileGroups(foldGroupIds);
  }, [foldGroupIds, groupsReady, preferencesStore]);
  const chatsProject = projects.find(
    (project) => project.contextKind === "independent"
  );
  const projectChats = useMemo(
    () =>
      new Map(
        sortedProjects.map((project) => [
          project.id,
          visibleConversations(project.threads)
        ])
      ),
    [sortedProjects]
  );
  const looseChats = useMemo(
    () => visibleConversations(chatsProject?.threads ?? []),
    [chatsProject]
  );
  const selectedProjectId =
    route.kind === "personal-memory-project" ||
    route.kind === "personal-memory-session"
      ? route.projectId
      : null;
  const selectedSessionId =
    route.kind === "personal-memory-session" ? route.sessionId : null;
  const groupFolded = (groupId: string) =>
    preferences.foldedGroups[groupId] === true;
  const setGroupFolded = (groupId: string, folded: boolean) => {
    preferencesStore.setGroupFolded(groupId, folded);
    void preferencesStore.flush();
  };
  const showMore = (key: string) => expandedLists.has(key);
  const toggleShowMore = (key: string) => {
    setExpandedLists((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const renderConversation = (
    projectId: string,
    thread: PersonalDesktopProjectThread
  ) => {
    const sessionId = sessionSelectionId(thread);
    const selected =
      selectedProjectId === projectId && selectedSessionId === sessionId;
    return (
      <li
        className="hq-sidebar__conversation"
        key={`${projectId}:${thread.id}`}
      >
        <span aria-hidden="true" className="hq-sidebar__indent-spacer" />
        <MessageCircle
          aria-hidden="true"
          className="hq-sidebar__conversation-icon"
          data-hq-chat-icon=""
        />
        <button
          aria-current={selected ? "page" : undefined}
          className="hq-sidebar__conversation-link"
          data-selected={selected || undefined}
          data-hq-chat-project={projectId}
          data-hq-chat-row=""
          data-hq-chat-title=""
          onClick={() => onSelectConversation(projectId, sessionId)}
          title={thread.name || "Conversation"}
          type="button"
        >
          <span>{thread.name || "Conversation"}</span>
        </button>
      </li>
    );
  };

  const renderProject = (project: DesktopProject) => {
    const groupId = hqProjectFoldId(project.id);
    const folded = groupFolded(groupId);
    const chats = projectChats.get(project.id) ?? [];
    const key = `project-list:${project.id}`;
    const expanded = showMore(key);
    const visible = expanded
      ? chats
      : chats.slice(0, PROJECT_CONVERSATION_LIMIT);
    const moreCount = Math.max(0, chats.length - PROJECT_CONVERSATION_LIMIT);
    const childrenId = projectDomId(project.id);

    return (
      <li className="hq-sidebar__project" key={project.id}>
        <div className="hq-sidebar__project-row" data-hq-project-row="">
          <button
            aria-controls={childrenId}
            aria-expanded={!folded}
            aria-label={`${folded ? "Expand" : "Collapse"} ${project.name} Conversations`}
            className="hq-sidebar__row-chevron"
            data-hq-project-chevron=""
            onClick={() => setGroupFolded(groupId, !folded)}
            title={`${folded ? "Expand" : "Collapse"} ${project.name}`}
            type="button"
          >
            {folded ? (
              <ChevronRight aria-hidden="true" />
            ) : (
              <ChevronDown aria-hidden="true" />
            )}
          </button>
          <Folder
            aria-hidden="true"
            className="hq-sidebar__project-icon"
            data-hq-project-icon=""
          />
          <button
            aria-current={
              route.kind === "personal-memory-project" &&
              route.projectId === project.id
                ? "page"
                : undefined
            }
            className="hq-sidebar__project-link"
            data-selected={selectedProjectId === project.id || undefined}
            data-hq-project-link={project.id}
            onClick={() => onSelectProject(project.id)}
            title={project.name}
            type="button"
          >
            <span>{project.name}</span>
          </button>
        </div>
        <ul
          className="hq-sidebar__nested-list hq-sidebar__project-conversations"
          hidden={folded}
          id={childrenId}
        >
          {visible.map((thread) => renderConversation(project.id, thread))}
          {moreCount > 0 ? (
            <li className="hq-sidebar__more-row">
              <span aria-hidden="true" className="hq-sidebar__indent-spacer" />
              <span
                aria-hidden="true"
                className="hq-sidebar__row-icon-spacer"
              />
              <button
                aria-expanded={expanded}
                className="hq-sidebar__more"
                onClick={() => toggleShowMore(key)}
                type="button"
              >
                {expanded ? "Show less" : `Show ${moreCount} more`}
              </button>
            </li>
          ) : null}
          {chats.length === 0 ? (
            <li className="hq-sidebar__empty-project">No Conversations yet</li>
          ) : null}
        </ul>
      </li>
    );
  };

  const groupIsFolded = groupFolded(JUST_ME_GROUP_ID);
  const chatsExpanded = showMore("loose-chats");
  const visibleLooseChats = chatsExpanded
    ? looseChats
    : looseChats.slice(0, LOOSE_CONVERSATION_LIMIT);
  const looseMoreCount = Math.max(
    0,
    looseChats.length - LOOSE_CONVERSATION_LIMIT
  );

  return (
    <aside
      aria-label="Project navigation"
      className="hq-sidebar__inner"
      id="hq-project-navigation"
    >
      <header className="hq-sidebar__brand">
        <span className="hq-brand-name">Koed</span>
        <span className="hq-brand-section">HQ</span>
      </header>
      <nav aria-label="Project navigation" className="hq-sidebar__nav">
        <div aria-label="Sidebar actions" className="hq-sidebar__actions">
          <IconAction
            disabled={!onNewConversation}
            label="New chat"
            onClick={onNewConversation}
            title={
              onNewConversation
                ? "Start a new conversation"
                : "New chat is not available yet"
            }
          >
            <SquarePen aria-hidden="true" />
          </IconAction>
          <IconAction
            label="Search and commands"
            onClick={onOpenSearchAndCommands}
            title="Search and commands"
          >
            <Search aria-hidden="true" />
          </IconAction>
          <IconAction
            disabled={!onCreateProject}
            label="New project"
            onClick={onCreateProject}
            title={
              onCreateProject
                ? "Create a Project"
                : "Project creation is not available yet"
            }
          >
            <FolderPlus aria-hidden="true" />
          </IconAction>
          <IconAction
            disabled={!onOpenNow}
            label="Now"
            onClick={onOpenNow}
            title={onOpenNow ? "Open Now" : "Now is not available yet"}
          >
            <Clock3 aria-hidden="true" />
          </IconAction>
        </div>
        <div
          className="hq-sidebar__scroll"
          data-hq-sidebar-scroll=""
          onScroll={(event) => {
            preservedScrollTop.current = event.currentTarget.scrollTop;
          }}
          ref={scrollContainerRef}
        >
          <ul className="hq-sidebar__group-list">
            <li className="hq-sidebar__group">
              <button
                aria-controls="hq-group-just-me"
                aria-expanded={!groupIsFolded}
                className="hq-sidebar__group-heading"
                data-hq-sidebar-group="just-me"
                onClick={() => setGroupFolded(JUST_ME_GROUP_ID, !groupIsFolded)}
                type="button"
              >
                {groupIsFolded ? (
                  <ChevronRight
                    aria-hidden="true"
                    className="hq-sidebar__row-chevron-icon"
                    data-hq-group-chevron=""
                  />
                ) : (
                  <ChevronDown
                    aria-hidden="true"
                    className="hq-sidebar__row-chevron-icon"
                    data-hq-group-chevron=""
                  />
                )}
                <LockKeyhole
                  aria-hidden="true"
                  className="hq-sidebar__group-icon"
                  data-hq-group-icon=""
                />
                <span className="hq-sidebar__group-title">Just me</span>
              </button>
              <ul
                className="hq-sidebar__group-children"
                hidden={groupIsFolded}
                id="hq-group-just-me"
              >
                {loading ? (
                  <li className="hq-sidebar__empty">Loading Projects…</li>
                ) : sortedProjects.length === 0 && looseChats.length === 0 ? (
                  <li className="hq-sidebar__empty">
                    No Projects or Chats yet
                  </li>
                ) : null}
                {sortedProjects.map(renderProject)}
                {looseChats.length > 0 ? (
                  <li className="hq-sidebar__loose-group">
                    <div className="hq-sidebar__loose-heading">Chats</div>
                    <ul className="hq-sidebar__nested-list">
                      {visibleLooseChats.map((thread) =>
                        renderConversation(chatsProject!.id, thread)
                      )}
                      {looseMoreCount > 0 ? (
                        <li className="hq-sidebar__more-row">
                          <span
                            aria-hidden="true"
                            className="hq-sidebar__indent-spacer"
                          />
                          <span
                            aria-hidden="true"
                            className="hq-sidebar__row-icon-spacer"
                          />
                          <button
                            aria-expanded={chatsExpanded}
                            className="hq-sidebar__more"
                            onClick={() => toggleShowMore("loose-chats")}
                            type="button"
                          >
                            {chatsExpanded
                              ? "Show less"
                              : `Show ${looseMoreCount} more`}
                          </button>
                        </li>
                      ) : null}
                    </ul>
                  </li>
                ) : null}
              </ul>
            </li>
          </ul>
          {preferences.error ? (
            <p className="hq-sidebar__preference-error" role="status">
              Sidebar preferences could not be saved.
            </p>
          ) : null}
        </div>
      </nav>
    </aside>
  );
}
