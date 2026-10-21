import type { PersonalDesktopProjectThread } from "@koed/shared/personal-desktop";
import type { Project } from "@koed/shared";
import {
  projectNavigation,
  type ProjectConversation,
  type ProjectNavigationRow
} from "./project-navigation.js";
import type { DesktopProject } from "../../project-memory-ui.js";
import { sessionSelectionId } from "../../project-memory-ui.js";
import type { HqRoute } from "./hq-navigation.js";
import { HqSidebarPreferencesStore } from "../state/hq-sidebar-preferences.js";
import type { Agent } from "@koed/shared/agent-contract";
import { scheduledJobSchema } from "@koed/shared/scheduled-job-contract";
import type { z } from "zod";
import { Clock3 } from "lucide-react";
type ScheduledJob = z.infer<typeof scheduledJobSchema>;
import { Pixelkin } from "./agents/Pixelkin.js";
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
  Activity,
  ChevronDown,
  Folder,
  FolderOpen,
  LayoutGrid,
  LockKeyhole,
  MoreHorizontal,
  Plus,
  Search,
  SquarePen,
  Trash2,
  UserRoundPlus,
  UsersRound
} from "lucide-react";
import {
  Tooltip,
  TooltipPopup,
  TooltipProvider,
  TooltipTrigger
} from "@koed/ui";

export type HqAccountIdentity = {
  displayName: string;
  avatarInitials?: string;
  status?: string;
};

export function HqBrand() {
  return (
    <span className="hq-brand" aria-label="Koed">
      <span className="hq-brand__mark" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </span>
      <span className="hq-brand-name">Koed</span>
    </span>
  );
}

export function HqIconAction({
  disabled,
  current,
  label,
  onClick,
  title,
  children,
  className = ""
}: {
  disabled?: boolean;
  current?: boolean;
  label: string;
  onClick?: () => void;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-label={label}
            aria-current={current ? "page" : undefined}
            className={`hq-icon-button ${className}`}
            disabled={disabled}
            onClick={onClick}
            type="button"
          />
        }
      >
        <span>{children}</span>
      </TooltipTrigger>
      <TooltipPopup data-hq-shell="" className="hq-tooltip" side="right">
        {title}
      </TooltipPopup>
    </Tooltip>
  );
}

const JUST_ME_GROUP_ID = "just-me";
const SHARED_GROUP_ID = "shared";
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

export type HqSidebarProps = {
  scheduledJobs?: readonly ScheduledJob[];
  onPauseScheduledJob?: (job: ScheduledJob, paused: boolean) => void;
  onRunScheduledJob?: (job: ScheduledJob) => void;
  conversationAgents?: Readonly<Record<string, Agent>>;
  compact?: boolean;
  accountIdentity?: HqAccountIdentity;

  groupsReady?: boolean;
  loading?: boolean;
  onCreateProject?: () => void;
  onDeleteProject?: (projectId: string) => void;
  onShareProject?: (projectId: string) => void;
  sharedPeopleCounts?: Readonly<Record<string, number>>;
  onDeleteConversation?: (
    projectId: string,
    sessionId: string,
    title: string
  ) => void;
  onForgetConversation?: (
    projectId: string,
    sessionId: string,
    title: string
  ) => void;
  onNewConversation?: () => void;
  onOpenNow?: () => void;
  nowActive?: boolean;
  onOpenSearchAndCommands: () => void;
  onRetryProjects?: () => void;
  onOpenSettings?: () => void;
  onSelectConversation: (projectId: string, sessionId: string) => void;
  onSelectProject: (projectId: string) => void;
  onMoveConversation?: (
    sessionId: string,
    fromProjectId: string | null,
    toProjectId: string | null
  ) => void;
  revealProject?: { id: string; token: number } | null;
  projectsError?: boolean;
  projects: readonly DesktopProject[];
  personalProjects?: readonly Project[];
  pendingDeletionIds?: ReadonlySet<string>;
  route: HqRoute;
};

