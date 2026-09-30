"use client";

import { useEffect, useRef, useState } from "react";
import {
  Bell,
  Bot,
  ChevronDown,
  ChevronRight,
  FolderGit2,
  Globe,
  Hash,
  MessageSquare,
  PanelLeftClose,
  Plus,
  Search,
  X,
  Users
} from "lucide-react";
import type { CollaborationThread } from "@koed/shared/collaboration";
import {
  CURRENT_USER_ID,
  isDmUnread,
  latestDmMessage,
  resolveAgents,
  slugifyChannelName,
  statusLabel
} from "@/lib/collab";
import { projectsForTeam } from "@/lib/workspace";
import { AddAgentModal } from "./AddAgentModal";
import { CreateProjectModal } from "./CreateProjectModal";
import { AgentAvatarView } from "./AgentAvatarView";
import { useCollabSession } from "./CollabSessionContext";
import { useSidebar } from "./SidebarContext";
import { Tooltip } from "./Tooltip";
import { useWorkspace } from "./WorkspaceProvider";
import { useActionItems } from "./useActionItems";
import { NewDirectMessageModal } from "./NewDirectMessageModal";

// The whole team-side sidebar is flat now: no project folders, no
// drill-down that hides every project but the one you clicked into. A
// team's shared projects, direct messages, and agents all sit in their own
// section, all visible all the time - the same "never hide siblings" fix
// the Personal sidebar already got, extended to Team/Collaborative.
//
// Styling deliberately mirrors ProjectSidebar's (the Personal side's) own
// conventions rather than inventing a second style: pinned nav rows use
// its `px-3 py-1.5 text-sm font-medium` + `w-4 h-4` icon formula, section
// headers reuse its "Projects" header markup, and list rows reuse its
// thread-row `text-xs` formula.
const NAV_ITEM =
  "flex items-center px-3 py-1.5 rounded-md text-sm font-medium transition-colors";
const NAV_ITEM_ACTIVE = "bg-surface-hover text-foreground";
const NAV_ITEM_INACTIVE =
  "hover:bg-surface-hover/50 text-muted hover:text-foreground-secondary";
const ROW_ITEM =
  "flex w-full items-center rounded-md px-4 py-1.5 text-left text-sm transition-colors";
const ROW_ITEM_ACTIVE = "bg-surface-hover text-foreground";
const ROW_ITEM_INACTIVE =
  "text-muted hover:bg-surface-hover/50 hover:text-foreground-secondary";

