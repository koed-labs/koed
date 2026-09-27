"use client";

import {
  ChevronDown,
  ChevronRight,
  Hash,
  MessageSquare,
  Pencil,
  Search,
  SmilePlus,
  Sparkles,
  Users,
  X
} from "lucide-react";
import { SiGithub } from "react-icons/si";
import { useEffect, useRef, useState } from "react";
import {
  CURRENT_USER_ID,
  channelAuthorKind,
  channelAuthorName,
  channelMessageKind,
  pickOrchestrator,
  relativeTime,
  QUICK_REACTIONS,
  threadParticipantIds,
  threadReplies,
  type ChannelJobThread,
  type ChannelMessage,
  type ResolvedAgent
} from "@/lib/collab";
import { contextForChannel, joinNames } from "@/lib/channelCollab";
import { renderMarkdown } from "@/lib/markdown";
import { ChatComposer } from "./ChatComposer";
import { useCollabSession } from "./CollabSessionContext";
import { AgentAvatarView } from "./AgentAvatarView";
import { TeamShell } from "./TeamShell";
import { Tooltip } from "./Tooltip";
import { useWorkspace } from "./WorkspaceProvider";

const PRIMARY_ACTION =
  "rounded-md bg-chip px-3.5 py-2 text-xs font-medium text-chip-foreground hover:bg-white";
const SECONDARY_ACTION =
  "rounded-md bg-surface-hover px-3.5 py-2 text-xs font-medium text-foreground-secondary hover:bg-surface-active hover:text-foreground";

const GROUP_GAP_MS = 5 * 60 * 1000;

type FeedEntry =
  | { type: "solo"; message: ChannelMessage }
  | { type: "chat"; messages: ChannelMessage[] };

function buildFeed(messages: ChannelMessage[]): FeedEntry[] {
  const entries: FeedEntry[] = [];
  for (const message of messages) {
    if (channelMessageKind(message) !== "chat") {
      entries.push({ type: "solo", message });
      continue;
    }
    const last = entries[entries.length - 1];
    const lastMessage = last?.type === "chat" ? last.messages.at(-1) : null;
    if (
      last?.type === "chat" &&
      lastMessage?.authorId === message.authorId &&
      lastMessage.visibility === message.visibility &&
      message.createdAt - lastMessage.createdAt < GROUP_GAP_MS
    ) {
      last.messages.push(message);
    } else {
      entries.push({ type: "chat", messages: [message] });
    }
  }
  return entries;
}