export function HqSidebar({
  scheduledJobs = [],
  onPauseScheduledJob,
  onRunScheduledJob,
  conversationAgents,
  compact = false,
  accountIdentity,
  onOpenSettings,
  groupsReady: groupsReadyProp,
  loading = false,
  onCreateProject,
  onDeleteProject,
  onShareProject,
  sharedPeopleCounts,
  onDeleteConversation,
  onForgetConversation,
  onNewConversation,
  onOpenNow,
  nowActive = false,
  onOpenSearchAndCommands,
  onRetryProjects,
  onSelectConversation,
  onSelectProject,
  onMoveConversation,
  revealProject,
  projectsError = false,
  projects,
  personalProjects,
  pendingDeletionIds,
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
  const [projectMenuId, setProjectMenuId] = useState<string | null>(null);
  const [conversationMenuId, setConversationMenuId] = useState<string | null>(
    null
  );
  const [dragging, setDragging] = useState<{
    sessionId: string;
    projectId: string | null;
  } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [projectMenuPosition, setProjectMenuPosition] = useState({
    x: 0,
    y: 0
  });
  const menuReturnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!conversationMenuId) return;
    const close = (event: PointerEvent) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest(".hq-sidebar__conversation")
      )
        setConversationMenuId(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setConversationMenuId(null);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [conversationMenuId]);

  useEffect(() => {
    if (!projectMenuId) return;
    document
      .querySelector<HTMLElement>(
        "[data-hq-project-menu] [role=menuitem]:not([disabled])"
      )
      ?.focus();
    const dismiss = (event: PointerEvent) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest(".hq-sidebar__project-row")
      )
        setProjectMenuId(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setProjectMenuId(null);
        requestAnimationFrame(() => menuReturnFocus.current?.focus());
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [projectMenuId]);

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

  const navigation = useMemo(
    () =>
      personalProjects ? projectNavigation(personalProjects, projects) : null,
    [personalProjects, projects]
  );
  const sortedProjects = useMemo<ProjectNavigationRow[]>(
    () =>
      navigation?.projects ??
      projects
        .filter((project) => project.contextKind !== "independent")
        .map(({ id, name, threads }) => ({
          id,
          name,
          conversations: threads.map((thread) => ({
            technicalProjectId: id,
            thread
          }))
        })),
    [navigation, projects]
  );
  const sharedProjectIds = useMemo(
    () =>
      new Set(
        personalProjects
          ?.filter((item) => Boolean(item.workspaceProjectId))
          .map((item) => item.id) ?? []
      ),
    [personalProjects]
  );
  const privateProjectRows = sortedProjects.filter(
    (item) => !sharedProjectIds.has(item.id)
  );
  const sharedProjectRows = sortedProjects.filter((item) =>
    sharedProjectIds.has(item.id)
  );
  const foldGroupIds = useMemo(
    () => [
      JUST_ME_GROUP_ID,
      ...(sharedProjectRows.length ? [SHARED_GROUP_ID] : []),
      ...sortedProjects.map(({ id }) => hqProjectFoldId(id))
    ],
    [sortedProjects, sharedProjectRows.length]
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
          visibleConversations(
            project.conversations.map(({ thread }) => thread)
          ).map(
            (thread) =>
              project.conversations.find((item) => item.thread === thread)!
          )
        ])
      ),
    [sortedProjects]
  );
  const looseChats = useMemo<ProjectConversation[]>(() => {
    const rows =
      navigation?.loose ??
      (chatsProject?.threads ?? []).map((thread) => ({
        technicalProjectId: chatsProject!.id,
        thread
      }));
    return visibleConversations(rows.map(({ thread }) => thread)).map(
      (thread) => rows.find((row) => row.thread === thread)!
    );
  }, [navigation, chatsProject]);
  const selectedProjectId =
    route.kind === "project" || route.kind === "conversation"
      ? route.projectId
      : null;
  const selectedSessionId =
    route.kind === "conversation" ? route.sessionId : null;
  const groupFolded = (groupId: string) =>
    preferences.foldedGroups[groupId] === true;
  const setGroupFolded = (groupId: string, folded: boolean) => {
    preferencesStore.setGroupFolded(groupId, folded);
    void preferencesStore.flush();
  };
  useEffect(() => {
    if (!revealProject) return;
    preferencesStore.setGroupFolded(hqProjectFoldId(revealProject.id), false);
    void preferencesStore.flush();
    setExpandedLists((current) =>
      new Set(current).add(`project-list:${revealProject.id}`)
    );
  }, [preferencesStore, revealProject?.id, revealProject?.token]);
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
    thread: PersonalDesktopProjectThread,
    personalProjectId: string | null
  ) => {
    const boundJobs = thread.sessionId
      ? scheduledJobs.filter(
          (job) =>
            job.conversationSessionId === thread.sessionId &&
            job.projectId === personalProjectId
        )
      : [];
    const sessionId = sessionSelectionId(thread);
    const selected =
      selectedProjectId === projectId && selectedSessionId === sessionId;
    return (
      <li
        className="hq-sidebar__conversation"
        key={`${projectId}:${thread.id}`}
        onContextMenu={(event) => {
          if (!thread.sessionId || (!onDeleteConversation && !boundJobs.length))
            return;
          event.preventDefault();
          setConversationMenuId(
            conversationMenuId === thread.sessionId ? null : thread.sessionId
          );
        }}
      >
        <button
          aria-current={selected ? "page" : undefined}
          className="hq-sidebar__conversation-link"
          data-selected={selected || undefined}
          data-hq-chat-project={projectId}
          data-hq-chat-row=""
          data-hq-chat-title=""
          data-hq-drag-source={
            dragging?.sessionId === thread.sessionId || undefined
          }
          draggable={Boolean(
            thread.sessionId && !thread.originDevice && onMoveConversation
          )}
          onDragStart={(event) => {
            if (!thread.sessionId || thread.originDevice || !onMoveConversation)
              return;
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData(
              "application/x-koed-conversation",
              thread.sessionId
            );
            setDragging({
              sessionId: thread.sessionId,
              projectId: personalProjectId
            });
          }}
          onDragEnd={() => {
            setDragging(null);
            setDropTarget(null);
          }}
          onClick={() => onSelectConversation(projectId, sessionId)}
          title={thread.name || "Conversation"}
          type="button"
        >
          {boundJobs.length ? (
            <Clock3
              aria-label="Job chat"
              className="hq-sidebar__job-clock"
              data-paused={boundJobs.every((job) => job.paused) || undefined}
              size={14}
            />
          ) : thread.sessionId && conversationAgents?.[thread.sessionId] ? (
            <Pixelkin agent={conversationAgents[thread.sessionId]!} size={16} />
          ) : null}
          <span>{thread.name || "Conversation"}</span>
          {thread.sessionId && pendingDeletionIds?.has(thread.sessionId) ? (
            <small className="hq-sidebar__deletion-pending">
              Deletion pending
            </small>
          ) : null}
        </button>
        {thread.sessionId && onDeleteConversation ? (
          <button
            aria-label={`Delete ${thread.name || "Conversation"}`}
            className="hq-sidebar__conversation-trash"
            onClick={(event) => {
              event.stopPropagation();
              onDeleteConversation(
                projectId,
                thread.sessionId!,
                thread.name || "Conversation"
              );
              setConversationMenuId(null);
            }}
            type="button"
          >
            <Trash2 aria-hidden="true" />
          </button>
        ) : null}
        {conversationMenuId === thread.sessionId &&
        thread.sessionId &&
        (onDeleteConversation || boundJobs.length) ? (
          <div
            className="hq-sidebar__conversation-menu"
            role="menu"
            aria-label={`${thread.name || "Conversation"} actions`}
          >
            {boundJobs.map((job) => (
              <div
                key={job.id}
                role="group"
                aria-label={`${job.title} job actions`}
              >
                {boundJobs.length > 1 ? (
                  <div className="hq-sidebar__job-menu-title" title={job.title}>
                    {job.title}
                  </div>
                ) : null}
                <button
                  role="menuitem"
                  type="button"
                  disabled={!onPauseScheduledJob}
                  onClick={() => {
                    setConversationMenuId(null);
                    onPauseScheduledJob?.(job, !job.paused);
                  }}
                >
                  {job.paused ? "Resume job" : "Pause job"}
                </button>
                <button
                  role="menuitem"
                  type="button"
                  disabled={!onRunScheduledJob || job.paused}
                  onClick={() => {
                    setConversationMenuId(null);
                    onRunScheduledJob?.(job);
                  }}
                >
                  Run now
                </button>
              </div>
            ))}
            {onDeleteConversation ? (
              <button
                role="menuitem"
                type="button"
                onClick={() => {
                  onDeleteConversation(
                    projectId,
                    thread.sessionId!,
                    thread.name || "Conversation"
                  );
                  setConversationMenuId(null);
                }}
              >
                Delete chat
              </button>
            ) : null}
            {onForgetConversation ? (
              <button
                role="menuitem"
                type="button"
                onClick={() => {
                  onForgetConversation(
                    projectId,
                    thread.sessionId!,
                    thread.name || "Conversation"
                  );
                  setConversationMenuId(null);
                }}
              >
                Forget this chat
              </button>
            ) : null}
          </div>
        ) : null}
      </li>
    );
  };

  const renderProject = (project: ProjectNavigationRow) => {
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
    const selected = route.kind === "project" && route.projectId === project.id;
    return (
      <li
        className="hq-sidebar__project"
        key={project.id}
        data-hq-drop-active={dropTarget === project.id || undefined}
        onDragOver={(event) => {
          if (
            !dragging ||
            dragging.projectId === project.id ||
            !onMoveConversation
          )
            return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setDropTarget(project.id);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node))
            setDropTarget(null);
        }}
        onDrop={(event) => {
          event.preventDefault();
          if (
            dragging &&
            dragging.projectId !== project.id &&
            event.dataTransfer.getData("application/x-koed-conversation") ===
              dragging.sessionId
          )
            onMoveConversation?.(
              dragging.sessionId,
              dragging.projectId,
              project.id
            );
          setDragging(null);
          setDropTarget(null);
        }}
      >
        <div
          className="hq-sidebar__project-row"
          data-hq-project-row=""
          onContextMenu={(event) => {
            if (!personalProjects?.some(({ id }) => id === project.id)) return;
            event.preventDefault();
            menuReturnFocus.current =
              event.currentTarget.querySelector<HTMLElement>(
                `[data-hq-project-menu-trigger]`
              );
            setProjectMenuPosition({ x: event.clientX, y: event.clientY });
            setProjectMenuId(project.id);
          }}
        >
          <button
            aria-current={selected ? "page" : undefined}
            aria-controls={childrenId}
            aria-expanded={!folded}
            className="hq-sidebar__project-link"
            data-selected={selected || undefined}
            data-hq-project-link={project.id}
            onClick={() => {
              if (selected) setGroupFolded(groupId, !folded);
              else {
                if (folded) setGroupFolded(groupId, false);
                onSelectProject(project.id);
              }
            }}
            title={project.name}
            type="button"
          >
            {folded ? (
              <Folder
                aria-hidden="true"
                className="hq-sidebar__project-icon"
                data-hq-project-icon=""
              />
            ) : (
              <FolderOpen
                aria-hidden="true"
                className="hq-sidebar__project-icon"
                data-hq-project-icon=""
              />
            )}
            <span>{project.name}</span>
            {sharedProjectIds.has(project.id) ? (
              <small
                className="hq-sidebar__project-people"
                aria-label={
                  sharedPeopleCounts?.[project.id] === undefined
                    ? "Shared Project"
                    : `${sharedPeopleCounts[project.id]} people`
                }
              >
                <UsersRound aria-hidden="true" />
                {sharedPeopleCounts?.[project.id] ?? ""}
              </small>
            ) : null}
          </button>
          {personalProjects?.some(({ id }) => id === project.id) ? (
            <>
              <button
                aria-label={`More for ${project.name}`}
                aria-haspopup="menu"
                aria-expanded={projectMenuId === project.id}
                className="hq-sidebar__project-more"
                data-hq-project-menu-trigger={project.id}
                onClick={(event) => {
                  menuReturnFocus.current = event.currentTarget;
                  const rect = event.currentTarget.getBoundingClientRect();
                  setProjectMenuPosition({
                    x: rect.right - 210,
                    y: rect.bottom
                  });
                  setProjectMenuId(
                    projectMenuId === project.id ? null : project.id
                  );
                }}
                type="button"
              >
                <MoreHorizontal aria-hidden="true" />
              </button>
              {projectMenuId === project.id ? (
                <div
                  className="hq-sidebar__project-menu"
                  data-hq-project-menu=""
                  role="menu"
                  aria-label={`${project.name} actions`}
                  style={{
                    left: Math.max(
                      8,
                      Math.min(projectMenuPosition.x, window.innerWidth - 220)
                    ),
                    top: Math.max(
                      8,
                      Math.min(projectMenuPosition.y, window.innerHeight - 146)
                    ),
                    right: "auto",
                    bottom: "auto"
                  }}
                  onKeyDown={(event) => {
                    if (
                      !["ArrowDown", "ArrowUp", "Home", "End"].includes(
                        event.key
                      )
                    )
                      return;
                    event.preventDefault();
                    const items = [
                      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                        '[role="menuitem"]:not([disabled])'
                      )
                    ];
                    if (!items.length) return;
                    const index = items.indexOf(
                      document.activeElement as HTMLButtonElement
                    );
                    const next =
                      event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? items.length - 1
                          : (index +
                              (event.key === "ArrowDown" ? 1 : -1) +
                              items.length) %
                            items.length;
                    items[next]?.focus();
                  }}
                >
                  <button
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      setProjectMenuId(null);
                      onSelectProject(project.id);
                    }}
                  >
                    <LayoutGrid aria-hidden="true" />
                    Open HQ
                  </button>
                  <button
                    role="menuitem"
                    type="button"
                    disabled={!onShareProject}
                    onClick={() => {
                      setProjectMenuId(null);
                      onShareProject?.(project.id);
                    }}
                  >
                    <UserRoundPlus aria-hidden="true" />
                    Share
                  </button>
                  <button
                    role="menuitem"
                    type="button"
                    disabled={!onDeleteProject}
                    className="hq-sidebar__project-menu-danger"
                    onClick={() => {
                      setProjectMenuId(null);
                      onDeleteProject?.(project.id);
                    }}
                  >
                    <Trash2 aria-hidden="true" />
                    Delete project
                  </button>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
        <ul
          className="hq-sidebar__nested-list hq-sidebar__project-conversations"
          hidden={folded}
          id={childrenId}
        >
          {visible.map(({ technicalProjectId, thread }) =>
            renderConversation(technicalProjectId, thread, project.id)
          )}
          {moreCount > 0 ? (
            <li className="hq-sidebar__more-row">
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
    <TooltipProvider delay={250}>
      <aside
        aria-label="Project navigation"
        className="hq-sidebar__inner"
        data-hq-compact={compact || undefined}
        id="hq-project-navigation"
      >
        <header className="hq-sidebar__brand">
          <HqBrand />
        </header>
        <nav aria-label="Project navigation" className="hq-sidebar__nav">
          <div aria-label="Sidebar actions" className="hq-sidebar__actions">
            <HqIconAction
              className="hq-sidebar__action"
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
            </HqIconAction>
            <HqIconAction
              className="hq-sidebar__action"
              label="Search and commands"
              onClick={onOpenSearchAndCommands}
              title="Search and commands"
            >
              <Search aria-hidden="true" />
            </HqIconAction>
            <HqIconAction
              className="hq-sidebar__action"
              disabled={!onCreateProject}
              label="New project"
              onClick={onCreateProject}
              title={
                onCreateProject
                  ? "Create a Project"
                  : "Project creation is not available yet"
              }
            >
              <Plus aria-hidden="true" />
            </HqIconAction>
            <HqIconAction
              className="hq-sidebar__action hq-sidebar__action--now"
              disabled={!onOpenNow}
              current={nowActive}
              label="Now"
              onClick={onOpenNow}
              title={onOpenNow ? "Open Now" : "Now is not available yet"}
            >
              <Activity aria-hidden="true" />
            </HqIconAction>
          </div>
          <div
            className="hq-sidebar__scroll"
            data-hq-sidebar-scroll=""
            aria-hidden={compact || undefined}
            inert={compact}
            onScroll={(event) => {
              preservedScrollTop.current = event.currentTarget.scrollTop;
              setProjectMenuId(null);
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
                  onClick={() =>
                    setGroupFolded(JUST_ME_GROUP_ID, !groupIsFolded)
                  }
                  type="button"
                >
                  <ChevronDown
                    aria-hidden="true"
                    className="hq-sidebar__row-chevron-icon"
                    data-hq-group-chevron=""
                  />
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
                  {loading &&
                  sortedProjects.length === 0 &&
                  looseChats.length === 0 ? (
                    <li className="hq-sidebar__empty">Loading Projects…</li>
                  ) : null}
                  {projectsError ? (
                    <li
                      className="hq-sidebar__load-error"
                      data-hq-project-load-error=""
                    >
                      <span role="status">Projects could not be loaded.</span>
                      {onRetryProjects ? (
                        <button
                          className="hq-sidebar__retry"
                          data-hq-project-retry=""
                          onClick={onRetryProjects}
                          type="button"
                        >
                          Retry
                        </button>
                      ) : null}
                    </li>
                  ) : null}
                  {!loading &&
                  !projectsError &&
                  sortedProjects.length === 0 &&
                  looseChats.length === 0 ? (
                    <li className="hq-sidebar__empty">
                      No Projects or Chats yet
                    </li>
                  ) : null}
                  {privateProjectRows.map(renderProject)}
                  {looseChats.length > 0 || onMoveConversation ? (
                    <li
                      className="hq-sidebar__loose-group"
                      data-hq-dragging={Boolean(dragging) || undefined}
                      data-hq-drop-active={dropTarget === "chats" || undefined}
                      onDragOver={(event) => {
                        if (
                          !dragging ||
                          dragging.projectId === null ||
                          !onMoveConversation
                        )
                          return;
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                        setDropTarget("chats");
                      }}
                      onDragLeave={(event) => {
                        if (
                          !event.currentTarget.contains(
                            event.relatedTarget as Node
                          )
                        )
                          setDropTarget(null);
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        if (
                          dragging &&
                          dragging.projectId !== null &&
                          event.dataTransfer.getData(
                            "application/x-koed-conversation"
                          ) === dragging.sessionId
                        )
                          onMoveConversation?.(
                            dragging.sessionId,
                            dragging.projectId,
                            null
                          );
                        setDragging(null);
                        setDropTarget(null);
                      }}
                    >
                      <div className="hq-sidebar__loose-heading">Chats</div>
                      <ul className="hq-sidebar__nested-list">
                        {visibleLooseChats.map((thread) =>
                          renderConversation(
                            thread.technicalProjectId,
                            thread.thread,
                            null
                          )
                        )}
                        {looseMoreCount > 0 ? (
                          <li className="hq-sidebar__more-row">
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
              {sharedProjectRows.length ? (
                <li className="hq-sidebar__group">
                  <button
                    aria-controls="hq-group-shared"
                    aria-expanded={!groupFolded(SHARED_GROUP_ID)}
                    className="hq-sidebar__group-heading"
                    data-hq-sidebar-group="shared"
                    onClick={() =>
                      setGroupFolded(
                        SHARED_GROUP_ID,
                        !groupFolded(SHARED_GROUP_ID)
                      )
                    }
                    type="button"
                  >
                    <ChevronDown
                      aria-hidden="true"
                      className="hq-sidebar__row-chevron-icon"
                      data-hq-group-chevron=""
                    />
                    <UserRoundPlus
                      aria-hidden="true"
                      className="hq-sidebar__group-icon"
                      data-hq-group-icon=""
                    />
                    <span className="hq-sidebar__group-title">Shared</span>
                  </button>
                  <ul
                    className="hq-sidebar__group-children"
                    hidden={groupFolded(SHARED_GROUP_ID)}
                    id="hq-group-shared"
                  >
                    {sharedProjectRows.map(renderProject)}
                  </ul>
                </li>
              ) : null}
            </ul>
            {preferences.error ? (
              <p className="hq-sidebar__preference-error" role="status">
                Sidebar preferences could not be saved.
              </p>
            ) : null}
          </div>
        </nav>
        {accountIdentity ? (
          <footer className="hq-sidebar__account">
            <button
              type="button"
              className="hq-account"
              aria-label={`${accountIdentity.displayName}: settings and account`}
              disabled={!onOpenSettings}
              onClick={() => onOpenSettings?.()}
            >
              <span className="hq-account__avatar" aria-hidden="true">
                {accountIdentity.avatarInitials ||
                  accountIdentity.displayName
                    .trim()
                    .split(/\s+/)
                    .slice(0, 2)
                    .map((part) => part[0])
                    .join("")}
              </span>
              <span className="hq-account__identity">
                <span>{accountIdentity.displayName}</span>
                {accountIdentity.status ? (
                  <small>{accountIdentity.status}</small>
                ) : null}
              </span>
            </button>
          </footer>
        ) : null}
      </aside>
    </TooltipProvider>
  );
}
