import {
  CURRENT_USER_ID,
  agentHandle,
  channelAuthorName,
  channelMessageKind,
  dmLabel,
  isDmUnread,
  latestDmMessage,
  pickOrchestrator,
  relativeTime,
  resolveAgents,
  type ResolvedAgent,
} from "./collab";
import { joinNames } from "./channelCollab";
import type { CollabLanding } from "./home";
import type { Project, Team, WorkspaceSnapshot } from "./workspace";

// ---------------------------------------------------------------------------
// One "something needs you" model for the whole app.
//
// Home (Personal) and For you (collaborative) both show action items, and
// they follow one rule: an item lives where it comes from. Anything tied to
// a project shared with a team is a team item and shows in For you (from
// every team you're on, tagged with which one). Everything else - personal
// projects, your Memory Inbox, your agents' setup - is a personal item and
// shows on Home. Each page only ever shows a count of the other side's.
//
// Every item answers the same four questions, so a card never has to be
// decoded: what is it (title), why is it yours (why), what exactly is it
// about (quote), and what's the one thing to do about it (primary).
// ---------------------------------------------------------------------------

export type ActionKind =
  | "agent-waiting"
  | "invite"
  | "pr-changes"
  | "pr-review"
  | "pr-reviewing"
  | "pr-approved"
  | "memory-check"
  | "replies"
  | "dm"
  | "findings"
  | "memory-failed"
  | "memory-ready"
  | "agent-idle";

// Why this is urgent, in plain words - also the order the groups render in.
//   blocking: work is stopped until you act (an agent, a merge, an invite)
//   waiting:  a person or agent asked you something and is waiting on a reply
//   fyi:      finished or new, worth a look, nobody is stuck on it
export type ActionTier = "blocking" | "waiting" | "fyi";

export const TIER_ORDER: ActionTier[] = ["blocking", "waiting", "fyi"];

export const TIER_LABEL: Record<ActionTier, string> = {
  blocking: "Blocking work",
  waiting: "Waiting on your reply",
  fyi: "Worth a look",
};

export type ActionSource =
  | { side: "personal"; label: string }
  | { side: "team"; teamId: string; teamName: string; label: string };

export type ActionTarget = { type: "collab"; landing: CollabLanding } | { type: "route"; href: string };

// What a button does. Kept as plain data (not callbacks) so items can be
// built by pure functions here and run by one hook in the UI.
export type ActionOp =
  | { op: "open"; target: ActionTarget }
  | { op: "accept-invite"; messageId: string }
  | { op: "decline-invite"; messageId: string }
  | { op: "retry-memory"; itemId: string }
  | { op: "correct-message"; messageId: string; channelId: string; teamId: string; whisperId: string }
  | { op: "confirm-memory-check"; whisperId: string }
  | { op: "unavailable"; reason: string };

export type ActionButton = { label: string } & ActionOp;

export type ActionActor =
  | { kind: "agent"; agentId: string }
  | { kind: "human"; name: string }
  | { kind: "system" };

export type ActionItem = {
  id: string;
  kind: ActionKind;
  tier: ActionTier;
  // When the thing this item is about last changed. Clearing an item hides
  // it until something newer than this happens.
  at: number;
  title: string;
  why: string;
  quote?: string;
  source: ActionSource;
  actor: ActionActor;
  primary: ActionButton;
  secondary?: ActionButton;
};

// --- helpers -----------------------------------------------------------------

