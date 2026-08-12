import {
  Archive,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Folder,
  Hash,
  LockKeyhole,
  MessageCircle,
  MessagesSquare,
  NotebookPen,
  Plus,
  UsersRound
} from "lucide-react";
import { useState, type ReactNode } from "react";

export type ContextNavItem = {
  archived?: boolean;
  id: string;
  label: string;
  selected: boolean;
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
  title
}: {
  action?: ReactNode;
  children: ReactNode;
  title: string;
}) {
  return (
    <section className="desktop-sidebar-section">
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
  channels,
  notesSelected,
  onCreateChannel,
  onOpenNotes,
  onOpenProjects,
  onSelectChannel,
  projectsSelected
}: {
  channels: readonly ContextNavItem[];
  notesSelected: boolean;
  onCreateChannel: () => void;
  onOpenNotes: () => void;
  onOpenProjects: () => void;
  onSelectChannel: (threadId: string) => void;
  projectsSelected: boolean;
}) {
  const activeChannels = channels.filter((item) => !item.archived);
  const archivedChannels = channels.filter((item) => item.archived);
  return (
    <div className="desktop-context-content">
      <SidebarHeader eyebrow="Private to you" title="Personal" />
      <Section title="Memory">
        <NavItem
          icon={<Folder aria-hidden="true" />}
          item={{
            id: "projects",
            label: "Projects",
            selected: projectsSelected
          }}
          onSelect={onOpenProjects}
        />
        <LockedFeatureRow
          explanation="Memory Answer needs a dedicated protected Desktop contract."
          label="Ask Memory"
        />
      </Section>
      <Section
        title="Channels"
        action={
          <IconButton label="Create Personal channel" onClick={onCreateChannel}>
            <Plus aria-hidden="true" />
          </IconButton>
        }
      >
        <NavItem
          icon={<NotebookPen aria-hidden="true" />}
          item={{
            id: "notes",
            label: "Notes to self",
            selected: notesSelected
          }}
          onSelect={onOpenNotes}
        />
        {activeChannels.map((item) => (
          <NavItem
            icon={<Hash aria-hidden="true" />}
            item={item}
            key={item.id}
            onSelect={onSelectChannel}
          />
        ))}
      </Section>
      {archivedChannels.length ? (
        <details className="desktop-sidebar-archived">
          <summary>
            <Archive aria-hidden="true" />
            Archived
          </summary>
          {archivedChannels.map((item) => (
            <NavItem
              icon={<Hash aria-hidden="true" />}
              item={item}
              key={item.id}
              onSelect={onSelectChannel}
            />
          ))}
        </details>
      ) : null}
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