function ChannelHeader({
  channelName,
  project,
  agents,
  members
}: {
  channelName: string;
  project: { path: string; branch: string; githubRepo?: string } | null;
  agents: ResolvedAgent[];
  members: { id: string; name: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
  const search = query.trim().toLowerCase();
  const visibleMembers = members.filter(
    (item) => !search || item.name.toLowerCase().includes(search)
  );
  const visibleAgents = agents.filter(
    (item) =>
      !search || `${item.name} ${item.role}`.toLowerCase().includes(search)
  );
  return (
    <div className="relative flex h-11 flex-shrink-0 items-center justify-between gap-3 border-b border-border px-4">
      <div aria-hidden="true" className="absolute inset-0 bg-background/80 backdrop-blur-sm" />
      <div className="relative flex min-w-0 items-center gap-1.5">
        <Hash className="h-4 w-4 flex-shrink-0 text-subtle" />
        <span className="truncate text-sm font-semibold text-foreground">{channelName}</span>
        {project && (
          <Tooltip content={`${project.path} · ${project.branch}${project.githubRepo ? " · GitHub connected" : " · local preview"}`} side="bottom">
            <span className="ml-1 flex min-w-0 flex-shrink items-center gap-1 rounded-md px-1.5 py-1 text-subtle hover:bg-surface-hover hover:text-foreground-secondary">
              <SiGithub className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="truncate text-xs">{project.githubRepo ?? project.path}</span>
            </span>
          </Tooltip>
        )}
      </div>
      <div ref={panelRef} className="relative flex-shrink-0">
        <button
          type="button"
          onClick={() => {
            if (open) setQuery("");
            setOpen((value) => !value);
          }}
          aria-expanded={open}
          aria-label={`${members.length + agents.length} participants`}
          className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors ${open ? "bg-surface-hover text-foreground" : "text-muted hover:bg-surface-hover hover:text-foreground-secondary"}`}
        >
          <Users className="h-4 w-4" />
          {members.length + agents.length}
        </button>
        {open && (
          <div className="absolute right-0 top-full z-30 mt-2 w-64 rounded-lg border border-border-strong bg-surface p-2 shadow-xl shadow-black/50">
            <label className="mb-2 flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5">
              <Search className="h-3.5 w-3.5 text-subtle" />
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search people and agents"
                className="w-full bg-transparent text-xs text-foreground outline-none placeholder:text-subtle"
              />
            </label>
            <ParticipantSection label="People" count={visibleMembers.length}>
              {visibleMembers.length ? (
                visibleMembers.map((member) => (
                  <ParticipantRow
                    key={member.id}
                    name={member.name}
                    detail={member.id === CURRENT_USER_ID ? "You" : undefined}
                    kind="human"
                    status="Presence not connected"
                  />
                ))
              ) : (
                <p className="px-2 py-1 text-[11px] text-subtle">
                  No people match.
                </p>
              )}
            </ParticipantSection>
            <ParticipantSection label="Agents" count={visibleAgents.length}>
              {visibleAgents.length ? (
                visibleAgents.map((agent) => (
                  <ParticipantRow
                    key={agent.id}
                    name={agent.name}
                    detail={agent.role}
                    image={agent.avatar?.image}
                    kind="agent"
                    status={`Preview · ${agent.status}`}
                  />
                ))
              ) : (
                <p className="px-2 py-1 text-[11px] text-subtle">
                  No agents match.
                </p>
              )}
            </ParticipantSection>
          </div>
        )}
      </div>
    </div>
  );
}

function ParticipantSection({
  label,
  count,
  children
}: {
  label: string;
  count: number;
  children: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <section className="py-1">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center justify-between px-2 pb-1 text-left text-[10px] font-semibold uppercase tracking-wider text-subtle"
      >
        {label} · {count}
        {expanded ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
      </button>
      {expanded && <div className="space-y-0.5">{children}</div>}
    </section>
  );
}

function ParticipantRow({
  name,
  detail,
  image,
  kind,
  status
}: {
  name: string;
  detail?: string;
  image?: string;
  kind: "human" | "agent";
  status: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5">
      <Avatar name={name} kind={kind} image={image} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-foreground">
          {name}
        </span>
        {detail && (
          <span className="block truncate text-[11px] text-subtle">
            {detail}
          </span>
        )}
      </span>
      <span className="max-w-24 text-right text-[10px] leading-tight text-subtle">
        {status}
      </span>
    </div>
  );
}

function ChatGroup({
  messages,
  allMessages,
  members,
  agents,
  hasOwnAgent,
  editingId,
  editValue,
  onEditValue,
  onStartEdit,
  onSaveEdit,
  onMemoryCheck,
  nameForId,
  onOpenMessageThread,
  onToggleReaction
}: {
  messages: ChannelMessage[];
  allMessages: ChannelMessage[];
  members: { id: string; name: string }[];
  agents: ResolvedAgent[];
  hasOwnAgent: boolean;
  editingId: string | null;
  editValue: string;
  onEditValue: (value: string) => void;
  onStartEdit: (message: ChannelMessage) => void;
  onSaveEdit: () => void;
  onMemoryCheck: (id: string) => void;
  nameForId: (id: string) => string;
  onOpenMessageThread: (id: string) => void;
  onToggleReaction: (id: string, emoji: string) => void;
}) {
  const first = messages[0];
  const kind = channelAuthorKind(first);
  const author = channelAuthorName(first, members, agents);
  const agent = agents.find(
    (item) => item.id === (first.agentId ?? first.authorId)
  );
  const isYou = first.authorId === CURRENT_USER_ID && kind === "human";
  const isPrivate = first.visibility === "private";
  return (
    <div
      className={`-mx-3 flex gap-3 rounded-md px-3 py-2 ${isPrivate ? "border border-dashed border-warning/40 bg-warning/5" : ""}`}
    >
      <Avatar
        name={author}
        kind={kind === "agent" ? "agent" : "human"}
        image={agent?.avatar?.image}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <p className="text-sm font-medium text-foreground">
            {isYou ? "You" : author}
          </p>
          {agent && (
            <span className="rounded bg-surface-hover px-1.5 py-0.5 text-[10px] text-muted">
              {agent.role}
            </span>
          )}
          {isPrivate && (
            <span className="text-[10px] font-medium text-warning">
              Only visible to you in this browser · asked{" "}
              {nameForId(first.recipientAgentId ?? "")}
            </span>
          )}
          <span className="text-[11px] text-faint">
            {relativeTime(first.createdAt)}
          </span>
        </div>
        <div className="mt-0.5 space-y-1">
          {messages.map((message) => (
            <ChatMessageRow
              key={message.id}
              message={message}
              isYou={isYou}
              hasOwnAgent={hasOwnAgent}
              editingId={editingId}
              editValue={editValue}
              onEditValue={onEditValue}
              onStartEdit={onStartEdit}
              onSaveEdit={onSaveEdit}
              onMemoryCheck={onMemoryCheck}
              replies={threadReplies(allMessages, message.id)}
              nameForId={nameForId}
              onOpenThread={onOpenMessageThread}
              onToggleReaction={(emoji) => onToggleReaction(message.id, emoji)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function ChatMessageRow({
  message,
  isYou,
  hasOwnAgent,
  editingId,
  editValue,
  onEditValue,
  onStartEdit,
  onSaveEdit,
  onMemoryCheck,
  replies,
  nameForId,
  onOpenThread,
  onToggleReaction
}: {
  message: ChannelMessage;
  isYou: boolean;
  hasOwnAgent: boolean;
  editingId: string | null;
  editValue: string;
  onEditValue: (value: string) => void;
  onStartEdit: (message: ChannelMessage) => void;
  onSaveEdit: () => void;
  onMemoryCheck: (id: string) => void;
  replies: ChannelMessage[];
  nameForId: (id: string) => string;
  onOpenThread: (id: string) => void;
  onToggleReaction: (emoji: string) => void;
}) {
  const participantIds = replies.length
    ? threadParticipantIds(message, replies)
    : [];
  return (
    <div className="group/msg relative -mx-2 rounded-md px-2 py-0.5 hover:bg-surface-hover/50">
      {editingId === message.id ? (
        <div className="space-y-2 py-1">
          <textarea
            value={editValue}
            onChange={(event) => onEditValue(event.target.value)}
            className="w-full resize-none bg-transparent text-[15px] text-foreground-secondary outline-none"
            rows={3}
          />
          <button
            type="button"
            className="text-[11px] text-foreground-secondary hover:text-foreground"
            onClick={onSaveEdit}
          >
            Save to the channel
          </button>
        </div>
      ) : (
        <div className="text-[15px] leading-relaxed text-foreground-secondary">
          {renderMarkdown(message.content)}
          {message.editedAt && (
            <span className="ml-1.5 text-[11px] text-faint">(edited)</span>
          )}
        </div>
      )}
      {message.reactions?.length ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {message.reactions.map((reaction) => (
            <button
              key={reaction.emoji}
              type="button"
              onClick={() => onToggleReaction(reaction.emoji)}
              className={`flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] ${reaction.authorIds.includes(CURRENT_USER_ID) ? "border-accent/50 bg-accent/10 text-accent" : "border-border bg-surface-hover/60 text-foreground-secondary hover:bg-surface-hover"}`}
            >
              <span>{reaction.emoji}</span>
              <span>{reaction.authorIds.length}</span>
            </button>
          ))}
        </div>
      ) : null}
      {editingId !== message.id && (
        <div className="absolute -top-3 right-2 z-10 flex items-center gap-0.5 rounded-lg border border-border bg-surface p-0.5 opacity-0 shadow-lg transition-opacity group-hover/msg:opacity-100 group-focus-within/msg:opacity-100 [@media(hover:none)]:opacity-100">
          <div className="group/react relative">
            <button
              type="button"
              title="Add reaction"
              aria-label="Add reaction"
              className="rounded-md p-1.5 text-subtle hover:bg-surface-hover hover:text-foreground"
            >
              <SmilePlus className="h-3.5 w-3.5" />
            </button>
            <div className="absolute right-0 top-full z-20 hidden gap-0.5 rounded-lg border border-border-strong bg-surface p-1 shadow-xl group-hover/react:flex">
              {QUICK_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  aria-label={`React ${emoji}`}
                  onClick={() => onToggleReaction(emoji)}
                  className="rounded-md p-1 text-base leading-none hover:bg-surface-hover"
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
          <button
            type="button"
            title="Reply in thread"
            aria-label="Reply in thread"
            onClick={() => onOpenThread(message.id)}
            className="rounded-md p-1.5 text-subtle hover:bg-surface-hover hover:text-foreground"
          >
            <MessageSquare className="h-3.5 w-3.5" />
          </button>
          {isYou && hasOwnAgent && (
            <button
              type="button"
              title="Check with my agent"
              aria-label="Check with my agent"
              onClick={() => onMemoryCheck(message.id)}
              className="rounded-md p-1.5 text-subtle hover:bg-surface-hover hover:text-foreground"
            >
              <Sparkles className="h-3.5 w-3.5" />
            </button>
          )}
          {isYou && (
            <button
              type="button"
              title="Edit"
              aria-label="Edit"
              onClick={() => onStartEdit(message)}
              className="rounded-md p-1.5 text-subtle hover:bg-surface-hover hover:text-foreground"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}
      {replies.length > 0 && (
        <button
          type="button"
          onClick={() => onOpenThread(message.id)}
          className="mt-1 flex items-center gap-2 rounded py-1 text-xs font-medium text-accent hover:underline"
        >
          <span className="flex -space-x-1">
            {participantIds.slice(0, 3).map((id) => (
              <span
                key={id}
                className="flex h-5 w-5 items-center justify-center rounded-full border border-background bg-surface text-[9px] text-foreground-secondary"
              >
                {nameForId(id).slice(0, 1)}
              </span>
            ))}
          </span>
          <span>
            {replies.length} {replies.length === 1 ? "reply" : "replies"}
            {replies.length > 0
              ? ` · ${nameForId(replies[replies.length - 1].authorId)} ${relativeTime(replies[replies.length - 1].createdAt)}`
              : ""}
          </span>
        </button>
      )}
    </div>
  );
}

type PanelState =
  | { kind: "job"; id: string }
  | { kind: "message"; id: string }
  | null;

export function ChannelView({
  channelId,
  focus
}: {
  channelId: string;
  focus?: { kind: "thread" | "job"; id: string };
}) {
  const {
    workspace,
    activeTeam,
    postChannelMessage,
    postThreadReply,
    postPrivateAgentAsk,
    toggleChannelReaction,
    acceptChannelInvite,
    declineChannelInvite,
    requestMemoryCheck,
    editChannelMessage,
    setJobThreadNote
  } = useWorkspace();
  const { openInbox } = useCollabSession();
  const [draft, setDraft] = useState("");
  const [privacy, setPrivacy] = useState<"public" | "private">("public");
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [panel, setPanel] = useState<PanelState>(() =>
    focus
      ? { kind: focus.kind === "job" ? "job" : "message", id: focus.id }
      : null
  );
  const channel = workspace.channels.find((item) => item.id === channelId);
  if (!channel || !activeTeam) return null;

  // A project channel's "context name" is that project's name; the
  // team-wide #general channel (no project) uses the team's own name -
  // both the display crumb and the name agents refer to when they talk
  // about "this project"/"this workshop" in their replies.
  const context = contextForChannel(workspace, channel);
  const contextName = context?.name ?? activeTeam.name;
  const project = channel.projectId
    ? (workspace.projects.find((item) => item.id === channel.projectId) ?? null)
    : null;
  const channelMessages = workspace.channelMessages
    .filter((message) => message.channelId === channelId)
    .sort((left, right) => left.createdAt - right.createdAt);
  const messages = channelMessages.filter((message) => !message.threadRootId);
  const agents = context?.agents ?? [];
  const orchestrator = pickOrchestrator(agents);
  const hasOwnAgent = Boolean(orchestrator);
  const jobThreads = workspace.channelJobThreads.filter(
    (thread) => thread.channelId === channelId
  );
  const nameForId = (id: string) =>
    agents.find((item) => item.id === id)?.name ??
    activeTeam.members.find((item) => item.id === id)?.name ??
    "Unknown";
  const openJobThread =
    panel?.kind === "job"
      ? (jobThreads.find((thread) => thread.id === panel.id) ?? null)
      : null;
  const openJobAgent = openJobThread
    ? (agents.find((agent) => agent.id === openJobThread.agentId) ?? null)
    : null;
  const openMessage =
    panel?.kind === "message"
      ? (channelMessages.find(
          (message) => message.id === panel.id && !message.threadRootId
        ) ?? null)
      : null;
  const messageReplies = openMessage
    ? threadReplies(channelMessages, openMessage.id)
    : [];
  const composerAgents = agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    role: agent.role,
    avatar: agent.avatar,
    lifecycle: "active" as const,
    defaultProvider: null,
    defaultModel: null,
    defaultReasoningEffort: null
  }));
  const updateComposerDraft = (nextDraft: string) => {
    setDraft(nextDraft);
    const selectedAgent = composerAgents.find(
      (agent) => agent.id === activeAgentId
    );
    if (
      selectedAgent &&
      !nextDraft
        .toLocaleLowerCase()
        .includes(`@${selectedAgent.name.replace(/\s+/g, "_")}`.toLocaleLowerCase())
    ) {
      setActiveAgentId(null);
    }
  };

  return (
    <TeamShell
      wallpaper
      subheader={
        <ChannelHeader
          channelName={channel.name}
          project={project}
          agents={agents}
          members={activeTeam.members}
        />
      }
      aside={
        openMessage ? (
          <MessageThreadPanel
            key={openMessage.id}
            root={openMessage}
            replies={messageReplies}
            members={activeTeam.members}
            agents={agents}
            onSend={(text) => postThreadReply(channelId, openMessage.id, text)}
            onClose={() => setPanel(null)}
          />
        ) : openJobThread && openJobAgent ? (
          <ThreadPanel
            key={openJobThread.id}
            thread={openJobThread}
            agent={openJobAgent}
            orchestratorName={orchestrator?.name ?? "orchestrator"}
            agents={agents}
            onClose={() => setPanel(null)}
            onSaveNote={(note) => setJobThreadNote(openJobThread.id, note)}
          />
        ) : null
      }
      footer={
        <div className="border-t border-border bg-background p-4">
          <div className="mx-auto max-w-2xl no-drag">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div
                className="inline-flex rounded-md border border-border bg-surface p-0.5"
                role="group"
                aria-label="Message visibility"
              >
                <button
                  type="button"
                  aria-pressed={privacy === "public"}
                  onClick={() => setPrivacy("public")}
                  className={`rounded px-2.5 py-1 text-xs ${privacy === "public" ? "bg-surface-hover text-foreground" : "text-subtle hover:text-foreground-secondary"}`}
                >
                  Channel
                </button>
                <button
                  type="button"
                  aria-pressed={privacy === "private"}
                  onClick={() => setPrivacy("private")}
                  className={`rounded px-2.5 py-1 text-xs ${privacy === "private" ? "bg-surface-hover text-foreground" : "text-subtle hover:text-foreground-secondary"}`}
                >
                  Private ask
                </button>
              </div>
              <span className="text-[11px] text-subtle">
                Local browser preview · not synced to a Team backend
              </span>
            </div>
            <ChatComposer
              placeholder={
                privacy === "private"
                  ? "@ an agent to ask privately..."
                  : `Message #${channel.name}`
              }
              projectName={contextName}
              branch="shared"
              footer={
                privacy === "private"
                  ? "Saved privately in this browser only. No agent runtime or Team API is connected."
                  : "Local preview only. @mentions exercise the simulated specialist workflow; messages are not synced to a Team backend."
              }
              showExecutionControls={false}
              switchToExecutionControlsOnMention
              showMetaBar={false}
              showFormattingToolbar={activeAgentId === null}
              value={draft}
              onChange={updateComposerDraft}
              agents={composerAgents}
              activeAgentId={activeAgentId}
              sendEnabled={privacy === "public" || activeAgentId !== null}
              sendDisabledReason="Mention an agent to save a private ask in this local preview."
              onAgentMention={setActiveAgentId}
              onActiveAgentChange={setActiveAgentId}
              onSend={(text, selection) => {
                if (privacy === "private") {
                  if (!selection.agentId) return;
                  postPrivateAgentAsk(channelId, selection.agentId, text);
                } else {
                  postChannelMessage(channelId, text);
                }
                setDraft("");
                setActiveAgentId(null);
              }}
            />
          </div>
        </div>
      }
    >
      <div className="mx-auto max-w-2xl space-y-3 pt-4">
        {messages.length === 0 && (
          <p className="text-sm text-subtle">
            No messages yet. This is the channel for {contextName}.
            {hasOwnAgent
              ? ` ${orchestrator?.name} can join, then invite specialists if you want.`
              : " Create an agent you own to have an orchestrator join."}
          </p>
        )}
        {buildFeed(messages).map((entry) =>
          entry.type === "solo" ? (
            <ChannelLine
              key={entry.message.id}
              message={entry.message}
              members={activeTeam.members}
              agents={agents}
              jobThreads={jobThreads}
              hasOwnAgent={hasOwnAgent}
              editingId={editingId}
              editValue={editValue}
              onEditValue={setEditValue}
              onStartEdit={(item) => {
                setEditingId(item.id);
                setEditValue(item.content);
              }}
              onSaveEdit={() => {
                if (!editingId) return;
                editChannelMessage(editingId, editValue);
                setEditingId(null);
              }}
              onMemoryCheck={(id) => {
                requestMemoryCheck(id);
                openInbox();
              }}
              onAcceptInvite={() => acceptChannelInvite(entry.message.id)}
              onDeclineInvite={() => declineChannelInvite(entry.message.id)}
              onOpenThread={(id) => setPanel({ kind: "job", id })}
              allMessages={channelMessages}
              onOpenMessageThread={(id) => setPanel({ kind: "message", id })}
              onToggleReaction={toggleChannelReaction}
            />
          ) : (
            <ChatGroup
              key={entry.messages[0].id}
              messages={entry.messages}
              allMessages={channelMessages}
              members={activeTeam.members}
              agents={agents}
              hasOwnAgent={hasOwnAgent}
              editingId={editingId}
              editValue={editValue}
              onEditValue={setEditValue}
              onStartEdit={(item) => {
                setEditingId(item.id);
                setEditValue(item.content);
              }}
              onSaveEdit={() => {
                if (!editingId) return;
                editChannelMessage(editingId, editValue);
                setEditingId(null);
              }}
              onMemoryCheck={(messageId) => {
                requestMemoryCheck(messageId);
                openInbox();
              }}
              nameForId={nameForId}
              onOpenMessageThread={(id) => setPanel({ kind: "message", id })}
              onToggleReaction={toggleChannelReaction}
            />
          )
        )}
      </div>
    </TeamShell>
  );
}