function clip(text: string, max = 140) {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max).trim()}…`;
}

function isMember(team: Team) {
  return team.members.some((member) => member.id === CURRENT_USER_ID);
}

function teamProjects(workspace: WorkspaceSnapshot, teamId: string) {
  return workspace.projects.filter((project) => project.sharedWith.includes(teamId));
}

function personalProjects(workspace: WorkspaceSnapshot) {
  return workspace.projects.filter((project) => project.sharedWith.length === 0);
}

function memberName(workspace: WorkspaceSnapshot, id: string) {
  for (const team of workspace.teams) {
    const member = team.members.find((item) => item.id === id);
    if (member) return member.name;
  }
  return "Someone";
}

export function isVisible(item: ActionItem, cleared: Record<string, number>) {
  const clearedAt = cleared[item.id];
  return clearedAt === undefined || item.at > clearedAt;
}

export function sortItems(items: ActionItem[]) {
  return [...items].sort(
    (left, right) => TIER_ORDER.indexOf(left.tier) - TIER_ORDER.indexOf(right.tier) || right.at - left.at
  );
}

// Badges only count what someone is actually stuck on - "worth a look"
// items show on the page but never nag from the sidebar or the rail.
export function badgeCount(items: ActionItem[]) {
  return items.filter((item) => item.tier !== "fyi").length;
}

// --- shared builders (used by both sides) ----------------------------------

function agentWaitingItems(
  workspace: WorkspaceSnapshot,
  projects: Project[],
  source: (project: Project) => ActionSource,
  target: (agent: ResolvedAgent, project: Project) => ActionTarget
): ActionItem[] {
  const ids = new Set(projects.map((project) => project.id));
  return resolveAgents(workspace.projectAgents, workspace.agentDefinitions)
    .filter((agent) => agent.ownerId === CURRENT_USER_ID && agent.status === "waiting" && ids.has(agent.projectId))
    .map((agent) => {
      const project = projects.find((item) => item.id === agent.projectId)!;
      const whisper = workspace.whispers
        .filter((item) => item.agentId === agent.id && item.kind === "blocker")
        .sort((left, right) => right.createdAt - left.createdAt)[0];
      const lastEvent = workspace.agentEvents
        .filter((event) => event.agentId === agent.id)
        .sort((left, right) => right.at - left.at)[0];
      // When it started waiting: the ping or status change that put it
      // there, falling back to when it was unleashed.
      const at = Math.max(whisper?.createdAt ?? 0, lastEvent?.at ?? 0) || agent.createdAt;
      const focus = agent.focus.trim();
      return {
        id: `agent-waiting:${agent.id}`,
        kind: "agent-waiting" as const,
        tier: "blocking" as const,
        at,
        title: `${agent.name} is waiting on you`,
        why: `Your ${agent.role} agent paused on ${project.name} ${relativeTime(at)} and can't continue until you decide.`,
        quote: focus && focus !== "No active job" ? focus : undefined,
        source: source(project),
        actor: { kind: "agent" as const, agentId: agent.id },
        primary: { label: "Decide", op: "open" as const, target: target(agent, project) },
      };
    });
}

function pullRequestItems(
  workspace: WorkspaceSnapshot,
  projects: Project[],
  source: (project: Project) => ActionSource
): ActionItem[] {
  const ids = new Set(projects.map((project) => project.id));
  const items: ActionItem[] = [];
  const previewOnly: ActionButton = {
    label: "Preview only",
    op: "unavailable",
    reason: "Studio's Personal Pull Requests page is not connected to this browser-local team preview.",
  };
  for (const pr of workspace.pullRequests) {
    if (!ids.has(pr.projectId) || pr.status === "merged") continue;
    const project = projects.find((item) => item.id === pr.projectId)!;
    const mine = pr.authorId === CURRENT_USER_ID;
    const diff = `+${pr.added} −${pr.removed}`;
    if (mine && pr.reviewStatus === "changes-requested") {
      const feedback = pr.feedback[pr.feedback.length - 1];
      const reviewer = pr.reviewerId ? memberName(workspace, pr.reviewerId) : "A reviewer";
      items.push({
        id: `pr-changes:${pr.id}`,
        kind: "pr-changes",
        tier: "blocking",
        at: pr.updatedAt,
        title: `Changes requested on “${pr.title}”`,
        why: `${reviewer} reviewed your PR. It can't merge until you address the feedback.`,
        quote: feedback ? clip(feedback.body.replace(/^[^:]{1,30}:\s*/, "")) : undefined,
        source: source(project),
        actor: { kind: "human", name: reviewer },
        primary: previewOnly,
      });
    } else if (mine && pr.reviewStatus === "approved") {
      items.push({
        id: `pr-approved:${pr.id}`,
        kind: "pr-approved",
        tier: "fyi",
        at: pr.updatedAt,
        title: `“${pr.title}” was approved`,
        why: "It's ready to merge whenever you are.",
        source: source(project),
        actor: { kind: "human", name: pr.reviewerId ? memberName(workspace, pr.reviewerId) : "Reviewer" },
        primary: previewOnly,
      });
    } else if (!mine && pr.reviewStatus === "needs-reviewer") {
      items.push({
        id: `pr-review:${pr.id}`,
        kind: "pr-review",
        tier: "waiting",
        at: pr.updatedAt,
        title: `${pr.author} needs a reviewer`,
        why: `Nobody has picked up “${pr.title}” yet (${diff}, opened ${relativeTime(pr.updatedAt)}).`,
        source: source(project),
        actor: { kind: "human", name: pr.author },
        // The preview can show review work, but it has no review-claim
        // operation. Opening the existing Pull Requests page is truthful.
        primary: previewOnly,
      });
    } else if (!mine && pr.reviewerId === CURRENT_USER_ID && pr.reviewStatus === "in-review") {
      items.push({
        id: `pr-reviewing:${pr.id}`,
        kind: "pr-reviewing",
        tier: "waiting",
        at: pr.updatedAt,
        title: `Finish reviewing “${pr.title}”`,
        why: `You picked this up ${relativeTime(pr.updatedAt)}. ${pr.author} is waiting on your review.`,
        source: source(project),
        actor: { kind: "human", name: pr.author },
        primary: previewOnly,
      });
    }
  }
  return items;
}

