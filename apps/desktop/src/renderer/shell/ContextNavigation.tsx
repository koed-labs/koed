import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Folder,
  Hash,
  Library,
  LoaderCircle,
  LockKeyhole,
  MessageCircle,
  MessagesSquare,
  NotebookPen,
  Plus,
  Sparkles,
  UsersRound
} from "lucide-react";
import type { PersonalDesktopAskThread } from "@koed/shared/personal-desktop";
import { useState, type ReactNode } from "react";

export type ContextNavItem = {
  archived?: boolean;
  id: string;
  label: string;
  selected: boolean;
  unavailable?: boolean;
  unreadCount?: number;
};

export type WorkspaceNavItem = {
  canCreateChannel?: boolean;
  channels: readonly ContextNavItem[];
  id: string;
  label: string;
  selected: boolean;
  sharedMemorySelected: boolean;
  sharedMemoryUnreadCount?: number;
};

function SidebarHeader({
  action,
  eyebrow,
  title
}: {
  action?: ReactNode;
  eyebrow?: string;
  title: string;
}) {
  return (
    <header className="desktop-sidebar-header">
      <div>
        <h1>{title}</h1>
        {eyebrow ? <small>{eyebrow}</small> : null}
      </div>
      {action}
    </header>
  );
}

function Section({
  action,
  children,
  className,
  title
}: {
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  title: string;
}) {
  return (
    <section
      className={`desktop-sidebar-section${className ? ` ${className}` : ""}`}
    >
      <header>
        <span>{title}</span>
        {action}
      </header>
      <div className="desktop-sidebar-items">{children}</div>
    </section>
  );
}

function IconButton({
  children,
  disabled = false,
  disabledTitle,
  label,
  onClick
}: {
  children: ReactNode;
  disabled?: boolean;
  disabledTitle?: string;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      aria-label={label}
      className="desktop-sidebar-icon-button"
      disabled={disabled}
      onClick={onClick}
      title={disabled ? disabledTitle : label}
      type="button"
    >
      {children}
    </button>
  );
}

function NavItem({
  icon,
  item,
  onSelect
}: {
  icon: ReactNode;
  item: ContextNavItem;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      aria-current={item.selected ? "page" : undefined}
      className="desktop-sidebar-nav-item"
      data-selected={item.selected || undefined}
      data-unavailable={item.unavailable || undefined}
      onClick={() => onSelect(item.id)}
      type="button"
    >
      <span className="desktop-sidebar-nav-icon">{icon}</span>
      <span className="desktop-sidebar-nav-label">{item.label}</span>
      {item.unreadCount ? (
        <span
          className="desktop-sidebar-unread"
          aria-label={`${item.unreadCount} unread`}
        >
          {item.unreadCount > 99 ? "99+" : item.unreadCount}
        </span>
      ) : null}
    </button>
  );
}

function AskRecentItem({
  onSelect,
  selected,
  thread
}: {
  onSelect: (askThreadId: string) => void;
  selected: boolean;
  thread: PersonalDesktopAskThread;
}) {
  const icon =
    thread.latestStatus === "error" ? (
      <CircleAlert aria-hidden="true" />
    ) : thread.latestStatus === "pending" ? (
      <LoaderCircle aria-hidden="true" />
    ) : (
      <Sparkles aria-hidden="true" />
    );
  return (
    <button
      aria-current={selected ? "page" : undefined}
      className="desktop-sidebar-nav-item desktop-sidebar-ask-recent"
      data-selected={selected || undefined}
      onClick={() => onSelect(thread.askThreadId)}
      type="button"
    >
      <span
        className="desktop-sidebar-nav-icon"
        data-status={thread.latestStatus}
      >
        {icon}
      </span>
      <span className="desktop-sidebar-nav-label">{thread.firstQuestion}</span>
    </button>
  );
}