function ChannelLine({
  message,
  members,
  agents,
  jobThreads,
  hasOwnAgent,
  editingId,
  editValue,
  onEditValue,
  onStartEdit,
  onSaveEdit,
  onMemoryCheck,
  onAcceptInvite,
  onDeclineInvite,
  onOpenThread,
  allMessages,
  onOpenMessageThread,
  onToggleReaction
}: {
  message: ChannelMessage;
  members: { id: string; name: string }[];
  agents: ResolvedAgent[];
  jobThreads: ChannelJobThread[];
  hasOwnAgent: boolean;
  editingId: string | null;
  editValue: string;
  onEditValue: (value: string) => void;
  onStartEdit: (message: ChannelMessage) => void;
  onSaveEdit: () => void;
  onMemoryCheck: (messageId: string) => void;
  onAcceptInvite: () => void;
  onDeclineInvite: () => void;
  onOpenThread: (threadId: string) => void;
  allMessages: ChannelMessage[];
  onOpenMessageThread: (messageId: string) => void;
  onToggleReaction: (messageId: string, emoji: string) => void;
}) {
  const kind = channelMessageKind(message);
  if (kind === "invite") {
    return (
      <InviteCard
        message={message}
        agents={agents}
        onAccept={onAcceptInvite}
        onDecline={onDeclineInvite}
      />
    );
  }
  if (kind === "system") {
    return (
      <p className="text-center text-[11px] text-subtle">{message.content}</p>
    );
  }
  if (kind === "suggestion" && message.suggestion) {
    return (
      <div className="rounded-xl border border-border bg-surface/80 p-4">
        <p className="text-[11px] font-medium uppercase tracking-wider text-subtle">
          {message.suggestion.title}
        </p>
        <ol className="mt-3 space-y-1.5 text-sm text-foreground-secondary">
          {message.suggestion.steps.map((step, index) => (
            <li key={step} className="flex gap-2">
              <span className="text-subtle">{index + 1}.</span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-sm text-muted">{message.suggestion.prompt}</p>
      </div>
    );
  }

  const authorKind = channelAuthorKind(message);
  const author = channelAuthorName(message, members, agents);
  const agent = agents.find(
    (item) => item.id === (message.agentId ?? message.authorId)
  );
  const isYou = message.authorId === CURRENT_USER_ID && authorKind === "human";
  const thread = message.jobThreadId
    ? jobThreads.find((item) => item.id === message.jobThreadId)
    : undefined;

  return (
    <div className="flex gap-3">
      <Avatar
        name={author}
        kind={authorKind === "agent" ? "agent" : "human"}
        image={agent?.avatar?.image}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <p className="text-sm font-medium text-foreground">
            {isYou ? "You" : author}
          </p>
          {agent && (
            <span className="rounded-full bg-surface-hover px-2 py-0.5 text-[10px] font-medium text-muted">
              {agent.role}
            </span>
          )}
          {message.editedAt && (
            <span className="text-[11px] text-faint">edited</span>
          )}
        </div>
        {editingId === message.id ? (
          <div className="mt-1 space-y-2">
            <textarea
              value={editValue}
              onChange={(event) => onEditValue(event.target.value)}
              className="w-full resize-none bg-transparent text-sm text-foreground-secondary outline-none"
              rows={3}
            />
            <button
              type="button"
              className="text-[11px] text-foreground-secondary hover:text-foreground"
              onClick={onSaveEdit}
            >
              Save to the channel
            </button>
          </div>
        ) : (
          <div className="mt-1 text-[15px] leading-relaxed text-foreground-secondary">
            {renderMarkdown(message.content)}
          </div>
        )}
        {message.reactions && message.reactions.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {message.reactions.map((reaction) => (
              <button
                key={reaction.emoji}
                type="button"
                onClick={() => onToggleReaction(message.id, reaction.emoji)}
                className={`rounded-full border px-2 py-0.5 text-xs ${reaction.authorIds.includes(CURRENT_USER_ID) ? "border-accent bg-accent/10" : "border-border bg-surface-hover"}`}
              >
                {reaction.emoji} {reaction.authorIds.length}
              </button>
            ))}
          </div>
        )}
        {kind === "chat" && !message.threadRootId && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-subtle">
            <details className="relative">
              <summary className="flex cursor-pointer list-none items-center gap-1 hover:text-foreground">
                <SmilePlus className="h-3.5 w-3.5" /> React
              </summary>
              <div className="absolute left-0 top-full z-10 mt-1 flex gap-1 rounded-md border border-border bg-surface p-1 shadow-lg">
                {QUICK_REACTIONS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    className="rounded p-1 text-base hover:bg-surface-hover"
                    onClick={(event) => {
                      onToggleReaction(message.id, emoji);
                      const details = event.currentTarget.closest("details");
                      if (details) details.open = false;
                    }}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </details>
            <button
              type="button"
              className="flex items-center gap-1 hover:text-foreground"
              onClick={() => onOpenMessageThread(message.id)}
            >
              <MessageSquare className="h-3.5 w-3.5" />{" "}
              {threadReplies(allMessages, message.id).length || "Reply"}
            </button>
          </div>
        )}
        {kind === "assignment" && thread && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-subtle">
            <span>{thread.messages.length} replies</span>
            <span>·</span>
            <span>{thread.status === "done" ? "Done" : "Working"}</span>
            <span>·</span>
            <button
              type="button"
              className="text-foreground-secondary hover:text-foreground"
              onClick={() => onOpenThread(thread.id)}
            >
              Open thread
            </button>
          </div>
        )}
        {isYou && !editingId && (
          <div className="mt-2 flex gap-3 text-[11px] text-subtle">
            {hasOwnAgent && (
              <button
                type="button"
                className="hover:text-foreground-secondary"
                onClick={() => onMemoryCheck(message.id)}
              >
                Check with my agent
              </button>
            )}
            <button
              type="button"
              className="hover:text-foreground-secondary"
              onClick={() => onStartEdit(message)}
            >
              Edit
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function MessageThreadPanel({
  root,
  replies,
  members,
  agents,
  onSend,
  onClose
}: {
  root: ChannelMessage;
  replies: ChannelMessage[];
  members: { id: string; name: string }[];
  agents: ResolvedAgent[];
  onSend: (text: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState("");
  const nameForId = (id: string) =>
    agents.find((agent) => agent.id === id)?.name ??
    members.find((member) => member.id === id)?.name ??
    "Unknown";
  const participants = threadParticipantIds(root, replies);
  return (
    <aside className="fixed right-0 top-14 bottom-44 z-20 flex w-[min(360px,92vw)] flex-shrink-0 flex-col border-l border-border bg-background md:relative md:inset-auto md:w-[360px]">
      <div className="flex items-start justify-between border-b border-border px-3 py-3">
        <div>
          <p className="text-sm font-medium text-foreground">Thread</p>
          <p className="mt-1 text-[11px] text-subtle">
            {participants.map(nameForId).join(", ")}
          </p>
          <p className="mt-1 text-[10px] text-faint">
            Local preview · replies are not synced to a Team backend
          </p>
        </div>
        <button
          type="button"
          className="rounded-md p-1 text-subtle hover:bg-surface-hover"
          onClick={onClose}
          aria-label="Close thread"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto p-3">
        {[root, ...replies].map((message) => (
          <div key={message.id} className="flex gap-2.5">
            <Avatar
              name={nameForId(message.authorId)}
              kind={channelAuthorKind(message) === "agent" ? "agent" : "human"}
              image={
                agents.find(
                  (agent) => agent.id === (message.agentId ?? message.authorId)
                )?.avatar?.image
              }
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-2">
                <p className="text-sm font-medium text-foreground">
                  {nameForId(message.authorId)}
                </p>
                <span className="text-[11px] text-faint">
                  {relativeTime(message.createdAt)}
                </span>
              </div>
              <div className="mt-1 text-[15px] leading-relaxed text-foreground-secondary">
                {renderMarkdown(message.content)}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="border-t border-border p-3">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Reply in thread"
          rows={2}
          className="w-full resize-none rounded-md border border-border bg-surface px-2 py-2 text-[15px] text-foreground outline-none"
        />
        <button
          type="button"
          disabled={!draft.trim()}
          onClick={() => {
            onSend(draft);
            setDraft("");
          }}
          className="mt-2 rounded-md bg-chip px-3 py-1.5 text-xs font-medium text-chip-foreground disabled:opacity-40"
        >
          Reply
        </button>
      </div>
    </aside>
  );
}

function InviteCard({
  message,
  agents,
  onAccept,
  onDecline
}: {
  message: ChannelMessage;
  agents: ResolvedAgent[];
  onAccept: () => void;
  onDecline: () => void;
}) {
  const candidates = (message.inviteCandidateIds ?? [])
    .map((id) => agents.find((agent) => agent.id === id))
    .filter((agent): agent is ResolvedAgent => Boolean(agent));
  const names = joinNames(candidates.map((agent) => agent.name));
  const orchestrator = pickOrchestrator(agents);
  const resolved = message.inviteResolved;

  return (
    <div className="rounded-xl border border-border bg-surface/80 p-4">
      <p className="text-sm text-foreground">Bring {names} in?</p>
      <p className="mt-1 text-xs text-subtle">
        They&apos;ll see this conversation and work in their own threads.
      </p>
      {resolved ? (
        <p className="mt-3 text-[11px] text-subtle">
          {resolved === "accepted"
            ? `${names} joined on this job.`
            : `Kept with ${orchestrator?.name ?? "you"}.`}
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className={PRIMARY_ACTION} onClick={onAccept}>
            Add them
          </button>
          <button
            type="button"
            className={SECONDARY_ACTION}
            onClick={onDecline}
          >
            Keep it with you, {orchestrator?.name ?? "you"}
          </button>
        </div>
      )}
    </div>
  );
}

function ThreadPanel({
  thread,
  agent,
  orchestratorName,
  agents,
  onClose,
  onSaveNote
}: {
  thread: ChannelJobThread;
  agent: ResolvedAgent;
  orchestratorName: string;
  agents: ResolvedAgent[];
  onClose: () => void;
  onSaveNote: (note: string) => void;
}) {
  const [note, setNote] = useState(thread.note ?? "");
  return (
    <aside className="fixed right-0 top-14 bottom-44 z-20 flex w-[min(360px,92vw)] flex-shrink-0 flex-col border-l border-border bg-background md:relative md:inset-auto md:w-[360px]">
      <div className="flex items-start justify-between gap-2 border-b border-border px-3 py-3">
        <div className="flex min-w-0 items-start gap-2">
          <AgentAvatarView
            image={agent.avatar?.image}
            spec={agent.avatar?.spec}
            name={agent.name}
            size="md"
          />
          <div className="min-w-0">
            <p className="truncate text-sm text-foreground">{agent.name}</p>
            <p className="text-[11px] text-subtle">
              {agent.role} · {thread.status === "done" ? "Done" : "Working"}
            </p>
          </div>
        </div>
        <button
          type="button"
          className="rounded-md p-1 text-subtle hover:bg-surface-hover hover:text-foreground"
          onClick={onClose}
          aria-label="Close thread"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        {thread.messages.map((item) => {
          const speaker = agents.find(
            (candidate) => candidate.id === item.agentId
          );
          const name =
            item.authorKind === "orchestrator"
              ? orchestratorName
              : (speaker?.name ?? agent.name);
          return (
            <div key={item.id}>
              <p className="text-[11px] font-medium text-muted">{name}</p>
              <div className="mt-1 text-[15px] leading-relaxed text-foreground-secondary">
                {renderMarkdown(item.content)}
              </div>
            </div>
          );
        })}
      </div>
      {thread.findingsShared && (
        <p className="border-t border-border px-3 py-2 text-[11px] text-subtle">
          Shared with {orchestratorName}
        </p>
      )}
      <div className="border-t border-border p-3">
        <label className="mb-1.5 block text-[11px] font-medium text-subtle">
          Private note · only you see this in the preview
        </label>
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Leave a note on this job..."
          className="w-full resize-none rounded-md border border-border bg-surface p-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-accent"
          rows={2}
        />
        <div className="mt-1.5 flex justify-end">
          <button
            type="button"
            className="rounded-md bg-surface-hover px-2.5 py-1 text-[11px] font-medium text-foreground-secondary hover:bg-surface-active"
            onClick={() => onSaveNote(note)}
          >
            Save note
          </button>
        </div>
      </div>
    </aside>
  );
}

function Avatar({
  name,
  kind,
  image
}: {
  name: string;
  kind: "human" | "agent";
  image?: string;
}) {
  if (kind === "agent") {
    return (
      <div className="mt-0.5 flex-shrink-0">
        <AgentAvatarView image={image} name={name} size="md" />
      </div>
    );
  }
  return (
    <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border border-border bg-surface text-[11px] font-medium text-foreground-secondary">
      {name.slice(0, 1).toUpperCase()}
    </div>
  );
}