// --- team (collaborative) items --------------------------------------------

export function teamActionItems(workspace: WorkspaceSnapshot, team: Team): ActionItem[] {
  const projects = teamProjects(workspace, team.id);
  const channels = workspace.channels.filter((channel) => channel.teamId === team.id);
  const channelIds = new Set(channels.map((channel) => channel.id));
  const channelById = new Map(channels.map((channel) => [channel.id, channel]));
  const agents = resolveAgents(workspace.projectAgents, workspace.agentDefinitions);
  const projectIds = new Set(projects.map((project) => project.id));
  const teamAgents = agents.filter((agent) => projectIds.has(agent.projectId));
  const src = (label: string): ActionSource => ({ side: "team", teamId: team.id, teamName: team.name, label });
  const landing = (view: CollabLanding["view"], viewId?: string, extra?: Partial<CollabLanding>): ActionTarget => ({
    type: "collab",
    landing: { teamId: team.id, projectId: null, view, viewId, ...extra },
  });

  const items: ActionItem[] = [];

  // Your agents blocked on a decision.
  items.push(
    ...agentWaitingItems(
      workspace,
      projects,
      (project) => src(project.name),
      (agent) => landing("agent", agent.id)
    )
  );

  // An orchestrator holding a job until you say who joins it.
  for (const message of workspace.channelMessages) {
    if (!channelIds.has(message.channelId) || message.kind !== "invite" || message.inviteResolved) continue;
    const channel = channelById.get(message.channelId)!;
    const candidates = (message.inviteCandidateIds ?? [])
      .map((id) => agents.find((agent) => agent.id === id))
      .filter((agent): agent is ResolvedAgent => Boolean(agent));
    const channelAgents = channel.projectId ? agents.filter((a) => a.projectId === channel.projectId) : teamAgents;
    const orchestrator = pickOrchestrator(channelAgents);
    const names = joinNames(candidates.map((agent) => agent.name));
    items.push({
      id: `invite:${message.id}`,
      kind: "invite",
      tier: "blocking",
      at: message.createdAt,
      title: `Bring ${names || "specialists"} into #${channel.name}?`,
      why: `${orchestrator?.name ?? "Your agent"} is holding the job until you choose who works on it.`,
      source: src(`#${channel.name}`),
      actor: orchestrator ? { kind: "agent", agentId: orchestrator.id } : { kind: "system" },
      primary: { label: "Add them", op: "accept-invite", messageId: message.id },
      secondary: {
        label: `Keep it with ${orchestrator?.name ?? "you"}`,
        op: "decline-invite",
        messageId: message.id,
      },
    });
  }

  items.push(...pullRequestItems(workspace, projects, (project) => src(project.name)));

  // Your agent privately flagged something you said in a channel.
  for (const whisper of workspace.whispers) {
    if (whisper.kind !== "correction" || whisper.recipientId !== CURRENT_USER_ID || whisper.read) continue;
    const message = workspace.channelMessages.find((item) => item.id === whisper.channelMessageId);
    if (!message || !channelIds.has(message.channelId)) continue;
    const channel = channelById.get(message.channelId)!;
    items.push({
      id: `memory-check:${whisper.id}`,
      kind: "memory-check",
      tier: "waiting",
      at: whisper.createdAt,
      title: whisper.title,
      why: whisper.body,
      quote: clip(message.content),
      source: src(`#${channel.name}`),
      actor: { kind: "agent", agentId: whisper.agentId },
      primary: {
        label: "Correct it",
        op: "correct-message",
        messageId: message.id,
        channelId: channel.id,
        teamId: team.id,
        whisperId: whisper.id,
      },
      secondary: { label: "It's right", op: "confirm-memory-check", whisperId: whisper.id },
    });
  }

  // New replies in threads you started or joined.
  const roots = workspace.channelMessages.filter(
    (message) => channelIds.has(message.channelId) && !message.threadRootId && !message.visibility
  );
  for (const root of roots) {
    const replies = workspace.channelMessages
      .filter((message) => message.threadRootId === root.id && !message.visibility)
      .sort((left, right) => left.createdAt - right.createdAt);
    if (replies.length === 0) continue;
    const mine = [root, ...replies].filter(
      (message) => message.authorId === CURRENT_USER_ID && (message.authorKind ?? "human") === "human"
    );
    if (mine.length === 0) continue;
    const lastMine = mine[mine.length - 1].createdAt;
    const fresh = replies.filter((message) => message.createdAt > lastMine && message.authorId !== CURRENT_USER_ID);
    if (fresh.length === 0) continue;
    const channel = channelById.get(root.channelId)!;
    const members = team.members;
    const names = Array.from(new Set(fresh.map((message) => channelAuthorName(message, members, agents))));
    const latest = fresh[fresh.length - 1];
    items.push({
      id: `replies:${root.id}`,
      kind: "replies",
      tier: "waiting",
      at: latest.createdAt,
      title: `${joinNames(names)} replied in a thread in #${channel.name}`,
      why:
        root.authorId === CURRENT_USER_ID
          ? `${fresh.length === 1 ? "1 new reply" : `${fresh.length} new replies`} to your message.`
          : `${fresh.length === 1 ? "1 new reply" : `${fresh.length} new replies`} since you last posted in it.`,
      quote: clip(latest.content),
      source: src(`#${channel.name}`),
      actor: latest.agentId
        ? { kind: "agent", agentId: latest.agentId }
        : { kind: "human", name: channelAuthorName(latest, members, agents) },
      primary: {
        label: "Open thread",
        op: "open",
        target: landing("channel", channel.id),
      },
    });
  }

  // Unread direct messages.
  for (const dm of workspace.dms) {
    if (dm.teamId !== team.id || !dm.memberIds.includes(CURRENT_USER_ID)) continue;
    if (!isDmUnread(dm, workspace.dmMessages, workspace.dmReadAt)) continue;
    const last = latestDmMessage(workspace.dmMessages, dm.id)!;
    const label = dmLabel(dm.memberIds, team.members);
    items.push({
      id: `dm:${dm.id}`,
      kind: "dm",
      tier: "waiting",
      at: last.createdAt,
      title: `${label} messaged you`,
      why: `${memberName(workspace, last.authorId)} is waiting on a reply.`,
      quote: clip(last.content),
      source: src("Direct message"),
      actor: { kind: "human", name: memberName(workspace, last.authorId) },
      primary: {
        label: "Preview only",
        op: "unavailable",
        reason: "Studio does not yet link this cross-team inbox item to its direct message.",
      },
    });
  }

  // Specialists that finished a job you started.
  for (const thread of workspace.channelJobThreads) {
    if (!channelIds.has(thread.channelId) || thread.status !== "done") continue;
    const channel = channelById.get(thread.channelId)!;
    const agent = agents.find((item) => item.id === thread.agentId);
    const finding = [...thread.messages].reverse().find((message) => message.authorKind === "agent");
    const at = thread.messages.length > 0 ? thread.messages[thread.messages.length - 1].createdAt : 0;
    items.push({
      id: `findings:${thread.id}`,
      kind: "findings",
      tier: "fyi",
      at,
      title: `${agent?.name ?? "A specialist"} finished a job in #${channel.name}`,
      why: clip(thread.title, 100),
      quote: finding ? clip(finding.content) : undefined,
      source: src(`#${channel.name}`),
      actor: agent ? { kind: "agent", agentId: agent.id } : { kind: "system" },
      primary: {
        label: "Read findings",
        op: "open",
        target: landing("channel", channel.id),
      },
    });
  }

  return items;
}

