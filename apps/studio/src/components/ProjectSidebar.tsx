"use client";

import { useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Plus,
  MoreHorizontal,
  FolderOpen,
  Pin,
  Folder,
  FolderInput,
  FolderOutput,
  GitBranch,
  Archive,
  Edit2,
  Share2,
  Users,
  X,
  Check,
  Search,
  PanelLeftClose,
  MessageSquare,
  GitPullRequest,
  House,
  Bot,
  Inbox,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Tooltip } from "./Tooltip";
import { useSidebar } from "./SidebarContext";
import { CreateProjectModal } from "./CreateProjectModal";
import { AgentAvatarView } from "./AgentAvatarView";
import { SearchPalette } from "./SearchPalette";
import { useWorkspace } from "./WorkspaceProvider";
import { DEFAULT_PIXELKIN_SPEC } from "@/lib/identity";
import type { Project, Thread } from "@/lib/workspace";
import { isPersistedThread } from "@/lib/workspace";

const THREAD_DRAG_TYPE = "application/x-koed-thread";

function ChatAgentAvatar() {
  return <AgentAvatarView spec={DEFAULT_PIXELKIN_SPEC} name="Koed" size="sm" className="flex-shrink-0" />;
}

function ChatAgentAvatars({ thread }: { thread: Thread }) {
  if (!thread.messages.some((message) => message.role === "agent")) return null;
  return <ChatAgentAvatar />;
}

type ShareModalState = {
  isOpen: boolean;
  type: 'project' | 'thread';
  id: string;
  projectId?: string; // needed if type is thread
  title: string;
  currentSharedWith: string[];
};