/** Shared live Team channel navigation, styled with the prototype sidebar rows. */
export function TeamChannelNavigation({
  teamName,
  channels,
  people = [],
  principalUserId,
  directMessages = [],
  selectedId,
  squareSelected = false,
  onOpenSquare,
  onSelect,
  onCreate,
  onNewDirectMessage
}: {
  teamName: string;
  channels: Array<{ id: string; name: string | null }>;
  people?: Array<{ id: string; name: string }>;
  principalUserId: string;
  directMessages?: Array<Extract<CollaborationThread, { kind: "dm" | "group_dm" }>>;
  selectedId: string;
  squareSelected?: boolean;
  onOpenSquare?: () => void;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onNewDirectMessage: (participantUserIds: string[]) => Promise<void>;
}) {
  const { isOpen, toggleSidebar, width } = useSidebar();
  const [newDmOpen, setNewDmOpen] = useState(false);
  if (!isOpen) return null;
  const openMobileDestination = (callback: () => void) => {
    callback();
    if (window.matchMedia("(max-width: 767px)").matches) toggleSidebar();
  };
  return (
    <aside
      id="team-navigation"
      role="navigation"
      aria-label="Team navigation"
      className="relative flex h-full max-w-[calc(100vw-72px)] shrink-0 flex-col border-r border-border bg-surface pt-6 md:max-w-none"
      style={{ width: `${width}px` }}
    >
      <div className="px-3 py-2">
        <div className="mb-1 flex items-center gap-2">
          <div className="min-w-0 flex-1 px-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-subtle">Team</p>
            <p className="truncate text-sm font-medium text-foreground">{teamName}</p>
          </div>
          <Tooltip content="Close Sidebar" side="bottom">
            <button type="button" onClick={toggleSidebar} aria-label="Close team navigation" className="rounded-md p-1.5 text-muted transition-colors hover:bg-surface-hover hover:text-foreground-secondary">
              <PanelLeftClose className="h-4 w-4" />
            </button>
          </Tooltip>
        </div>
      </div>
      <div className="flex flex-col gap-0.5 px-3 py-2">
        <button type="button" disabled title="Team activity is unavailable here yet." className={`${NAV_ITEM} w-full ${NAV_ITEM_INACTIVE} cursor-not-allowed opacity-60`}>
          <Bell className="mr-2 h-4 w-4" />For you
        </button>
        <button type="button" disabled={!onOpenSquare} aria-current={squareSelected ? "page" : undefined} onClick={onOpenSquare} title={!onOpenSquare ? "Public Square is unavailable here yet." : undefined} className={`${NAV_ITEM} w-full ${squareSelected ? NAV_ITEM_ACTIVE : NAV_ITEM_INACTIVE} ${!onOpenSquare ? "cursor-not-allowed opacity-60" : ""}`}>
          <Globe className="mr-2 h-4 w-4" />Public Square
        </button>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 pt-0.5 pb-2 space-y-0.5">
        {channels.map((channel) => (
          <button
            key={channel.id}
            type="button"
            aria-current={channel.id === selectedId ? "page" : undefined}
            onClick={() => openMobileDestination(() => onSelect(channel.id))}
            className={`${NAV_ITEM} w-full ${channel.id === selectedId ? NAV_ITEM_ACTIVE : NAV_ITEM_INACTIVE}`}
          >
            <Hash className="mr-2 h-4 w-4 flex-shrink-0" />
            <span className="min-w-0 flex-1 truncate text-left">{channel.name ?? "Shared Project"}</span>
          </button>
        ))}
        <button
          type="button"
          onClick={onCreate}
          className="flex w-full items-center rounded-md px-3 py-1.5 text-left text-subtle transition-colors hover:bg-surface-hover/30 hover:text-foreground-secondary"
        >
          <Plus className="mr-2.5 h-3.5 w-3.5" />
          <span className="text-xs">New channel</span>
        </button>
        <div className="mt-4 flex items-center justify-between px-4 py-1.5">
          <span className="flex items-center text-sm font-medium text-foreground-secondary"><Users className="mr-2 h-4 w-4 text-subtle" />Colleagues</span>
          <Tooltip content="New direct message" side="bottom"><button type="button" aria-label="New direct message" onClick={() => setNewDmOpen(true)} className="rounded-md p-1 text-subtle transition-colors hover:bg-surface-hover hover:text-foreground-secondary"><Plus className="h-3.5 w-3.5" /></button></Tooltip>
        </div>
        {directMessages.slice().sort((left, right) => Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt)).map((thread) => {
          const others = thread.participants.filter((person) => person.id !== principalUserId);
          const name = others.map((person) => person.displayName).join(", ") || "Direct message";
          const unread = thread.unreadCount > 0;
          return <button key={thread.id} type="button" aria-current={thread.id === selectedId ? "page" : undefined} aria-label={name} onClick={() => openMobileDestination(() => onSelect(thread.id))} className={`${ROW_ITEM} ${unread ? "font-semibold" : ""} ${thread.id === selectedId ? ROW_ITEM_ACTIVE : ROW_ITEM_INACTIVE}`}>
            <span className="mr-2 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-hover text-[10px] font-semibold text-muted">{thread.kind === "group_dm" ? <Users className="h-3.5 w-3.5" /> : name.slice(0, 1).toUpperCase()}</span>
            <span className="min-w-0 flex-1 truncate text-left">{name}</span>
            {unread && <span aria-label={`${thread.unreadCount} unread`} className="ml-2 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
          </button>;
        })}
      </nav>
      {newDmOpen && <NewDirectMessageModal members={people} principalUserId={principalUserId} onClose={() => setNewDmOpen(false)} onStart={onNewDirectMessage} />}
    </aside>
  );
}