// Every team you're on, merged. A project shared with two of your teams
// would otherwise put the same agent/PR in front of you twice - the first
// team wins and the duplicate is dropped.
export function allTeamActionItems(workspace: WorkspaceSnapshot): ActionItem[] {
  const seen = new Set<string>();
  const items: ActionItem[] = [];
  for (const team of workspace.teams.filter(isMember)) {
    for (const item of teamActionItems(workspace, team)) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }
  return items;
}

// --- personal items -------------------------------------------------------------

const RECENT_MEMORY_MS = 3 * 24 * 60 * 60 * 1000;

export function personalActionItems(workspace: WorkspaceSnapshot): ActionItem[] {
  const projects = personalProjects(workspace);
  const items: ActionItem[] = [];
  const src = (label: string): ActionSource => ({ side: "personal", label });

  items.push(
    ...agentWaitingItems(
      workspace,
      projects,
      (project) => src(project.name),
      (agent) => ({ type: "route", href: `/agents?agent=${encodeURIComponent(agent.definitionId)}` })
    )
  );
  items.push(...pullRequestItems(workspace, projects, (project) => src(project.name)));

  for (const item of workspace.memoryItems) {
    if (item.ownerId !== CURRENT_USER_ID) continue;
    if (item.status === "failed") {
      items.push({
        id: `memory-failed:${item.id}`,
        kind: "memory-failed",
        tier: "waiting",
        at: item.statusChangedAt,
        title: `“${item.title}” didn't make it into memory`,
        why: item.failureReason ?? "Something went wrong while indexing it.",
        source: src("Memory Inbox"),
        actor: { kind: "system" },
        primary: { label: "Try again", op: "retry-memory", itemId: item.id },
        secondary: { label: "Open Memory Inbox", op: "open", target: { type: "route", href: "/memory-inbox" } },
      });
    } else if (
      item.status === "ready" &&
      item.sharedWith.length === 0 &&
      Date.now() - item.statusChangedAt < RECENT_MEMORY_MS
    ) {
      items.push({
        id: `memory-ready:${item.id}`,
        kind: "memory-ready",
        tier: "fyi",
        at: item.statusChangedAt,
        title: `“${item.title}” is in your memory now`,
        why: "Only your agents can draw on it. Share it and your teams' agents can use it too.",
        quote: item.summary,
        source: src("Memory Inbox"),
        actor: { kind: "system" },
        primary: { label: "Share with a team", op: "open", target: { type: "route", href: "/memory-inbox" } },
      });
    }
  }

  // Agents you made that aren't doing anything anywhere yet.
  for (const definition of workspace.agentDefinitions) {
    if (definition.ownerId !== CURRENT_USER_ID) continue;
    if (workspace.projectAgents.some((agent) => agent.definitionId === definition.id)) continue;
    items.push({
      id: `agent-idle:${definition.id}`,
      kind: "agent-idle",
      tier: "fyi",
      at: definition.createdAt,
      title: `${definition.name} isn't working on anything yet`,
      why: `You created @${agentHandle(definition.name)} ${relativeTime(definition.createdAt)} but haven't unleashed it into a project.`,
      source: src("Agents"),
      actor: { kind: "system" },
      primary: {
        label: "Put it to work",
        op: "open",
        target: { type: "route", href: `/agents?agent=${encodeURIComponent(definition.id)}` },
      },
    });
  }

  return items;
}