export function ProjectSidebar({ previewMode = false, mobileOverlay = false }: { previewMode?: boolean; mobileOverlay?: boolean }) {
  const { isOpen, toggleSidebar, width, startResizing } = useSidebar();
  const pathname = usePathname();
  const router = useRouter();
  const {
    workspace,
    activeThread,
    addProject,
    renameProject,
    shareProject,
    startDraft,
    renameThread,
    shareThread,
    archiveThread,
    moveThread,
    setActiveThreadId,
    draftProject,
    personalView,
    openHome,
  } = useWorkspace();
  const { projects, threads, teams } = workspace;
  const homePath = previewMode ? "/personal-preview" : "/";
  const [shareModal, setShareModal] = useState<ShareModalState | null>(null);
  const [isProjectsExpanded, setIsProjectsExpanded] = useState(true);
  const [isChatsExpanded, setIsChatsExpanded] = useState(true);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [moveMenuThreadId, setMoveMenuThreadId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [pendingMove, setPendingMove] = useState<{ threadId: string; threadTitle: string; projectId: string | null; destinationLabel: string } | null>(null);

  const personalThreads = threads.filter((thread) => thread.projectId === null && isPersistedThread(thread));
  const isHomeActive = pathname === homePath && personalView === "home" && !activeThread && !draftProject;
  const isNewChatActive = pathname === homePath && personalView === "chat" && !activeThread && !draftProject;

  const openChat = (threadId: string) => {
    setActiveThreadId(threadId);
    router.push(homePath);
  };

  const openPersonalHome = () => {
    openHome();
    router.push(homePath);
  };

  const startNewChat = () => {
    startDraft(null);
    router.push(homePath);
  };

  const requestMoveThread = (threadId: string, projectId: string | null) => {
    const thread = threads.find((item) => item.id === threadId);
    if (!thread) return;
    const destinationLabel = projectId ? projects.find((item) => item.id === projectId)?.name ?? "another project" : "Chats";
    setPendingMove({ threadId, threadTitle: thread.title, projectId, destinationLabel });
  };
  const confirmPendingMove = () => {
    if (!pendingMove) return;
    moveThread(pendingMove.threadId, pendingMove.projectId);
    setPendingMove(null);
  };

  const acceptThreadDrop = (event: React.DragEvent, projectId: string | null) => {
    event.preventDefault();
    const threadId = event.dataTransfer.getData(THREAD_DRAG_TYPE) || event.dataTransfer.getData("text/plain");
    setDropTargetId(null);
    if (!threadId) return;
    requestMoveThread(threadId, projectId);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setIsSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const handleRenameProject = (id: string, newName: string) => {
    renameProject(id, newName);
  };

  const handleRenameThread = (_projectId: string, threadId: string, newTitle: string) => {
    renameThread(threadId, newTitle);
  };

  const openShareModal = (type: 'project' | 'thread', id: string, title: string, currentSharedWith: string[], projectId?: string) => {
    setShareModal({ isOpen: true, type, id, title, currentSharedWith, projectId });
  };

  const handleShareUpdate = (newSharedWith: string[]) => {
    if (!shareModal) return;

    if (shareModal.type === "project") {
      shareProject(shareModal.id, newSharedWith);
    } else {
      shareThread(shareModal.id, newSharedWith);
    }

    setShareModal(null);
  };

  if (!isOpen) return null;

  return (
    <>
      <div
        className={`bg-surface border-r border-border flex flex-col flex-shrink-0 relative pt-6 drag-region ${mobileOverlay ? "fixed inset-y-0 left-[72px] z-40 h-dvh w-[min(var(--sidebar-width),calc(100vw-72px))] md:relative md:inset-auto md:z-auto md:h-screen md:w-[var(--sidebar-width)]" : "h-screen"}`}
        style={{ "--sidebar-width": `${width}px` } as React.CSSProperties}
      >
        {/* Top Actions */}
        <div className="px-3 py-2 flex flex-col gap-0.5 no-drag">
          <div className="flex items-center gap-2 mb-1">
            <button
              type="button"
              onClick={openPersonalHome}
              className={`flex-1 flex items-center px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${isHomeActive ? "bg-surface-hover text-foreground" : "hover:bg-surface-hover/50 text-foreground-secondary hover:text-foreground"}`}
            >
              <House className="w-4 h-4 mr-2" /> Home
            </button>
            <Tooltip content="Close Sidebar" side="bottom">
              <button
                onClick={toggleSidebar}
                type="button"
                aria-label="Close sidebar"
                {...(mobileOverlay ? { "data-mobile-sidebar-close": true } : {})}
                className="p-1.5 hover:bg-surface-hover text-muted hover:text-foreground-secondary rounded-md transition-colors"
              >
                <PanelLeftClose className="w-4 h-4" />
              </button>
            </Tooltip>
          </div>
          <button
            type="button"
            onClick={startNewChat}
            className={`flex items-center justify-between px-3 py-1.5 rounded-md text-sm font-medium transition-colors group ${isNewChatActive ? "bg-surface-hover text-foreground" : "hover:bg-surface-hover/50 text-foreground-secondary hover:text-foreground"}`}
          >
            <span className="flex items-center"><MessageSquare className="w-4 h-4 mr-2" /> New chat</span>
            <Edit2 className="w-3.5 h-3.5 opacity-0 group-hover:opacity-100 text-subtle" />
          </button>

          <Link href="/pull-requests" className={`flex items-center px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${pathname === '/pull-requests' ? 'bg-surface-hover text-foreground' : 'hover:bg-surface-hover/50 text-muted hover:text-foreground-secondary'}`}>
            <GitPullRequest className="w-4 h-4 mr-2" /> Pull Requests
          </Link>
          <Link href="/agents" className={`flex items-center px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${pathname === '/agents' ? 'bg-surface-hover text-foreground' : 'hover:bg-surface-hover/50 text-muted hover:text-foreground-secondary'}`}>
            <Bot className="w-4 h-4 mr-2" /> Agents
          </Link>
          <div aria-disabled="true" title="Memory Inbox is not connected yet." className="flex items-center px-3 py-1.5 rounded-md text-sm font-medium text-faint">
            <Inbox className="w-4 h-4 mr-2" /> Memory Inbox
          </div>
        </div>

        {/* Projects Section Header */}
        <div className="px-4 py-1.5 mt-4 flex items-center justify-between no-drag">
          <div
            className="flex items-center text-sm font-medium text-foreground-secondary cursor-pointer hover:text-foreground transition-colors"
            onClick={() => setIsProjectsExpanded(!isProjectsExpanded)}
          >
            <span>Projects</span>
            {isProjectsExpanded ? (
              <ChevronDown className="w-3.5 h-3.5 ml-1" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 ml-1" />
            )}
          </div>
          <div className="flex items-center gap-1">
            <Tooltip content="Search Projects" side="bottom">
              <button
                className="p-1 hover:bg-surface-hover hover:text-foreground-secondary rounded-md transition-colors"
                onClick={() => setIsSearchOpen(true)}
              >
                <Search className="w-3.5 h-3.5" />
              </button>
            </Tooltip>
            <Tooltip content="New Project" side="bottom">
              <button
                className="p-1 hover:bg-surface-hover hover:text-foreground-secondary rounded-md transition-colors"
                onClick={() => setIsCreateOpen(true)}
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </Tooltip>
          </div>
        </div>

        {/* Project List */}
        <div
          className="flex-1 overflow-y-auto px-2 pt-0.5 pb-2 space-y-0.5 no-drag"
          onDragEnd={() => setDropTargetId(null)}
        >
          {isProjectsExpanded && (
            projects.length === 0 ? (
              <p className="px-3 py-6 text-xs text-subtle">
                No projects yet. Use + to create one.
              </p>
            ) : (
              projects.map(project => (
                <ProjectItem
                  key={project.id}
                  project={project}
                  threads={threads.filter((thread) => thread.projectId === project.id && isPersistedThread(thread))}
                  activeThreadId={activeThread?.id ?? null}
                  isDropTarget={dropTargetId === project.id}
                  isDraftTarget={draftProject?.id === project.id}
                  teams={teams}
                  projects={projects}
                  moveMenuThreadId={moveMenuThreadId}
                  onRenameProject={handleRenameProject}
                  onRenameThread={handleRenameThread}
                  onShareProject={() => openShareModal('project', project.id, project.name, project.sharedWith || [])}
                  onShareThread={(threadId, title, sharedWith) => openShareModal('thread', threadId, title, sharedWith, project.id)}
                  onSelectThread={openChat}
                  onCreateThread={() => {
                    startDraft(project.id);
                    router.push(homePath);
                  }}
                  onArchiveThread={archiveThread}
                  onMoveThread={(threadId, projectId) => {
                    requestMoveThread(threadId, projectId);
                    setMoveMenuThreadId(null);
                  }}
                  onToggleMoveMenu={(threadId) => {
                    setMoveMenuThreadId((current) => (current === threadId ? null : threadId));
                  }}
                  onDragOverProject={() => setDropTargetId(project.id)}
                  onDragLeaveProject={() => {
                    if (dropTargetId === project.id) setDropTargetId(null);
                  }}
                  onDropThread={(event) => acceptThreadDrop(event, project.id)}
                />
              ))
            )
          )}
          {personalThreads.length > 0 && (
            <div
              className={`mt-3 rounded-md ${dropTargetId === "chats" ? "bg-surface-hover/80 ring-1 ring-accent" : ""}`}
              onDragOver={(event) => {
                event.preventDefault();
                setDropTargetId("chats");
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                  if (dropTargetId === "chats") setDropTargetId(null);
                }
              }}
              onDrop={(event) => acceptThreadDrop(event, null)}
            >
              <button
                type="button"
                onClick={() => setIsChatsExpanded((current) => !current)}
                className="flex w-full items-center px-2 py-1.5 text-left text-sm font-medium text-foreground-secondary transition-colors hover:text-foreground"
              >
                <span>Chats</span>
                {isChatsExpanded ? (
                  <ChevronDown className="ml-1 h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="ml-1 h-3.5 w-3.5" />
                )}
              </button>
              {isChatsExpanded && (
                <div className="space-y-0.5">
                  {personalThreads.map((thread) => (
                    <div
                      key={thread.id}
                      className={`group relative flex w-full items-center rounded-md text-xs transition-colors ${
                        activeThread?.id === thread.id
                          ? "bg-surface-hover text-foreground"
                          : "text-muted hover:bg-surface-hover/50 hover:text-foreground-secondary"
                      }`}
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.setData(THREAD_DRAG_TYPE, thread.id);
                        event.dataTransfer.setData("text/plain", thread.id);
                        event.dataTransfer.effectAllowed = "move";
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => openChat(thread.id)}
                        className="min-w-0 flex-1 truncate px-2 py-1.5 text-left"
                      >
                        <ChatAgentAvatars thread={thread} />
                        {thread.title}
                      </button>
                      <div className="flex items-center gap-0.5 pr-1 opacity-0 transition-all group-hover:opacity-100">
                        {projects.length > 0 && (
                          <Tooltip content="Move to project" side="right">
                            <button
                              type="button"
                              aria-label="Move to project"
                              className="rounded p-1 text-muted transition-colors hover:bg-surface-active hover:text-foreground-secondary"
                              onClick={(event) => {
                                event.stopPropagation();
                                setMoveMenuThreadId((current) => (current === thread.id ? null : thread.id));
                              }}
                            >
                              <FolderInput className="h-3 w-3" />
                            </button>
                          </Tooltip>
                        )}
                        <Tooltip content="Archive chat" side="right">
                          <button
                            type="button"
                            aria-label="Archive chat"
                            className="rounded p-1 text-muted transition-colors hover:bg-surface-active hover:text-foreground-secondary"
                            onClick={(event) => {
                              event.stopPropagation();
                              archiveThread(thread.id);
                            }}
                          >
                            <Archive className="h-3 w-3" />
                          </button>
                        </Tooltip>
                      </div>
                      {moveMenuThreadId === thread.id && (
                        <MoveToMenu
                          projects={projects}
                          excludeProjectId={null}
                          onSelect={(projectId) => {
              requestMoveThread(thread.id, projectId);
                            setMoveMenuThreadId(null);
                          }}
                          onClose={() => setMoveMenuThreadId(null)}
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Resize Handle */}
        <div
          className="absolute top-0 right-0 hidden w-1 h-full cursor-col-resize hover:bg-surface-active active:bg-surface-active transition-colors z-50 md:block"
          onMouseDown={startResizing}
        />
      </div>

      {/* Share Modal */}
      {shareModal && shareModal.isOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-surface border border-border rounded-xl w-80 shadow-2xl overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-200">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between bg-background/50">
              <h3 className="text-sm font-medium text-foreground truncate pr-4">
                Share <span className="text-muted">&ldquo;{shareModal.title}&rdquo;</span>
              </h3>
              <button
                className="text-subtle hover:text-foreground-secondary transition-colors"
                onClick={() => setShareModal(null)}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-2 max-h-64 overflow-y-auto">
              <div className="px-2 py-1.5 mb-1 text-[11px] font-semibold text-subtle uppercase tracking-wider">
                Select Teams
              </div>
              {teams.map(team => {
                const isShared = shareModal.currentSharedWith.includes(team.id);
                return (
                  <div
                    key={team.id}
                    className="flex items-center justify-between px-3 py-2 hover:bg-surface-hover rounded-lg cursor-pointer transition-colors group"
                    onClick={() => {
                      const newShared = isShared
                        ? shareModal.currentSharedWith.filter(id => id !== team.id)
                        : [...shareModal.currentSharedWith, team.id];
                      setShareModal({ ...shareModal, currentSharedWith: newShared });
                    }}
                  >
                    <span className="text-sm text-foreground-secondary">{team.name}</span>
                    <div className={`w-4 h-4 rounded-sm border flex items-center justify-center transition-colors ${isShared ? 'bg-chip border-chip text-chip-foreground' : 'border-border-strong group-hover:border-border-strong text-transparent'}`}>
                      <Check className="w-3 h-3" strokeWidth={3} />
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="p-3 border-t border-border bg-background/50 flex justify-end">
              <button
                className="bg-chip hover:bg-white text-chip-foreground text-xs font-medium px-4 py-2 rounded-lg transition-colors"
                onClick={() => handleShareUpdate(shareModal.currentSharedWith)}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
      {isSearchOpen && (
        <SearchPalette
          projects={projects}
          threads={threads.filter(isPersistedThread).map((thread) => ({
            id: thread.id,
            title: thread.title,
            projectId: thread.projectId,
            projectName: projects.find((project) => project.id === thread.projectId)?.name ?? "Personal",
          }))}
          teams={teams}
          onClose={() => setIsSearchOpen(false)}
          onNewProject={() => {
            setIsSearchOpen(false);
            setIsCreateOpen(true);
          }}
          onSelectThread={(threadId) => {
            openChat(threadId);
            setIsSearchOpen(false);
          }}
          onNewChat={() => {
            setIsSearchOpen(false);
            startNewChat();
          }}
        />
      )}

      {isCreateOpen && (
        <CreateProjectModal
          teams={teams}
          previewMode={previewMode}
          onClose={() => setIsCreateOpen(false)}
          onCreate={(project) => {
            addProject({
              name: project.name,
              path: project.path,
              branch: project.branch,
              githubRepo: project.githubRepo,
              sharedWith: project.sharedWith,
            });
            setIsCreateOpen(false);
          }}
        />
      )}
      {pendingMove && (
        // Keep this generic confirmation scoped to the preview WorkspaceProvider move.
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm no-drag" onClick={() => setPendingMove(null)}>
          <div role="dialog" aria-modal="true" aria-labelledby="move-thread-title" className="w-[380px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-surface shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="px-5 py-4">
              <h2 id="move-thread-title" className="text-base font-semibold text-foreground">Move thread?</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted">Move <span className="font-medium text-foreground-secondary">&ldquo;{pendingMove.threadTitle}&rdquo;</span> to <span className="font-medium text-foreground-secondary">{pendingMove.destinationLabel}</span>?</p>
            </div>
            <div className="flex justify-end gap-2 border-t border-border bg-background/40 px-5 py-3">
              <button type="button" className="rounded-md px-3.5 py-2 text-sm font-medium text-foreground-secondary hover:bg-surface-hover" onClick={() => setPendingMove(null)}>Cancel</button>
              <button type="button" className="rounded-md bg-chip px-4 py-2 text-sm font-medium text-chip-foreground hover:bg-white" onClick={confirmPendingMove}>Move</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function MoveToMenu({
  projects,
  excludeProjectId,
  allowUnassign,
  onSelect,
  onClose,
}: {
  projects: Project[];
  excludeProjectId: string | null;
  allowUnassign?: boolean;
  onSelect: (projectId: string | null) => void;
  onClose: () => void;
}) {
  const destinations = projects.filter((project) => project.id !== excludeProjectId);

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute right-0 top-7 z-50 w-44 rounded-lg border border-border-strong bg-surface p-1 shadow-xl">
        {allowUnassign && (
          <button
            type="button"
            className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs text-foreground-secondary hover:bg-surface-hover"
            onClick={() => onSelect(null)}
          >
            <FolderOutput className="mr-2 h-3 w-3" />
            Move to Chats
          </button>
        )}
        {destinations.map((project) => (
          <button
            key={project.id}
            type="button"
            className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs text-foreground-secondary hover:bg-surface-hover"
            onClick={() => onSelect(project.id)}
          >
            <Folder className="mr-2 h-3 w-3" />
            {project.name}
          </button>
        ))}
        {destinations.length === 0 && !allowUnassign && (
          <p className="px-2 py-1.5 text-xs text-subtle">No other projects</p>
        )}
      </div>
    </>
  );
}

function ProjectItem({
  project,
  threads,
  activeThreadId,
  isDropTarget,
  isDraftTarget,
  teams,
  projects,
  moveMenuThreadId,
  onRenameProject,
  onRenameThread,
  onShareProject,
  onShareThread,
  onSelectThread,
  onCreateThread,
  onArchiveThread,
  onMoveThread,
  onToggleMoveMenu,
  onDragOverProject,
  onDragLeaveProject,
  onDropThread,
}: {
  project: Project;
  threads: Thread[];
  activeThreadId: string | null;
  isDropTarget: boolean;
  isDraftTarget: boolean;
  teams: { id: string; name: string }[];
  projects: Project[];
  moveMenuThreadId: string | null;
  onRenameProject: (id: string, newName: string) => void;
  onRenameThread: (projectId: string, threadId: string, newTitle: string) => void;
  onShareProject: () => void;
  onShareThread: (threadId: string, title: string, sharedWith: string[]) => void;
  onSelectThread: (threadId: string) => void;
  onCreateThread: () => void;
  onArchiveThread: (threadId: string) => void;
  onMoveThread: (threadId: string, projectId: string | null) => void;
  onToggleMoveMenu: (threadId: string) => void;
  onDragOverProject: () => void;
  onDragLeaveProject: () => void;
  onDropThread: (event: React.DragEvent) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [showMenu, setShowMenu] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0 });

  // Renaming state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingType, setEditingType] = useState<'project' | 'thread' | null>(null);
  const [editValue, setEditValue] = useState("");

  const startEditing = (id: string, type: 'project' | 'thread', currentValue: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(id);
    setEditingType(type);
    setEditValue(currentValue);
    setShowMenu(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      saveEdit();
    } else if (e.key === 'Escape') {
      cancelEdit();
    }
  };

  const saveEdit = () => {
    if (editingType === 'project') {
      onRenameProject(project.id, editValue);
    } else if (editingType === 'thread' && editingId) {
      onRenameThread(project.id, editingId, editValue);
    }
    cancelEdit();
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingType(null);
    setEditValue("");
  };

  // Helper to get team names for tooltip
  const getSharedTeamsText = (sharedIds?: string[]) => {
    if (!sharedIds || sharedIds.length === 0) return "";
    const names = sharedIds.map(id => teams.find(t => t.id === id)?.name).filter(Boolean);
    return `Shared with: ${names.join(", ")}`;
  };

  return (
    <div
      className="flex flex-col"
      onDragOver={(event) => {
        event.preventDefault();
        onDragOverProject();
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) {
          onDragLeaveProject();
        }
      }}
      onDrop={onDropThread}
    >
      {/* Project Header */}
      <div
        className={`group flex items-center py-1.5 px-2 rounded-md cursor-pointer hover:bg-surface-hover/50 transition-colors relative ${
          isDropTarget ? "bg-surface-hover ring-1 ring-accent" : ""
        } ${isDraftTarget ? "bg-surface-hover/40" : ""}`}
        onClick={() => setExpanded(!expanded)}
      >
        <div className="mr-1.5 text-subtle group-hover:text-foreground-secondary transition-colors">
          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </div>

        <div className="flex items-center text-sm font-medium text-foreground-secondary truncate flex-1">
          {expanded ? (
            <FolderOpen className="w-4 h-4 mr-2 text-muted flex-shrink-0" />
          ) : (
            <Folder className="w-4 h-4 mr-2 text-muted flex-shrink-0" />
          )}
          {editingType === 'project' && editingId === project.id ? (
            <input
              autoFocus
              className="bg-background border border-border-strong rounded px-1.5 py-0.5 text-foreground outline-none w-full"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={saveEdit}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="truncate">{project.name}</span>
          )}
        </div>

        {/* Visual Indicator for Shared Project */}
        {project.sharedWith && project.sharedWith.length > 0 && (
          <div className="flex items-center mr-1">
            <Tooltip content={getSharedTeamsText(project.sharedWith)}>
              <Users className="w-3.5 h-3.5 text-subtle hover:text-foreground-secondary transition-colors" />
            </Tooltip>
          </div>
        )}

        {/* GitHub Status Dot */}
        <div className="flex items-center mx-2 flex-shrink-0">
          {project.gitStatus === 'dirty' && (
            <Tooltip content="Uncommitted changes">
              <span className="w-1.5 h-1.5 rounded-full bg-warning block" />
            </Tooltip>
          )}
          {project.gitStatus === 'clean' && (
            <Tooltip content="Clean working tree">
              <span className="w-1.5 h-1.5 rounded-full bg-success block" />
            </Tooltip>
          )}
        </div>

        {/* Three Dots Menu Trigger */}
        <Tooltip content="Project Options" side="right">
          <button
            className="opacity-0 group-hover:opacity-100 p-1 hover:bg-surface-active rounded text-muted hover:text-foreground-secondary transition-all flex-shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              const rect = e.currentTarget.getBoundingClientRect();
              setMenuPos({ top: rect.top });
              setShowMenu(!showMenu);
            }}
          >
            <MoreHorizontal className="w-4 h-4" />
          </button>
        </Tooltip>

        {/* Hover Menu Popup (Fixed position to break out of sidebar) */}
        {showMenu && (
          <>
            {/* Invisible overlay to catch clicks outside the popup */}
            <div
              className="fixed inset-0 z-40"
              onClick={(e) => {
                e.stopPropagation();
                setShowMenu(false);
              }}
            />
            <div
              className="fixed w-64 bg-surface border border-border-strong rounded-lg shadow-xl z-50 p-2 text-xs text-foreground-secondary"
              style={{ left: '352px', top: `${menuPos.top}px` }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-2 pb-2 border-b border-border">
                <span className="font-semibold text-foreground truncate pr-2">{project.name}</span>
                <div className="flex items-center gap-1">
                  <Tooltip content="Rename Project">
                    <button
                      className="p-1 hover:bg-surface-hover rounded text-muted hover:text-foreground transition-colors"
                      onClick={(e) => startEditing(project.id, 'project', project.name, e)}
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                  </Tooltip>
                  <Tooltip content="Share Project">
                    <button
                      className="p-1 hover:bg-surface-hover rounded text-muted hover:text-foreground transition-colors"
                      onClick={(e) => {
                        e.stopPropagation();
                        // Don't close the menu, just open the share modal over it
                        onShareProject();
                      }}
                    >
                      <Share2 className="w-3.5 h-3.5" />
                    </button>
                  </Tooltip>
                  <Tooltip content="Pin Project">
                    <button className="p-1 hover:bg-surface-hover rounded text-muted hover:text-foreground transition-colors">
                      <Pin className="w-3.5 h-3.5" />
                    </button>
                  </Tooltip>
                </div>
              </div>

              <div className="flex items-center py-1.5 text-muted">
                <Folder className="w-3.5 h-3.5 mr-2 flex-shrink-0" />
                <span className="truncate" title={project.path}>{project.path}</span>
              </div>

              <div className="flex items-center py-1.5 text-muted">
                <GitBranch className="w-3.5 h-3.5 mr-2 flex-shrink-0" />
                <span className="truncate">{project.branch}</span>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Threads List (Expanded) */}
      {expanded && (
        <div className="mt-0.5 ml-6 pl-2 space-y-0.5">
          {threads.map(thread => (
            <div
              key={thread.id}
              className={`group relative flex items-center rounded-md cursor-pointer transition-colors ${
                activeThreadId === thread.id ? 'bg-surface-hover text-foreground' : 'text-muted hover:bg-surface-hover/50 hover:text-foreground-secondary'
              }`}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(THREAD_DRAG_TYPE, thread.id);
                event.dataTransfer.setData("text/plain", thread.id);
                event.dataTransfer.effectAllowed = "move";
              }}
              onClick={() => onSelectThread(thread.id)}
            >
              {editingType === 'thread' && editingId === thread.id ? (
                <input
                  autoFocus
                  className="bg-background border border-border-strong rounded px-1.5 py-0.5 text-xs text-foreground outline-none w-full"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onBlur={saveEdit}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <>
                  <span className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-xs">
                    <ChatAgentAvatars thread={thread} />
                    <span className="truncate">{thread.title}</span>
                  </span>

                  {/* Visual Indicator for Shared Thread */}
                  {thread.sharedWith && thread.sharedWith.length > 0 && (
                    <div className="flex items-center mr-2">
                      <Tooltip content={getSharedTeamsText(thread.sharedWith)}>
                        <Users className="w-3 h-3 text-subtle hover:text-foreground-secondary transition-colors" />
                      </Tooltip>
                    </div>
                  )}

                  <div className="opacity-0 group-hover:opacity-100 flex items-center gap-1 transition-all flex-shrink-0 pr-1">
                    <Tooltip content="Move thread">
                      <button
                        aria-label="Move thread"
                        className="p-1 hover:bg-surface-active rounded text-muted hover:text-foreground-secondary"
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleMoveMenu(thread.id);
                        }}
                      >
                        <FolderInput className="w-3 h-3" />
                      </button>
                    </Tooltip>
                    <Tooltip content="Share Thread">
                      <button
                        className="p-1 hover:bg-surface-active rounded text-muted hover:text-foreground-secondary"
                        onClick={(e) => {
                          e.stopPropagation();
                          onShareThread(thread.id, thread.title, thread.sharedWith || []);
                        }}
                      >
                        <Share2 className="w-3 h-3" />
                      </button>
                    </Tooltip>
                    <Tooltip content="Rename Thread">
                      <button
                        className="p-1 hover:bg-surface-active rounded text-muted hover:text-foreground-secondary"
                        onClick={(e) => startEditing(thread.id, 'thread', thread.title, e)}
                      >
                        <Edit2 className="w-3 h-3" />
                      </button>
                    </Tooltip>
                    <Tooltip content="Archive chat">
                      <button
                        type="button"
                        aria-label="Archive chat"
                        className="p-1 hover:bg-surface-active rounded text-muted hover:text-foreground-secondary"
                        onClick={(e) => {
                          e.stopPropagation();
                          onArchiveThread(thread.id);
                        }}
                      >
                        <Archive className="w-3 h-3" />
                      </button>
                    </Tooltip>
                  </div>
                  {moveMenuThreadId === thread.id && (
                    <MoveToMenu
                      projects={projects}
                      excludeProjectId={project.id}
                      allowUnassign
                      onSelect={(projectId) => onMoveThread(thread.id, projectId)}
                      onClose={() => onToggleMoveMenu(thread.id)}
                    />
                  )}
                </>
              )}
            </div>
          ))}

          <Tooltip content="Create New Thread" side="right">
            <button
              type="button"
              className="flex w-full items-center px-2 py-1.5 mt-0.5 rounded-md cursor-pointer text-subtle hover:text-foreground-secondary hover:bg-surface-hover/30 transition-colors"
              onClick={(event) => {
                event.stopPropagation();
                onCreateThread();
              }}
            >
              <Plus className="w-3.5 h-3.5 mr-2.5" />
              <span className="text-xs">New Thread</span>
            </button>
          </Tooltip>
        </div>
      )}
    </div>
  );
}
