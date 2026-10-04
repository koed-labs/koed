"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  Blocks,
  Bot,
  ChevronDown,
  ChevronRight,
  GitPullRequest,
  House,
  Inbox,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Settings,
  User,
  Users,
  Folder
} from "lucide-react";
import { Tooltip } from "@/components/Tooltip";
import { useCanCreateLocalProject } from "@/lib/local-projects";
import { useCallback, useEffect, useRef, useState } from "react";
import type { HomeExecution } from "@/lib/studio-contract";
import {
  LocalConversationBrowser,
  type LocalSourceSelection
} from "./LocalConversationBrowser";
import {
  boundStudioSidebarWidth,
  DEFAULT_STUDIO_SIDEBAR_WIDTH,
  MAX_STUDIO_SIDEBAR_WIDTH,
  MIN_STUDIO_SIDEBAR_WIDTH,
  STUDIO_SIDEBAR_WIDTH_STEP
} from "./StudioSidebar.helpers";
import { isSyntheticIndependentProject } from "./LocalConversationBrowser.match";
import { useHomeFeed } from "@/lib/use-home-feed";
import type { PersonalRemovalTarget } from "@/lib/personal-removals-client";
import { usePersonalRemovals } from "./usePersonalRemovals";
import { useVerifiedPersonalScope } from "./useVerifiedPersonalScope";
import { PersonalRemovalControl } from "./PersonalRemovalControl";
import {
  hasConversationRemoval,
  hasProjectRemoval,
  managedConversationRemovalTarget
} from "./personal-removals-view";

const SIDEBAR_WIDTH_STORAGE_KEY = "koed:studio:sidebar-width";
const isManagedExecution = (
  chat: { id: string; title: string } | HomeExecution
): chat is HomeExecution => "state" in chat && "provider" in chat;

type StudioSidebarProps = {
  projects: Array<{ id: string; name: string }>;
  chats?: Array<{ id: string; title: string }>;
  collapsed: boolean;
  selectedProject: string | null;
  onProjectSelect: (projectId: string) => void;
  onToggle: () => void;
  onHome?: () => void;
  onNewChat?: () => void;
  onNewProject?: () => void;
  onPullRequests?: () => void;
  onPlugins?: () => void;
  activeSection?:
    | "home"
    | "new-chat"
    | "pull-requests"
    | "plugins"
    | "agents"
    | "settings"
    | "memory-inbox";
  onChatSelect?: (chatId: string) => void;
  showLocalCatalog?: boolean;
  canCreateLocalProject?: boolean;
  onLocalSourceSelect?: (
    sourceId: string,
    provider: "codex" | "claude-code" | "pi",
    signal: AbortSignal
  ) => Promise<LocalSourceSelection>;
  canShareLocalSource?: (
    sourceId: string,
    provider: "codex" | "claude-code" | "pi"
  ) => boolean;
  onShareLocalSource?: (
    sourceId: string,
    provider: "codex" | "claude-code" | "pi"
  ) => void;
  canShareManagedExecution?: (executionId: string) => boolean;
  onShareManagedExecution?: (executionId: string) => void;
  onMoveManagedExecution?: (
    executionId: string,
    destinationProjectId: string
  ) => void;
  managedConversations?: HomeExecution[];
  managedSourceIds?: readonly string[];
  personalScopeKey?: string | null;
  onSelectManagedExecution?: (executionId: string) => void;
  registeredProjectIds?: readonly string[];
  homeBadgeCount?: number;
  personalRemovals?: PersonalRemovalTarget[];
  personalRemovalsReady?: boolean;
  personalRemovalError?: string | null;
  onRetryPersonalRemovals?: () => void;
  onRemovePersonalItem?: (target: PersonalRemovalTarget) => Promise<void>;
  lastRemovedPersonalItem?: PersonalRemovalTarget | null;
  onUndoPersonalRemoval?: () => Promise<void>;
  managedProviderSourceIds?: Readonly<Record<string, readonly string[]>>;
};
const unavailable = "This destination will be connected in a later integration";