// --- "since you were last here" --------------------------------------------------

export type CatchUpEntry = { id: string; label: string; target: ActionTarget };

// A short, clickable recap for one team: where the conversation moved and
// what got shipped, each chip landing on the thing itself.
export function catchUpFor(workspace: WorkspaceSnapshot, team: Team, since: number): CatchUpEntry[] {
  const channels = workspace.channels.filter((channel) => channel.teamId === team.id);
  const entries: CatchUpEntry[] = [];
  for (const channel of channels) {
    const fresh = workspace.channelMessages.filter(
      (message) =>
        message.channelId === channel.id &&
        !message.visibility &&
        channelMessageKind(message) === "chat" &&
        message.authorId !== CURRENT_USER_ID &&
        message.createdAt > since
    );
    if (fresh.length === 0) continue;
    entries.push({
      id: `channel:${channel.id}`,
      label: `#${channel.name} · ${fresh.length} new`,
      target: { type: "collab", landing: { teamId: team.id, projectId: channel.projectId, view: "channel", viewId: channel.id } },
    });
  }
  const shipped = workspace.channelJobThreads.filter((thread) => {
    if (!channels.some((channel) => channel.id === thread.channelId) || thread.status !== "done") return false;
    const last = thread.messages[thread.messages.length - 1];
    return Boolean(last && last.createdAt > since);
  });
  if (shipped.length > 0) {
    entries.push({
      id: "shipped",
      label: shipped.length === 1 ? "1 job shipped" : `${shipped.length} jobs shipped`,
      target: { type: "collab", landing: { teamId: team.id, projectId: null, view: "square" } },
    });
  }
  return entries;
}