export function TeamSidebar() {
  const { isOpen, toggleSidebar, width, isResizing, startResizing } =
    useSidebar();
  const { workspace, activeTeam, addProject, createChatChannel } =
    useWorkspace();
  const { view, openSquare, openChannel, openDm, openAgent, openInbox } =
    useCollabSession();
  const { teamsBadge } = useActionItems();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isPeopleExpanded, setIsPeopleExpanded] = useState(true);
  const [peopleAddOpen, setPeopleAddOpen] = useState(false);
  const [isNewDmOpen, setIsNewDmOpen] = useState(false);
  const [isCreateChannelOpen, setIsCreateChannelOpen] = useState(false);
  const [channelType, setChannelType] = useState<"chat" | "project" | null>(
    null
  );
  const [agentProjectPickerOpen, setAgentProjectPickerOpen] = useState(false);
  const [addAgentProjectId, setAddAgentProjectId] = useState<string | null>(
    null
  );
  const [channelName, setChannelName] = useState("");
  const newProjectId = useRef<string | null>(null);

  useEffect(() => {
    if (!newProjectId.current || !activeTeam) return;
    const channel = workspace.channels.find(
      (item) =>
        item.projectId === newProjectId.current && item.teamId === activeTeam.id
    );
    if (!channel) return;
    newProjectId.current = null;
    openChannel(channel.id);
    if (window.matchMedia("(max-width: 767px)").matches && isOpen)
      toggleSidebar();
  }, [activeTeam, workspace.channels, openChannel, isOpen, toggleSidebar]);

  if (!isOpen || !activeTeam) return null;

  const sharedProjects = projectsForTeam(workspace, activeTeam.id);
  const generalChannel = workspace.channels.find(
    (channel) => channel.teamId === activeTeam.id && channel.projectId === null
  );
  const projectChannels = workspace.channels.filter(
    (channel) => channel.teamId === activeTeam.id && channel.projectId !== null
  );
  // Most recently active conversation first, unread ones bolded - same
  // "is this unread" rule the For You notification uses, so the two never
  // disagree about what counts.
  const dms = workspace.dms
    .filter((dm) => dm.teamId === activeTeam.id)
    .slice()
    .sort(
      (left, right) =>
        (latestDmMessage(workspace.dmMessages, right.id)?.createdAt ?? 0) -
        (latestDmMessage(workspace.dmMessages, left.id)?.createdAt ?? 0)
    );
  const sharedProjectIds = new Set(sharedProjects.map((project) => project.id));
  const agents = resolveAgents(
    workspace.projectAgents,
    workspace.agentDefinitions
  ).filter((agent) => sharedProjectIds.has(agent.projectId));
  type PeopleEntry =
    | { kind: "dm"; sortAt: number; dm: (typeof dms)[number] }
    | { kind: "agent"; sortAt: number; agent: (typeof agents)[number] };
  const peopleEntries: PeopleEntry[] = [
    ...dms.map((dm) => ({
      kind: "dm" as const,
      sortAt: latestDmMessage(workspace.dmMessages, dm.id)?.createdAt ?? 0,
      dm
    })),
    ...agents.map((agent) => {
      const latestEvent = workspace.agentEvents
        .filter((event) => event.agentId === agent.id)
        .sort((left, right) => right.at - left.at)[0];
      return { kind: "agent" as const, sortAt: latestEvent?.at ?? 0, agent };
    })
  ].sort((left, right) => right.sortAt - left.sortAt);
  const addAgentProject = addAgentProjectId
    ? (sharedProjects.find((project) => project.id === addAgentProjectId) ??
      null)
    : null;

  const projectNameFor = (projectId: string) =>
    sharedProjects.find((project) => project.id === projectId)?.name ??
    "Unknown project";

  const openMobileDestination = (open: () => void) => {
    open();
    if (window.matchMedia("(max-width: 767px)").matches) toggleSidebar();
  };

  return (
    <>
      <div
        id="team-navigation"
        role="navigation"
        aria-label="Team navigation"
        className="relative flex h-screen max-w-[calc(100vw-72px)] flex-shrink-0 flex-col border-r border-border bg-surface pt-6 drag-region md:max-w-none"
        style={{ width: `${width}px` }}
      >
        <div className="px-3 py-2 no-drag">
          <div className="mb-1 flex items-center gap-2">
            <div className="min-w-0 flex-1 px-2">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-subtle">
                Team
              </p>
              <p className="truncate text-sm font-medium text-foreground">
                {activeTeam.name}
              </p>
            </div>
            <Tooltip content="Close Sidebar" side="bottom">
              <button
                type="button"
                onClick={toggleSidebar}
                aria-label="Close team navigation"
                className="rounded-md p-1.5 text-muted transition-colors hover:bg-surface-hover hover:text-foreground-secondary"
              >
                <PanelLeftClose className="h-4 w-4" />
              </button>
            </Tooltip>
          </div>
        </div>

        <div className="flex flex-col gap-0.5 px-3 py-2 no-drag">
          <button
            type="button"
            onClick={() => openMobileDestination(openInbox)}
            className={`${NAV_ITEM} ${view.type === "inbox" ? NAV_ITEM_ACTIVE : NAV_ITEM_INACTIVE}`}
          >
            <Bell className="mr-2 h-4 w-4" />
            For you
            {teamsBadge > 0 && (
              <span className="ml-auto rounded-full bg-chip px-1.5 text-[10px] font-medium text-chip-foreground">
                {teamsBadge}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => openMobileDestination(openSquare)}
            className={`${NAV_ITEM} ${view.type === "square" ? NAV_ITEM_ACTIVE : NAV_ITEM_INACTIVE}`}
          >
            <Globe className="mr-2 h-4 w-4" />
            Public Square
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-2 pt-0.5 pb-2 space-y-0.5 no-drag">
          {generalChannel && (
            <button
              type="button"
              onClick={() =>
                openMobileDestination(() => openChannel(generalChannel.id))
              }
              className={`${NAV_ITEM} w-full ${
                view.type === "channel" && view.id === generalChannel.id
                  ? NAV_ITEM_ACTIVE
                  : NAV_ITEM_INACTIVE
              }`}
            >
              <Hash className="mr-2 h-4 w-4 flex-shrink-0" />
              general
            </button>
          )}
          {projectChannels.map((channel) => {
            const project = sharedProjects.find(
              (item) => item.id === channel.projectId
            );
            return (
              <Tooltip
                key={channel.id}
                content={
                  project
                    ? `${channel.name} · ${project.gitStatus}`
                    : channel.name
                }
                side="right"
              >
                <button
                  type="button"
                  onClick={() =>
                    openMobileDestination(() => openChannel(channel.id))
                  }
                  className={`${NAV_ITEM} w-full ${
                    view.type === "channel" && view.id === channel.id
                      ? NAV_ITEM_ACTIVE
                      : NAV_ITEM_INACTIVE
                  }`}
                >
                  <Hash className="mr-2 h-4 w-4 flex-shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-left">
                    {channel.name}
                  </span>
                  {project && (
                    <FolderGit2 className="ml-2 h-3.5 w-3.5 flex-shrink-0 text-subtle" />
                  )}
                </button>
              </Tooltip>
            );
          })}
          <Tooltip content="Create a chat or project channel" side="right">
            <button
              type="button"
              className="flex w-full items-center rounded-md px-3 py-1.5 text-left text-subtle transition-colors hover:bg-surface-hover/30 hover:text-foreground-secondary"
              onClick={() => setIsCreateChannelOpen(true)}
            >
              <Plus className="mr-2.5 h-3.5 w-3.5" />
              <span className="text-xs">New channel</span>
            </button>
          </Tooltip>
          <div className="px-4 py-1.5 mt-4 flex items-center justify-between no-drag">
            <button
              type="button"
              aria-expanded={isPeopleExpanded}
              onClick={() => setIsPeopleExpanded((current) => !current)}
              className="flex items-center text-sm font-medium text-foreground-secondary transition-colors hover:text-foreground"
            >
              <Users className="mr-2 h-4 w-4 text-subtle" />
              <span>Colleagues</span>
              {isPeopleExpanded ? (
                <ChevronDown className="ml-1 h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="ml-1 h-3.5 w-3.5" />
              )}
            </button>
            <div className="relative">
              <Tooltip content="Message someone or add an agent" side="bottom">
                <button
                  type="button"
                  aria-label="Message someone or add an agent"
                  className="rounded-md p-1 text-subtle transition-colors hover:bg-surface-hover hover:text-foreground-secondary"
                  onClick={() => setPeopleAddOpen((current) => !current)}
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
              {peopleAddOpen && (
                <>
                  <button
                    type="button"
                    aria-label="Dismiss colleague actions"
                    className="fixed inset-0 z-40 cursor-default"
                    onClick={() => setPeopleAddOpen(false)}
                  />
                  <div className="absolute right-0 top-7 z-50 w-48 rounded-lg border border-border bg-surface p-1 shadow-xl">
                    <button
                      type="button"
                      className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs text-foreground-secondary hover:bg-surface-hover"
                      onClick={() => {
                        setPeopleAddOpen(false);
                        setIsNewDmOpen(true);
                      }}
                    >
                      <MessageSquare className="mr-2 h-3.5 w-3.5" />
                      Message someone
                    </button>
                    <button
                      type="button"
                      disabled={sharedProjects.length === 0}
                      className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs text-foreground-secondary hover:bg-surface-hover disabled:opacity-40"
                      onClick={() => {
                        setPeopleAddOpen(false);
                        if (sharedProjects.length === 1) {
                          setAddAgentProjectId(sharedProjects[0].id);
                        } else {
                          setAgentProjectPickerOpen(true);
                        }
                      }}
                    >
                      <Bot className="mr-2 h-3.5 w-3.5" />
                      Add an agent
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
          {isPeopleExpanded && (
            <>
              {agentProjectPickerOpen && (
                <div className="mb-1 rounded-md border border-border bg-background p-1">
                  {sharedProjects.map((project) => (
                    <button
                      key={project.id}
                      type="button"
                      className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs text-foreground-secondary hover:bg-surface-hover"
                      onClick={() => {
                        setAddAgentProjectId(project.id);
                        setAgentProjectPickerOpen(false);
                      }}
                    >
                      <FolderGit2 className="mr-2 h-3.5 w-3.5" />
                      {project.name}
                    </button>
                  ))}
                </div>
              )}
              {peopleEntries.length === 0 ? (
                <p className="px-2 py-1 text-sm text-subtle">
                  No one to talk to yet.
                </p>
              ) : (
                peopleEntries.map((entry) => {
                  if (entry.kind === "dm") {
                    const unreadDm = isDmUnread(
                      entry.dm,
                      workspace.dmMessages,
                      workspace.dmReadAt
                    );
                    return (
                      <button
                        key={`dm-${entry.dm.id}`}
                        type="button"
                        onClick={() =>
                          openMobileDestination(() => openDm(entry.dm.id))
                        }
                        className={`${ROW_ITEM} ${unreadDm ? "font-semibold" : ""} ${
                          view.type === "dm" && view.id === entry.dm.id
                            ? ROW_ITEM_ACTIVE
                            : ROW_ITEM_INACTIVE
                        }`}
                      >
                        <DmAvatar memberIds={entry.dm.memberIds} />
                        <DmName memberIds={entry.dm.memberIds} />
                        {unreadDm && (
                          <span className="ml-auto h-1.5 w-1.5 flex-shrink-0 rounded-full bg-accent" />
                        )}
                      </button>
                    );
                  }
                  const agent = entry.agent;
                  const owner =
                    activeTeam.members.find(
                      (member) => member.id === agent.ownerId
                    )?.name ?? "Unknown";
                  return (
                    <button
                      key={`agent-${agent.id}`}
                      type="button"
                      onClick={() =>
                        openMobileDestination(() => openAgent(agent.id))
                      }
                      className={`flex w-full items-start rounded-md px-4 py-1.5 text-left transition-colors ${
                        view.type === "agent" && view.id === agent.id
                          ? ROW_ITEM_ACTIVE
                          : ROW_ITEM_INACTIVE
                      }`}
                    >
                      <AgentAvatarView
                        image={agent.avatar?.image}
                        name={agent.name}
                        size="sm"
                        className="mt-0.5 mr-2"
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">
                          {agent.name}
                        </span>
                        <span className="block truncate text-[11px] text-subtle">
                          {projectNameFor(agent.projectId)} · {owner} ·{" "}
                          {statusLabel(agent.status)}
                        </span>
                      </span>
                    </button>
                  );
                })
              )}
            </>
          )}

        </div>

        <div
          className={`absolute top-0 right-0 z-50 h-full w-1 cursor-col-resize transition-colors hover:bg-surface-active ${isResizing ? "bg-surface-active" : ""}`}
          onMouseDown={startResizing}
        />
      </div>
      {isCreateOpen && (
        <CreateProjectModal
          teams={workspace.teams}
          forceTeamId={activeTeam.id}
          previewMode
          onClose={() => setIsCreateOpen(false)}
          onCreate={(created) => {
            const project = addProject({
              name: created.name,
              path: created.path,
              branch: created.branch,
              githubRepo: created.githubRepo,
              sharedWith: created.sharedWith
            });
            setIsCreateOpen(false);
            newProjectId.current = project.id;
          }}
        />
      )}
      {addAgentProject && (
        <AddAgentModal
          projectId={addAgentProject.id}
          projectName={addAgentProject.name}
          onClose={() => setAddAgentProjectId(null)}
          onAdded={(agentId) => {
            setAddAgentProjectId(null);
            openMobileDestination(() => openAgent(agentId));
          }}
        />
      )}
      {isNewDmOpen && (
        <NewDirectMessageDialog
          teamId={activeTeam.id}
          members={activeTeam.members}
          onClose={() => setIsNewDmOpen(false)}
          onOpened={() => {
            setIsNewDmOpen(false);
            if (window.matchMedia("(max-width: 767px)").matches) {
              toggleSidebar();
            }
          }}
        />
      )}
      {isCreateChannelOpen && (
        <CreateChannelDialog
          teamName={activeTeam.name}
          existingNames={workspace.channels
            .filter((channel) => channel.teamId === activeTeam.id)
            .map((channel) => channel.name.toLowerCase())}
          name={channelName}
          onNameChange={setChannelName}
          channelType={channelType}
          onChannelTypeChange={setChannelType}
          onClose={() => {
            setIsCreateChannelOpen(false);
            setChannelType(null);
            setChannelName("");
          }}
          onChooseProject={() => {
            setIsCreateChannelOpen(false);
            setChannelType(null);
            setChannelName("");
            setIsCreateOpen(true);
          }}
          onCreateChat={(name) => {
            try {
              const channel = createChatChannel(activeTeam.id, name);
              setIsCreateChannelOpen(false);
              setChannelType(null);
              setChannelName("");
              openMobileDestination(() => openChannel(channel.id));
            } catch (error) {
              window.alert(
                error instanceof Error
                  ? error.message
                  : "Could not create channel"
              );
            }
          }}
        />
      )}
    </>
  );
}

function NewDirectMessageDialog({
  teamId,
  members,
  onClose,
  onOpened
}: {
  teamId: string;
  members: { id: string; name: string }[];
  onClose: () => void;
  onOpened: () => void;
}) {
  const { openDm: createDm } = useWorkspace();
  const { openDm: openDmView } = useCollabSession();
  const [query, setQuery] = useState("");
  const others = members.filter((member) => member.id !== CURRENT_USER_ID);
  const trimmedQuery = query.trim().toLowerCase();
  const filtered = trimmedQuery
    ? others.filter((member) =>
        member.name.toLowerCase().includes(trimmedQuery)
      )
    : others;
  const start = (memberIds: string[]) => {
    const dm = createDm(teamId, memberIds);
    openDmView(dm.id);
    onOpened();
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm no-drag"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-team-dm-title"
        className="flex max-h-[calc(100vh-2rem)] w-[360px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4">
          <h2
            id="new-team-dm-title"
            className="text-base font-semibold text-foreground"
          >
            New direct message
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-subtle transition-colors hover:bg-surface-hover hover:text-foreground-secondary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {others.length > 0 && (
          <div className="flex items-center gap-2 border-b border-border px-5 py-2.5">
            <Search className="h-3.5 w-3.5 flex-shrink-0 text-subtle" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search teammates"
              aria-label="Search teammates"
              className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-subtle"
            />
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {others.length === 0 ? (
            <p className="px-2 py-3 text-sm text-subtle">
              No other teammates on this team yet.
            </p>
          ) : filtered.length === 0 ? (
            <p className="px-2 py-3 text-sm text-subtle">
              No teammates match your search.
            </p>
          ) : (
            <div className="space-y-0.5">
              {filtered.map((member) => (
                <button
                  key={member.id}
                  type="button"
                  className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-surface-hover"
                  onClick={() => start([member.id])}
                >
                  <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-border bg-surface-hover text-[11px] font-medium text-foreground-secondary">
                    {member.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="truncate text-sm text-foreground-secondary">
                    {member.name}
                  </span>
                </button>
              ))}
              {!trimmedQuery && others.length > 1 && (
                <button
                  type="button"
                  className="mt-1 flex w-full items-center gap-2.5 rounded-lg border-t border-border px-3 pt-3 pb-2 text-left transition-colors hover:bg-surface-hover"
                  onClick={() => start(others.map((member) => member.id))}
                >
                  <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-border bg-surface-hover text-subtle">
                    <Users className="h-3.5 w-3.5" />
                  </span>
                  <span className="truncate text-sm text-foreground-secondary">
                    {others.map((member) => member.name).join(", ")}
                  </span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CreateChannelDialog({
  teamName,
  existingNames,
  name,
  onNameChange,
  channelType,
  onChannelTypeChange,
  onClose,
  onCreateChat,
  onChooseProject
}: {
  teamName: string;
  existingNames: string[];
  name: string;
  onNameChange: (name: string) => void;
  channelType: "chat" | "project" | null;
  onChannelTypeChange: (type: "chat" | "project" | null) => void;
  onClose: () => void;
  onCreateChat: (name: string) => void;
  onChooseProject: () => void;
}) {
  const slug = slugifyChannelName(name);
  const duplicate = slug.length > 0 && existingNames.includes(slug);
  const canCreate = slug.length > 0 && !duplicate;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm no-drag"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-team-channel-title"
        className="w-[480px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4">
          <h2
            id="new-team-channel-title"
            className="text-base font-semibold text-foreground"
          >
            New channel
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-subtle transition-colors hover:bg-surface-hover hover:text-foreground-secondary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 pb-5">
          <p className="mb-3 text-sm text-muted">What kind of channel?</p>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              aria-pressed={channelType === "chat"}
              onClick={() => onChannelTypeChange("chat")}
              className={`rounded-lg border p-4 text-left transition-colors ${channelType === "chat" ? "border-accent bg-accent/10" : "border-border bg-background/30 hover:border-border-strong"}`}
            >
              <Hash className="mb-5 h-4 w-4 text-subtle" />
              <p className="text-sm font-medium text-foreground">
                Chat channel
              </p>
              <p className="mt-1 text-xs leading-relaxed text-subtle">
                Open discussion for {teamName}, not tied to a project.
              </p>
            </button>
            <button
              type="button"
              aria-pressed={channelType === "project"}
              onClick={onChooseProject}
              className="rounded-lg border border-border bg-background/30 p-4 text-left transition-colors hover:border-border-strong"
            >
              <FolderGit2 className="mb-5 h-4 w-4 text-subtle" />
              <p className="text-sm font-medium text-foreground">
                Project channel
              </p>
              <p className="mt-1 text-xs leading-relaxed text-subtle">
                Create a project shared with this team and its channel.
              </p>
            </button>
          </div>
          {channelType === "chat" && (
            <label className="mt-5 block">
              <span className="mb-2 block text-sm text-muted">
                Channel name
              </span>
              <div className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 focus-within:border-border-strong">
                <Hash className="h-4 w-4 flex-shrink-0 text-subtle" />
                <input
                  autoFocus
                  value={name}
                  onChange={(event) => onNameChange(event.target.value)}
                  placeholder="announcements"
                  className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-faint"
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && canCreate) onCreateChat(slug);
                  }}
                />
              </div>
              {slug.length > 0 && (
                <p className="mt-1.5 text-xs text-subtle">
                  {duplicate
                    ? `#${slug} already exists in ${teamName}.`
                    : `Will be created as #${slug}.`}
                </p>
              )}
            </label>
          )}
        </div>
        {channelType === "chat" && (
          <div className="flex justify-end border-t border-border bg-background/40 px-5 py-3">
            <button
              type="button"
              disabled={!canCreate}
              onClick={() => onCreateChat(slug)}
              className="rounded-lg bg-chip px-4 py-2 text-sm font-medium text-chip-foreground transition-colors hover:bg-chip-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              Create channel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function DmName({ memberIds }: { memberIds: string[] }) {
  const { activeTeam } = useWorkspace();
  const names = memberIds
    .filter((id) => id !== CURRENT_USER_ID)
    .map(
      (id) =>
        activeTeam?.members.find((member) => member.id === id)?.name ??
        "Unknown"
    );
  return <span className="truncate">{names.join(", ")}</span>;
}

function DmAvatar({ memberIds }: { memberIds: string[] }) {
  const { activeTeam } = useWorkspace();
  const firstOtherId = memberIds.find((id) => id !== CURRENT_USER_ID);
  const name = firstOtherId
    ? (activeTeam?.members.find((member) => member.id === firstOtherId)?.name ??
      "?")
    : "?";
  return (
    <span className="mr-2 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border border-border bg-surface-hover text-[10px] font-medium text-foreground-secondary">
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