export function StudioSidebar({
  projects,
  chats = [],
  collapsed,
  selectedProject,
  onProjectSelect,
  onToggle,
  onHome,
  onNewChat,
  onNewProject,
  onPullRequests,
  onPlugins,
  activeSection = "home",
  onChatSelect,
  showLocalCatalog = false,
  canCreateLocalProject: canCreateLocalProjectProp,
  onLocalSourceSelect,
  canShareLocalSource,
  onShareLocalSource,
  canShareManagedExecution,
  onShareManagedExecution,
  onMoveManagedExecution,
  managedConversations = [],
  managedSourceIds = [],
  onSelectManagedExecution,
  registeredProjectIds = [],
  homeBadgeCount: providedHomeBadgeCount,
  personalRemovals: suppliedPersonalRemovals,
  personalRemovalsReady: suppliedPersonalRemovalsReady,
  personalRemovalError: suppliedPersonalRemovalError,
  onRetryPersonalRemovals: suppliedOnRetryPersonalRemovals,
  onRemovePersonalItem: suppliedOnRemovePersonalItem,
  lastRemovedPersonalItem: suppliedLastRemovedPersonalItem,
  onUndoPersonalRemoval: suppliedOnUndoPersonalRemoval,
  managedProviderSourceIds,
  personalScopeKey: suppliedPersonalScopeKey
}: StudioSidebarProps) {
  const needsPersonalScope =
    showLocalCatalog ||
    projects.length > 0 ||
    chats.length > 0 ||
    managedConversations.length > 0;
  const fallbackPersonalScopeKey = useVerifiedPersonalScope(
    undefined,
    suppliedPersonalScopeKey === undefined && needsPersonalScope
  );
  const personalScopeKey =
    suppliedPersonalScopeKey === undefined
      ? fallbackPersonalScopeKey
      : suppliedPersonalScopeKey;
  const sidebarHomeFeed = useHomeFeed({
    transport: "studio",
    identityKey: providedHomeBadgeCount === undefined ? "personal" : null,
    enabled: providedHomeBadgeCount === undefined
  });
  const homeBadgeCount =
    providedHomeBadgeCount ?? sidebarHomeFeed.snapshot?.badgeCount ?? 0;
  const router = useRouter();
  const capabilityFromGateway = useCanCreateLocalProject();
  const canCreateLocalProject =
    canCreateLocalProjectProp ?? capabilityFromGateway;
  const hasProvidedRemovalState = suppliedPersonalRemovals !== undefined;
  const fallbackRemovalEnabled =
    !hasProvidedRemovalState &&
    (showLocalCatalog ||
      projects.length > 0 ||
      chats.length > 0 ||
      managedConversations.length > 0);
  const fallbackRemovalState = usePersonalRemovals({
    enabled: fallbackRemovalEnabled,
    scopeKey: personalScopeKey
  });
  const personalRemovals =
    suppliedPersonalRemovals ?? fallbackRemovalState.removals;
  const personalRemovalsReady =
    suppliedPersonalRemovalsReady ?? fallbackRemovalState.ready;
  const personalRemovalError =
    suppliedPersonalRemovalError ?? fallbackRemovalState.error;
  const onRemovePersonalItem =
    suppliedOnRemovePersonalItem ??
    (fallbackRemovalEnabled
      ? async (target: PersonalRemovalTarget) => {
          if (target.kind === "project" && selectedProject === target.projectId)
            onProjectSelect("");
          await fallbackRemovalState.remove(target);
        }
      : undefined);
  const lastRemovedPersonalItem = hasProvidedRemovalState
    ? suppliedLastRemovedPersonalItem
    : fallbackRemovalEnabled
      ? fallbackRemovalState.lastRemoved
      : null;
  const onUndoPersonalRemoval =
    suppliedOnUndoPersonalRemoval ??
    (fallbackRemovalEnabled ? fallbackRemovalState.undoLast : undefined);
  const onRetryPersonalRemovals =
    suppliedPersonalRemovalsReady !== undefined
      ? suppliedOnRetryPersonalRemovals
      : fallbackRemovalEnabled
        ? () => void fallbackRemovalState.load().catch(() => undefined)
        : undefined;
  const [projectsExpanded, setProjectsExpanded] = useState(true);
  const [projectSearchOpen, setProjectSearchOpen] = useState(false);
  const [projectSearch, setProjectSearch] = useState("");
  const [chatsExpanded, setChatsExpanded] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(
    DEFAULT_STUDIO_SIDEBAR_WIDTH
  );
  const [availableHostWidth, setAvailableHostWidth] = useState(
    Number.POSITIVE_INFINITY
  );
  const [isNarrowScreen, setIsNarrowScreen] = useState(false);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [undoPersonalRemovalPending, setUndoPersonalRemovalPending] =
    useState(false);
  const [undoPersonalRemovalError, setUndoPersonalRemovalError] = useState<
    string | null
  >(null);
  const navRef = useRef<HTMLElement>(null);
  const resizeStartRef = useRef<{ pointerX: number; width: number } | null>(
    null
  );
  const mobileOpenButtonRef = useRef<HTMLButtonElement>(null);
  const wasMobileNavigationOpen = useRef(false);
  const projectSearchRef = useRef<HTMLInputElement>(null);

  const readAvailableHostWidth = useCallback(() => {
    return (
      navRef.current?.parentElement?.clientWidth ?? Number.POSITIVE_INFINITY
    );
  }, []);
  const boundWidth = useCallback(
    (value: number, hostWidth = availableHostWidth) =>
      boundStudioSidebarWidth(value, hostWidth),
    [availableHostWidth]
  );
  const renderedSidebarWidth = boundWidth(sidebarWidth);
  const maxSidebarWidth = boundWidth(MAX_STUDIO_SIDEBAR_WIDTH);
  const navigationCollapsed =
    collapsed || (isNarrowScreen && !mobileNavigationOpen);
  const settingsMode =
    activeSection === "settings" || activeSection === "plugins";

  useEffect(() => {
    if (projectSearchOpen) projectSearchRef.current?.focus();
  }, [projectSearchOpen]);

  const normalizedProjectSearch = projectSearch.trim().toLocaleLowerCase();
  const filteredProjects = personalRemovalsReady
    ? projects.filter(
        (project) =>
          !hasProjectRemoval(personalRemovals, project.id) &&
          !isSyntheticIndependentProject(project.id, project.name) &&
          project.name.toLocaleLowerCase().includes(normalizedProjectSearch)
      )
    : [];
  const activeManagedConversations = personalRemovalsReady
    ? managedConversations.filter(
        (chat) =>
          ["running", "ready", "starting"].includes(chat.state.toLowerCase()) &&
          !hasProjectRemoval(personalRemovals, chat.projectId ?? "") &&
          !hasConversationRemoval(personalRemovals, [`managed:${chat.id}`])
      )
    : [];
  const registeredProjectIdSet = new Set(registeredProjectIds);
  const managedByProject = new Map<string, HomeExecution[]>();
  for (const chat of activeManagedConversations) {
    if (!chat.projectId || !registeredProjectIdSet.has(chat.projectId))
      continue;
    const group = managedByProject.get(chat.projectId) ?? [];
    group.push(chat);
    managedByProject.set(chat.projectId, group);
  }
  const standaloneManagedConversations = activeManagedConversations.filter(
    (chat) =>
      !chat.projectId ||
      isSyntheticIndependentProject(chat.projectId) ||
      !registeredProjectIdSet.has(chat.projectId)
  );
  const visibleSidebarChats = personalRemovalsReady
    ? [
        ...chats.filter(
          (chat) =>
            !managedConversations.some((managed) => managed.id === chat.id)
        ),
        ...standaloneManagedConversations
      ].filter((chat) => {
        const sourceId = isManagedExecution(chat)
          ? `managed:${chat.id}`
          : chat.id;
        const projectId = isManagedExecution(chat) ? chat.projectId : null;
        return (
          !hasConversationRemoval(personalRemovals, [sourceId]) &&
          !hasProjectRemoval(personalRemovals, projectId ?? "")
        );
      })
    : [];
  const undoPersonalRemoval = async () => {
    if (!onUndoPersonalRemoval || undoPersonalRemovalPending) return;
    setUndoPersonalRemovalPending(true);
    setUndoPersonalRemovalError(null);
    try {
      await onUndoPersonalRemoval();
    } catch (reason) {
      setUndoPersonalRemovalError(
        reason instanceof Error
          ? reason.message
          : "Undo could not be saved. Try again."
      );
    } finally {
      setUndoPersonalRemovalPending(false);
    }
  };
  const acceptManagedDrop = (
    event: React.DragEvent<HTMLElement>,
    destinationProjectId: string
  ) => {
    event.preventDefault();
    const executionId = event.dataTransfer.getData(
      "application/x-koed-managed-execution"
    );
    const chat = activeManagedConversations.find(
      (candidate) => candidate.id === executionId
    );
    if (
      !/^lp_[0-9a-f]{32}$/iu.test(destinationProjectId) ||
      !registeredProjectIdSet.has(destinationProjectId) ||
      !chat ||
      chat.provider !== "codex" ||
      chat.state.toLowerCase() !== "running" ||
      chat.projectId === destinationProjectId
    )
      return;
    onMoveManagedExecution?.(chat.id, destinationProjectId);
  };
  const openNewProject = useCallback(() => {
    if (!canCreateLocalProject) return;
    if (onNewProject) onNewProject();
    else router.push("/?newProject=1");
  }, [canCreateLocalProject, onNewProject, router]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const syncNarrowScreen = () => {
      setIsNarrowScreen(media.matches);
      setMobileNavigationOpen(false);
    };
    syncNarrowScreen();
    media.addEventListener("change", syncNarrowScreen);
    return () => media.removeEventListener("change", syncNarrowScreen);
  }, []);

  useEffect(() => {
    if (!isNarrowScreen || !mobileNavigationOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMobileNavigationOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [isNarrowScreen, mobileNavigationOpen]);

  useEffect(() => {
    if (
      isNarrowScreen &&
      wasMobileNavigationOpen.current &&
      !mobileNavigationOpen
    )
      mobileOpenButtonRef.current?.focus();
    wasMobileNavigationOpen.current = mobileNavigationOpen;
  }, [isNarrowScreen, mobileNavigationOpen]);

  const openNavigation = () => {
    if (!isNarrowScreen) {
      onToggle();
      return;
    }
    if (collapsed) onToggle();
    setMobileNavigationOpen(true);
  };
  const closeNavigation = () => {
    if (isNarrowScreen) {
      setMobileNavigationOpen(false);
      return;
    }
    onToggle();
  };
  const closeMobileNavigation = () => {
    if (isNarrowScreen) setMobileNavigationOpen(false);
  };

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
      const parsed = saved === null ? NaN : Number(saved);
      if (Number.isFinite(parsed)) {
        // Restore after hydration so the server-rendered default stays stable.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSidebarWidth(parsed);
      }
    } catch {
      // Storage may be unavailable in private or embedded browser contexts.
    }
    setStorageReady(true);
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    try {
      window.localStorage.setItem(
        SIDEBAR_WIDTH_STORAGE_KEY,
        String(sidebarWidth)
      );
    } catch {
      // Storage may be unavailable in private or embedded browser contexts.
    }
  }, [sidebarWidth, storageReady]);

  useEffect(() => {
    if (collapsed || !navRef.current?.parentElement) return;
    const host = navRef.current.parentElement;
    const syncToHostWidth = () => {
      const nextHostWidth = readAvailableHostWidth();
      setAvailableHostWidth((current) =>
        current === nextHostWidth ? current : nextHostWidth
      );
      setSidebarWidth((current) =>
        boundStudioSidebarWidth(current, nextHostWidth)
      );
    };
    syncToHostWidth();
    const observer = new ResizeObserver(syncToHostWidth);
    observer.observe(host);
    window.addEventListener("resize", syncToHostWidth);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", syncToHostWidth);
    };
  }, [collapsed, readAvailableHostWidth]);

  const onResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      resizeStartRef.current = {
        pointerX: event.clientX,
        width: navRef.current?.getBoundingClientRect().width ?? sidebarWidth
      };
      setIsResizing(true);
    },
    [sidebarWidth]
  );
  const onResizePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!isResizing || !resizeStartRef.current) return;
      setSidebarWidth(
        boundWidth(
          resizeStartRef.current.width +
            event.clientX -
            resizeStartRef.current.pointerX
        )
      );
    },
    [boundWidth, isResizing]
  );
  const stopResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      resizeStartRef.current = null;
      setIsResizing(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    []
  );
  const onResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const direction = event.key === "ArrowLeft" ? -1 : 1;
        setSidebarWidth((current) =>
          boundWidth(current + direction * STUDIO_SIDEBAR_WIDTH_STEP)
        );
      } else if (event.key === "Home") {
        event.preventDefault();
        setSidebarWidth(boundWidth(MIN_STUDIO_SIDEBAR_WIDTH));
      } else if (event.key === "End") {
        event.preventDefault();
        setSidebarWidth(boundWidth(MAX_STUDIO_SIDEBAR_WIDTH));
      }
    },
    [boundWidth]
  );
  return (
    <>
      <aside
        className="flex h-dvh min-h-0 w-[72px] flex-shrink-0 flex-col overflow-y-auto [&>*]:shrink-0 items-center bg-sidebar py-4 pt-10 drag-region"
        aria-label="Personal workspace"
      >
        <Tooltip content="Personal Workspace" side="right">
          <button
            type="button"
            onClick={onHome}
            aria-label="Personal Workspace"
            title="Personal Workspace"
            aria-current={!settingsMode ? "page" : undefined}
            className={`relative flex h-10 w-10 items-center justify-center rounded-xl transition-colors no-drag ${!settingsMode ? "bg-surface-hover text-foreground ring-2 ring-accent ring-offset-2 ring-offset-sidebar hover:bg-surface-active" : "text-muted hover:bg-surface-hover hover:text-foreground"}`}
          >
            <User className="h-5 w-5" />
            {homeBadgeCount > 0 && (
              <span
                className="absolute -right-1 -top-1 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] leading-4 text-white"
                aria-label={`${homeBadgeCount} items need you`}
              >
                {homeBadgeCount > 99 ? "99+" : homeBadgeCount}
              </span>
            )}
          </button>
        </Tooltip>
        <div className="my-3 h-px w-8 bg-surface-hover" />
        <Tooltip content="Collaboration preview (local data)" side="right">
          <Link
            href="/collaboration"
            className="flex h-10 w-10 items-center justify-center rounded-xl text-muted hover:bg-surface-hover hover:text-foreground no-drag"
            aria-label="Collaboration preview"
          >
            <Users className="h-5 w-5" />
          </Link>
        </Tooltip>
        {isNarrowScreen && navigationCollapsed && (
          <Tooltip content="Open workspace navigation" side="right">
            <button
              ref={mobileOpenButtonRef}
              type="button"
              onClick={openNavigation}
              aria-label="Open workspace navigation"
              aria-controls="workspace-navigation"
              aria-expanded={false}
              className="mt-3 flex h-10 w-10 items-center justify-center rounded-xl text-muted hover:bg-surface-hover hover:text-foreground no-drag"
            >
              <PanelLeftOpen className="h-5 w-5" />
            </button>
          </Tooltip>
        )}
        <div className="mt-auto">
          <Tooltip content="Settings" side="right">
            <Link
              href="/settings"
              aria-label="Settings"
              aria-current={settingsMode ? "page" : undefined}
              className={`flex h-10 w-10 items-center justify-center rounded-xl no-drag ${settingsMode ? "bg-surface-hover text-foreground ring-2 ring-accent ring-offset-2 ring-offset-sidebar" : "text-muted hover:bg-surface-hover hover:text-foreground"}`}
            >
              <Settings className="h-5 w-5" />
            </Link>
          </Tooltip>
        </div>
      </aside>
      {navigationCollapsed && (
        <div
          className={`flex h-dvh w-8 shrink-0 items-start justify-center bg-background pt-[22px] no-drag ${isNarrowScreen ? "hidden" : ""}`}
        >
          <button
            type="button"
            onClick={openNavigation}
            className="rounded-md p-1.5 text-muted hover:bg-surface-hover hover:text-foreground"
            aria-label="Open Sidebar"
            title="Open Sidebar"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </button>
        </div>
      )}
      {!navigationCollapsed && (
        <>
          {isNarrowScreen && mobileNavigationOpen && (
            <button
              type="button"
              aria-label="Close workspace navigation"
              onClick={closeNavigation}
              className="fixed inset-y-0 left-[72px] right-0 z-30 bg-black/35 no-drag"
            />
          )}
          <aside
            ref={navRef}
            id="workspace-navigation"
            style={{ width: `${renderedSidebarWidth}px` }}
            className={`flex h-dvh min-w-0 shrink-0 flex-col border-r border-border bg-surface pt-6 drag-region ${isResizing ? "select-none" : ""} ${isNarrowScreen ? "fixed inset-y-0 left-[72px] z-40 max-w-[calc(100vw-72px)] shadow-xl" : ""}`}
            aria-label={settingsMode ? "Settings" : "Workspace sections"}
          >
            {settingsMode ? (
              <div className="flex flex-col gap-0.5 px-3 py-2 no-drag">
                <div className="mb-1 flex items-center gap-2">
                  <div className="flex min-w-0 flex-1 items-center gap-2 px-2">
                    <Settings className="h-4 w-4 shrink-0 text-subtle" />
                    <p className="truncate text-sm font-medium text-foreground">
                      Settings
                    </p>
                  </div>
                  <Tooltip content="Close Sidebar" side="bottom">
                    <button
                      type="button"
                      onClick={closeNavigation}
                      className="rounded-md p-1.5 text-muted hover:bg-surface-hover hover:text-foreground-secondary"
                      aria-label="Close Sidebar"
                    >
                      <PanelLeftClose className="h-4 w-4" />
                    </button>
                  </Tooltip>
                </div>
                <Link
                  href="/settings"
                  onClick={closeMobileNavigation}
                  aria-current={
                    activeSection === "settings" ? "page" : undefined
                  }
                  className={`flex items-center rounded-md px-3 py-1.5 text-sm font-medium ${activeSection === "settings" ? "bg-surface-hover text-foreground" : "text-muted hover:bg-surface-hover/50 hover:text-foreground-secondary"}`}
                >
                  <Settings className="mr-2 h-4 w-4" />
                  General
                </Link>
                {onPlugins ? (
                  <button
                    type="button"
                    onClick={() => {
                      onPlugins();
                      closeMobileNavigation();
                    }}
                    aria-current={
                      activeSection === "plugins" ? "page" : undefined
                    }
                    className={`flex items-center rounded-md px-3 py-1.5 text-left text-sm font-medium ${activeSection === "plugins" ? "bg-surface-hover text-foreground" : "text-muted hover:bg-surface-hover/50 hover:text-foreground-secondary"}`}
                  >
                    <Blocks className="mr-2 h-4 w-4" />
                    Plugins
                  </button>
                ) : (
                  <div
                    aria-disabled="true"
                    title={unavailable}
                    className="flex items-center rounded-md px-3 py-1.5 text-sm font-medium text-faint"
                  >
                    <Blocks className="mr-2 h-4 w-4" />
                    Plugins
                  </div>
                )}
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-0.5 px-3 py-2 no-drag">
                  <div className="mb-1 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        onHome?.();
                        closeMobileNavigation();
                      }}
                      aria-current={
                        activeSection === "home" ? "page" : undefined
                      }
                      className={`flex flex-1 items-center rounded-md px-3 py-1.5 text-left text-sm font-medium ${activeSection === "home" ? "bg-surface-hover text-foreground" : "text-foreground-secondary hover:bg-surface-hover/50 hover:text-foreground"}`}
                    >
                      <House className="mr-2 h-4 w-4" />
                      Home
                      {homeBadgeCount > 0 && (
                        <span className="ml-auto rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] leading-none text-accent-foreground">
                          {homeBadgeCount > 99 ? "99+" : homeBadgeCount}
                        </span>
                      )}
                    </button>
                    <Tooltip content="Close Sidebar" side="bottom">
                      <button
                        type="button"
                        onClick={closeNavigation}
                        className="rounded-md p-1.5 text-muted hover:bg-surface-hover hover:text-foreground-secondary"
                        aria-label="Close Sidebar"
                      >
                        <PanelLeftClose className="h-4 w-4" />
                      </button>
                    </Tooltip>
                  </div>
                  {onNewChat ? (
                    <button
                      type="button"
                      onClick={() => {
                        onNewChat();
                        closeMobileNavigation();
                      }}
                      aria-current={
                        activeSection === "new-chat" ? "page" : undefined
                      }
                      className={`flex items-center rounded-md px-3 py-1.5 text-left text-sm font-medium ${activeSection === "new-chat" ? "bg-surface-hover text-foreground" : "text-foreground-secondary hover:bg-surface-hover/50 hover:text-foreground"}`}
                    >
                      <MessageSquare className="mr-2 h-4 w-4" />
                      New chat
                    </button>
                  ) : (
                    <div
                      title="Conversation setup will be connected in the next page"
                      className="flex items-center rounded-md px-3 py-1.5 text-sm font-medium text-faint"
                    >
                      <MessageSquare className="mr-2 h-4 w-4" />
                      New chat
                    </div>
                  )}
                  {onPullRequests ? (
                    <button
                      type="button"
                      onClick={() => {
                        onPullRequests();
                        closeMobileNavigation();
                      }}
                      aria-current={
                        activeSection === "pull-requests" ? "page" : undefined
                      }
                      className={`flex items-center rounded-md px-3 py-1.5 text-left text-sm font-medium ${activeSection === "pull-requests" ? "bg-surface-hover text-foreground" : "text-foreground-secondary hover:bg-surface-hover/50 hover:text-foreground"}`}
                    >
                      <GitPullRequest className="mr-2 h-4 w-4" />
                      Pull Requests
                    </button>
                  ) : (
                    <div
                      title={unavailable}
                      className="flex items-center rounded-md px-3 py-1.5 text-sm font-medium text-faint"
                    >
                      <GitPullRequest className="mr-2 h-4 w-4" />
                      Pull Requests
                    </div>
                  )}
                  <Link
                    href="/agents"
                    onClick={closeMobileNavigation}
                    aria-current={
                      activeSection === "agents" ? "page" : undefined
                    }
                    className={`flex items-center rounded-md px-3 py-1.5 text-left text-sm font-medium ${activeSection === "agents" ? "bg-surface-hover text-foreground" : "text-foreground-secondary hover:bg-surface-hover/50 hover:text-foreground"}`}
                  >
                    <Bot className="mr-2 h-4 w-4" />
                    Agents
                  </Link>
                  <div
                    aria-disabled="true"
                    title="Memory Inbox is not connected in this Studio workflow."
                    className={`flex items-center rounded-md px-3 py-1.5 text-sm font-medium text-faint ${activeSection === "memory-inbox" ? "bg-surface-hover" : ""}`}
                  >
                    <Inbox className="mr-2 h-4 w-4" />
                    Memory Inbox
                  </div>
                </div>
                {showLocalCatalog ? (
                  <div className="flex-1 overflow-y-auto pt-3 no-drag">
                    <LocalConversationBrowser
                      onNavigateAway={closeMobileNavigation}
                      onSourceSelect={onLocalSourceSelect}
                      onProjectSelect={
                        activeSection === "new-chat"
                          ? onProjectSelect
                          : undefined
                      }
                      canShareSource={canShareLocalSource}
                      onShareSource={onShareLocalSource}
                      canShareManagedExecution={canShareManagedExecution}
                      onShareManagedExecution={onShareManagedExecution}
                      onMoveManagedExecution={onMoveManagedExecution}
                      onSelectManagedExecution={onSelectManagedExecution}
                      managedConversations={managedConversations}
                      managedSourceIds={managedSourceIds}
                      personalRemovals={personalRemovals}
                      personalRemovalsReady={personalRemovalsReady}
                      personalRemovalError={personalRemovalError}
                      onRetryPersonalRemovals={onRetryPersonalRemovals}
                      onRemovePersonalItem={onRemovePersonalItem}
                      lastRemovedPersonalItem={lastRemovedPersonalItem}
                      onUndoPersonalRemoval={onUndoPersonalRemoval}
                      managedProviderSourceIds={managedProviderSourceIds}
                      personalScopeKey={personalScopeKey}
                      onNewProject={openNewProject}
                      canCreateProject={canCreateLocalProject}
                    />
                  </div>
                ) : (
                  <>
                    {!personalRemovalsReady ? (
                      <div
                        role={personalRemovalError ? "alert" : "status"}
                        className="mx-3 mt-3 rounded-md border border-border bg-background px-2.5 py-2 text-xs text-muted no-drag"
                      >
                        <p>
                          {personalRemovalError
                            ? "Your Personal Studio list is unavailable, so saved removals cannot be applied."
                            : "Loading your Personal Studio list…"}
                        </p>
                        {personalRemovalError && onRetryPersonalRemovals ? (
                          <button
                            type="button"
                            onClick={onRetryPersonalRemovals}
                            className="mt-2 font-medium text-foreground-secondary hover:text-foreground"
                          >
                            Retry
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                    {lastRemovedPersonalItem && personalRemovalsReady ? (
                      <div
                        role="status"
                        aria-live="polite"
                        className="mx-3 mt-3 flex items-center justify-between gap-2 rounded-md border border-border bg-background px-2 py-2 text-xs text-muted no-drag"
                      >
                        <span>
                          Removed from Studio. Files and history are still
                          available.
                        </span>
                        <button
                          type="button"
                          disabled={undoPersonalRemovalPending}
                          onClick={() => void undoPersonalRemoval()}
                          className="shrink-0 rounded px-1.5 py-1 font-medium text-foreground-secondary hover:bg-surface-hover hover:text-foreground disabled:opacity-50"
                        >
                          {undoPersonalRemovalPending ? "Restoring…" : "Undo"}
                        </button>
                      </div>
                    ) : null}
                    {lastRemovedPersonalItem && undoPersonalRemovalError ? (
                      <p role="alert" className="mx-3 mt-2 text-xs text-danger">
                        {undoPersonalRemovalError}
                      </p>
                    ) : null}
                    <div className="mt-4 flex items-center justify-between px-4 py-1.5 no-drag">
                      <button
                        type="button"
                        onClick={() => setProjectsExpanded((value) => !value)}
                        className="flex items-center text-sm font-medium text-foreground-secondary hover:text-foreground"
                      >
                        <span>Projects</span>
                        {projectsExpanded ? (
                          <ChevronDown className="ml-1 h-3.5 w-3.5" />
                        ) : (
                          <ChevronRight className="ml-1 h-3.5 w-3.5" />
                        )}
                      </button>
                      <div className="flex items-center gap-1">
                        <Tooltip content="Search Projects" side="bottom">
                          <button
                            type="button"
                            onClick={() => {
                              setProjectSearchOpen((open) => !open);
                              if (projectSearchOpen) setProjectSearch("");
                            }}
                            aria-label={
                              projectSearchOpen
                                ? "Close project search"
                                : "Search Projects"
                            }
                            aria-expanded={projectSearchOpen}
                            className="rounded-md p-1 text-muted hover:bg-surface-hover hover:text-foreground"
                          >
                            <Search className="h-3.5 w-3.5" />
                          </button>
                        </Tooltip>
                        <Tooltip
                          content={
                            canCreateLocalProject
                              ? "New Project"
                              : "New projects are available in Koed Studio for Electron."
                          }
                          side="bottom"
                        >
                          <button
                            type="button"
                            disabled={!canCreateLocalProject}
                            onClick={openNewProject}
                            aria-label="New Project"
                            title={
                              canCreateLocalProject
                                ? "New Project"
                                : "New projects are available in Koed Studio for Electron."
                            }
                            className="rounded-md p-1 text-muted hover:bg-surface-hover hover:text-foreground disabled:cursor-not-allowed disabled:text-faint"
                          >
                            <Plus className="h-3.5 w-3.5" />
                          </button>
                        </Tooltip>
                      </div>
                    </div>
                    {projectSearchOpen && (
                      <div className="px-3 pb-1 no-drag">
                        <input
                          ref={projectSearchRef}
                          type="search"
                          value={projectSearch}
                          onChange={(event) =>
                            setProjectSearch(event.target.value)
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              setProjectSearch("");
                              setProjectSearchOpen(false);
                            }
                          }}
                          placeholder="Search projects"
                          aria-label="Search projects by name"
                          className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-accent"
                        />
                      </div>
                    )}
                    <div className="flex-1 overflow-y-auto px-2 pt-0.5 pb-2 no-drag">
                      {projectsExpanded &&
                        personalRemovalsReady &&
                        (filteredProjects.length === 0 ? (
                          <p className="px-2 py-2 text-xs text-subtle">
                            {projects.length === 0
                              ? "No projects yet."
                              : "No projects match your search."}
                          </p>
                        ) : (
                          filteredProjects.map((project) => (
                            <div key={project.id} className="group">
                              <div className="flex items-center gap-0.5">
                                <button
                                  type="button"
                                  aria-pressed={selectedProject === project.id}
                                  title={project.id}
                                  onDragOver={(event) => {
                                    if (
                                      /^lp_[0-9a-f]{32}$/iu.test(project.id) &&
                                      registeredProjectIdSet.has(project.id) &&
                                      Array.from(
                                        event.dataTransfer.types
                                      ).includes(
                                        "application/x-koed-managed-execution"
                                      )
                                    )
                                      event.preventDefault();
                                  }}
                                  onDrop={(event) =>
                                    acceptManagedDrop(event, project.id)
                                  }
                                  onClick={() => {
                                    onProjectSelect(
                                      selectedProject === project.id
                                        ? ""
                                        : project.id
                                    );
                                    closeMobileNavigation();
                                  }}
                                  className={`flex min-w-0 flex-1 items-center rounded-md px-2 py-1.5 text-left text-sm ${selectedProject === project.id ? "bg-surface-hover text-foreground" : "text-muted hover:bg-surface-hover/50 hover:text-foreground-secondary"}`}
                                >
                                  <Folder className="mr-2 h-3.5 w-3.5" />
                                  {project.name}
                                </button>
                                {onRemovePersonalItem ? (
                                  <PersonalRemovalControl
                                    kind="project"
                                    name={project.name}
                                    onRemove={() =>
                                      onRemovePersonalItem({
                                        kind: "project",
                                        projectId: project.id
                                      })
                                    }
                                  />
                                ) : null}
                              </div>
                              {(managedByProject.get(project.id) ?? []).map(
                                (chat) => (
                                  <div
                                    key={chat.id}
                                    className="group flex items-center gap-0.5"
                                  >
                                    <button
                                      type="button"
                                      draggable={
                                        chat.provider === "codex" &&
                                        chat.state.toLowerCase() === "running"
                                      }
                                      onDragStart={(event) => {
                                        if (
                                          chat.provider !== "codex" ||
                                          chat.state.toLowerCase() !== "running"
                                        )
                                          return;
                                        event.dataTransfer.setData(
                                          "application/x-koed-managed-execution",
                                          chat.id
                                        );
                                        event.dataTransfer.effectAllowed =
                                          "move";
                                      }}
                                      onClick={() => {
                                        onChatSelect?.(chat.id);
                                        closeMobileNavigation();
                                      }}
                                      className="flex min-w-0 flex-1 items-center rounded-md py-1.5 pl-7 pr-2 text-left text-xs text-muted hover:bg-surface-hover/50 hover:text-foreground-secondary"
                                    >
                                      <MessageSquare className="mr-2 h-3 w-3 shrink-0" />
                                      <span className="truncate">
                                        {chat.title}
                                      </span>
                                    </button>
                                    {onRemovePersonalItem ? (
                                      <PersonalRemovalControl
                                        kind="conversation"
                                        name={chat.title}
                                        onRemove={() =>
                                          onRemovePersonalItem(
                                            managedConversationRemovalTarget({
                                              executionId: chat.id,
                                              providerSourceIds:
                                                managedProviderSourceIds?.[
                                                  chat.id
                                                ]
                                            })
                                          )
                                        }
                                      />
                                    ) : null}
                                  </div>
                                )
                              )}
                            </div>
                          ))
                        ))}
                      <div className="mt-3 rounded-md">
                        <button
                          type="button"
                          onClick={() => setChatsExpanded((value) => !value)}
                          className="flex w-full items-center px-2 py-1.5 text-left text-sm font-medium text-foreground-secondary"
                        >
                          <span>Chats</span>
                          {chatsExpanded ? (
                            <ChevronDown className="ml-1 h-3.5 w-3.5" />
                          ) : (
                            <ChevronRight className="ml-1 h-3.5 w-3.5" />
                          )}
                        </button>
                        {chatsExpanded &&
                          personalRemovalsReady &&
                          (visibleSidebarChats.length === 0 ? (
                            <p className="px-2 py-2 text-xs text-subtle">
                              No active chats are connected.
                            </p>
                          ) : (
                            visibleSidebarChats.map((chat) => (
                              <div
                                key={chat.id}
                                className="group flex items-center gap-0.5"
                              >
                                <button
                                  type="button"
                                  draggable={
                                    isManagedExecution(chat) &&
                                    chat.provider === "codex" &&
                                    chat.state.toLowerCase() === "running"
                                  }
                                  onDragStart={(event) => {
                                    if (
                                      !isManagedExecution(chat) ||
                                      chat.provider !== "codex" ||
                                      chat.state.toLowerCase() !== "running"
                                    )
                                      return;
                                    event.dataTransfer.setData(
                                      "application/x-koed-managed-execution",
                                      chat.id
                                    );
                                    event.dataTransfer.effectAllowed = "move";
                                  }}
                                  onClick={() => {
                                    onChatSelect?.(chat.id);
                                    closeMobileNavigation();
                                  }}
                                  className="flex min-w-0 flex-1 items-center rounded-md px-2 py-1.5 text-left text-sm text-muted hover:bg-surface-hover/50 hover:text-foreground-secondary"
                                >
                                  <MessageSquare className="mr-2 h-3.5 w-3.5 shrink-0" />
                                  <span className="truncate">{chat.title}</span>
                                </button>
                                {onRemovePersonalItem ? (
                                  <PersonalRemovalControl
                                    kind="conversation"
                                    name={chat.title}
                                    onRemove={() =>
                                      onRemovePersonalItem(
                                        isManagedExecution(chat)
                                          ? managedConversationRemovalTarget({
                                              executionId: chat.id,
                                              providerSourceIds:
                                                managedProviderSourceIds?.[
                                                  chat.id
                                                ]
                                            })
                                          : {
                                              kind: "conversation",
                                              sourceId: chat.id
                                            }
                                      )
                                    }
                                  />
                                ) : null}
                              </div>
                            ))
                          ))}
                      </div>
                    </div>
                  </>
                )}
              </>
            )}
          </aside>
          <div
            role="separator"
            tabIndex={0}
            aria-label="Resize workspace navigation"
            aria-orientation="vertical"
            aria-valuemin={MIN_STUDIO_SIDEBAR_WIDTH}
            aria-valuemax={maxSidebarWidth}
            aria-valuenow={renderedSidebarWidth}
            onKeyDown={onResizeKeyDown}
            onPointerDown={onResizePointerDown}
            onPointerMove={onResizePointerMove}
            onPointerUp={stopResize}
            onPointerCancel={stopResize}
            onLostPointerCapture={() => {
              resizeStartRef.current = null;
              setIsResizing(false);
            }}
            className={`flex h-dvh w-2 shrink-0 cursor-col-resize touch-none items-stretch justify-center ${isResizing ? "select-none" : ""} ${isNarrowScreen ? "hidden" : ""}`}
          >
            <span className="w-px bg-border transition-colors hover:bg-accent" />
          </div>
        </>
      )}
    </>
  );
}