export function LockedFeatureRow({
  explanation,
  label
}: {
  explanation: string;
  label: string;
}) {
  return (
    <div className="desktop-sidebar-locked" title={explanation}>
      <LockKeyhole aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function PersonalContextNavigation({
  askRecents = [],
  askRecentsError,
  askRecentsNextCursor = null,
  askSelected = false,
  notesSelected,
  onLoadOlderAskThreads,
  onOpenAsk = () => undefined,
  onOpenNotes,
  onOpenProjects,
  onOpenShares,
  onSelectAskThread,
  projectsSelected,
  selectedAskThreadId,
  sharesSelected,
  sharesUnavailable = false,
  teamCollaborationEnabled = true
}: {
  askRecents?: readonly PersonalDesktopAskThread[];
  askRecentsError?: string | null;
  askRecentsNextCursor?: string | null;
  askSelected?: boolean;
  notesSelected: boolean;
  onLoadOlderAskThreads?: () => void;
  onOpenAsk?: () => void;
  onOpenNotes: () => void;
  onOpenProjects: () => void;
  onOpenShares: () => void;
  onSelectAskThread?: (askThreadId: string) => void;
  projectsSelected: boolean;
  selectedAskThreadId?: string;
  sharesSelected: boolean;
  sharesUnavailable?: boolean;
  teamCollaborationEnabled?: boolean;
}) {
  return (
    <div className="desktop-context-content desktop-personal-context-content">
      <SidebarHeader eyebrow="Private to you" title="Personal" />
      <Section title="Memory">
        <NavItem
          icon={<Sparkles aria-hidden="true" />}
          item={{ id: "ask", label: "Ask", selected: askSelected }}
          onSelect={onOpenAsk}
        />
        <NavItem
          icon={<Folder aria-hidden="true" />}
          item={{
            id: "projects",
            label: "Projects",
            selected: projectsSelected
          }}
          onSelect={onOpenProjects}
        />
        <NavItem
          icon={<NotebookPen aria-hidden="true" />}
          item={{
            id: "notes",
            label: "Notes",
            selected: notesSelected
          }}
          onSelect={onOpenNotes}
        />
        {teamCollaborationEnabled ? (
          <NavItem
            icon={<Library aria-hidden="true" />}
            item={{
              id: "shares",
              label: "Shares",
              selected: sharesSelected,
              unavailable: sharesUnavailable
            }}
            onSelect={onOpenShares}
          />
        ) : null}
      </Section>
      <Section className="desktop-sidebar-recents-section" title="Recents">
        {askRecents.map((thread) => (
          <AskRecentItem
            key={thread.askThreadId}
            onSelect={onSelectAskThread ?? (() => undefined)}
            selected={thread.askThreadId === selectedAskThreadId}
            thread={thread}
          />
        ))}
        {askRecentsNextCursor && onLoadOlderAskThreads ? (
          <button
            className="desktop-sidebar-load-more"
            onClick={onLoadOlderAskThreads}
            type="button"
          >
            Load older
          </button>
        ) : null}
        {askRecentsError ? (
          <p className="desktop-sidebar-section-state" role="status">
            {askRecentsError}
          </p>
        ) : null}
      </Section>
    </div>
  );
}

function WorkspaceSection({
  onCreateChannel,
  onOpenSharedMemory,
  onSelectChannel,
  workspace
}: {
  onCreateChannel?: (workspaceId: string) => void;
  onOpenSharedMemory: (workspaceId: string) => void;
  onSelectChannel: (workspaceId: string, threadId: string) => void;
  workspace: WorkspaceNavItem;
}) {
  const [expanded, setExpanded] = useState(
    workspace.selected || workspace.sharedMemorySelected
  );
  return (
    <section className="desktop-workspace-section">
      <div className="desktop-workspace-heading-row">
        <button
          aria-expanded={expanded}
          className="desktop-workspace-heading"
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          {expanded ? (
            <ChevronDown aria-hidden="true" />
          ) : (
            <ChevronRight aria-hidden="true" />
          )}
          <span>{workspace.label}</span>
        </button>
        {onCreateChannel && workspace.canCreateChannel ? (
          <IconButton
            label={`Create channel in ${workspace.label}`}
            onClick={() => onCreateChannel(workspace.id)}
          >
            <Plus aria-hidden="true" />
          </IconButton>
        ) : null}
      </div>
      {expanded ? (
        <div className="desktop-sidebar-items">
          {workspace.channels.map((item) => (
            <NavItem
              icon={<Hash aria-hidden="true" />}
              item={item}
              key={item.id}
              onSelect={(threadId) => onSelectChannel(workspace.id, threadId)}
            />
          ))}
          <NavItem
            icon={<BookOpen aria-hidden="true" />}
            item={{
              id: workspace.id,
              label: "Shared Memory",
              selected: workspace.sharedMemorySelected,
              unreadCount: workspace.sharedMemoryUnreadCount
            }}
            onSelect={onOpenSharedMemory}
          />
        </div>
      ) : null}
    </section>
  );
}

export function TeamContextNavigation({
  directMessages,
  onCreateChannel,
  onCreateWorkspace,
  onOpenPeople,
  onOpenSharedMemory,
  onSelectChannel,
  onSelectDirectMessage,
  onStartDirectMessage,
  peopleSelected,
  role,
  teamName,
  workspaces
}: {
  directMessages: readonly ContextNavItem[];
  onCreateChannel?: (workspaceId: string) => void;
  onCreateWorkspace?: () => void;
  onOpenPeople: () => void;
  onOpenSharedMemory: (workspaceId: string) => void;
  onSelectChannel: (workspaceId: string, threadId: string) => void;
  onSelectDirectMessage: (threadId: string) => void;
  onStartDirectMessage: () => void;
  peopleSelected: boolean;
  role: string;
  teamName: string;
  workspaces: readonly WorkspaceNavItem[];
}) {
  const roleLabel = role
    ? `${role.slice(0, 1).toLocaleUpperCase()}${role.slice(1)}`
    : role;
  return (
    <div className="desktop-context-content">
      <SidebarHeader eyebrow={roleLabel} title={teamName} />
      <Section title="Team">
        <NavItem
          icon={<UsersRound aria-hidden="true" />}
          item={{ id: "people", label: "People", selected: peopleSelected }}
          onSelect={onOpenPeople}
        />
      </Section>
      <Section
        title="Direct messages"
        action={
          <IconButton
            label="Start direct message"
            onClick={onStartDirectMessage}
          >
            <Plus aria-hidden="true" />
          </IconButton>
        }
      >
        {directMessages.length ? (
          directMessages.map((item) => (
            <NavItem
              icon={
                <MessageCircle
                  aria-hidden="true"
                  data-group={item.label.includes(",") || undefined}
                />
              }
              item={item}
              key={item.id}
              onSelect={onSelectDirectMessage}
            />
          ))
        ) : (
          <p className="desktop-sidebar-empty">No direct messages yet.</p>
        )}
      </Section>
      <Section
        title="Workspaces"
        action={
          <IconButton
            disabled={!onCreateWorkspace}
            disabledTitle="Only Team owners and administrators can create Workspaces"
            label="Create Workspace"
            onClick={onCreateWorkspace}
          >
            <Plus aria-hidden="true" />
          </IconButton>
        }
      >
        {workspaces.length ? (
          workspaces.map((workspace) => (
            <WorkspaceSection
              key={workspace.id}
              onCreateChannel={onCreateChannel}
              onOpenSharedMemory={onOpenSharedMemory}
              onSelectChannel={onSelectChannel}
              workspace={workspace}
            />
          ))
        ) : (
          <p className="desktop-sidebar-empty">No accessible Workspaces.</p>
        )}
      </Section>
    </div>
  );
}

export function InboxContextNavigation({
  needsAttention,
  unread
}: {
  needsAttention: number;
  unread: number;
}) {
  return (
    <div className="desktop-context-content">
      <SidebarHeader title="Inbox" />
      <Section title="Views">
        <NavItem
          icon={<MessagesSquare aria-hidden="true" />}
          item={{
            id: "unread",
            label: "Unread",
            selected: true,
            unreadCount: unread
          }}
          onSelect={() => undefined}
        />
        <NavItem
          icon={<LockKeyhole aria-hidden="true" />}
          item={{
            id: "attention",
            label: "Needs attention",
            selected: false,
            unreadCount: needsAttention
          }}
          onSelect={() => undefined}
        />
      </Section>
    </div>
  );
}
