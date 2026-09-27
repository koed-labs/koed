import { createId } from "./id";

export const CURRENT_USER_ID = "you";

export type TeamMember = {
  id: string;
  name: string;
};

export const AGENT_MODELS = [
  "GPT-6 Astra",
  "Claude 4 Sonnet",
  "Claude 3.5 Sonnet",
  "GPT-5"
] as const;
export const AGENT_EFFORTS = [
  "Low",
  "Medium",
  "High",
  "Extra High",
  "Max"
] as const;

// Token budget replaces the old "workday" idea. It's not how long an agent
// works, it's how much it's allowed to spend doing it - and it's set per
// deployment (below), not on the agent's identity, because the same agent
// can reasonably get a bigger budget on the project that matters most this
// week and a smaller one everywhere else.
export const TOKEN_BUDGETS = [
  "trial",
  "standard",
  "extended",
  "unlimited"
] as const;

export type TokenBudget = (typeof TOKEN_BUDGETS)[number];
export type AgentStatus = "idle" | "running" | "waiting";

export const TOKEN_BUDGET_LABEL: Record<TokenBudget, string> = {
  trial: "50K tokens / day",
  standard: "250K tokens / day",
  extended: "1M tokens / day",
  unlimited: "No daily cap"
};

// A Channel belongs to a team. It may additionally be tied to one of that
// team's projects (a "project channel" - one per project, per team it's
// shared with) or stand on its own (the team-wide #general channel, or any
// future team-wide channel). projectId is the optional half; teamId is
// always required, matching the real backend's Team-first data model.
export type Channel = {
  id: string;
  teamId: string;
  projectId: string | null;
  name: string;
};

// A direct message belongs to a team (whoever's in it), not to a project -
// DMs are ad hoc and flat, unrelated to which project someone's talking about.
export type Dm = {
  id: string;
  teamId: string;
  memberIds: string[];
};

export type ChannelMessageKind =
  | "chat"
  | "system"
  | "assignment"
  | "invite"
  | "suggestion";
export type ChannelAuthorKind = "human" | "agent" | "system";
export type ChannelInviteStatus = "none" | "offered" | "accepted" | "declined";
export type ChannelJobStatus = "working" | "done";

export type ChannelSuggestion = {
  title: string;
  steps: string[];
  prompt: string;
};

export type ChannelMessage = {
  id: string;
  channelId: string;
  authorId: string;
  content: string;
  createdAt: number;
  editedAt?: number;
  kind?: ChannelMessageKind;
  authorKind?: ChannelAuthorKind;
  agentId?: string;
  jobThreadId?: string;
  inviteCandidateIds?: string[];
  inviteResolved?: "accepted" | "declined";
  suggestion?: ChannelSuggestion;
  threadRootId?: string;
  // Private questions in Studio's browser-local collaboration preview are
  // visible only in this local workspace. This is not Team authorization.
  visibility?: "private";
  recipientAgentId?: string;
  reactions?: { emoji: string; authorIds: string[] }[];
};

export const QUICK_REACTIONS = ["👍", "🎉", "❤️", "😂", "👀", "🚀", "✅", "🔥"];

export function threadReplies(messages: ChannelMessage[], rootId: string) {
  return messages
    .filter((message) => message.threadRootId === rootId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function threadParticipantIds(
  root: ChannelMessage,
  replies: ChannelMessage[]
) {
  return Array.from(
    new Set([root.authorId, ...replies.map((reply) => reply.authorId)])
  );
}

export function toggleReaction(
  reactions: ChannelMessage["reactions"],
  emoji: string,
  authorId: string
) {
  const current = reactions ?? [];
  const existing = current.find((reaction) => reaction.emoji === emoji);
  if (!existing) return [...current, { emoji, authorIds: [authorId] }];
  const authorIds = existing.authorIds.includes(authorId)
    ? existing.authorIds.filter((id) => id !== authorId)
    : [...existing.authorIds, authorId];
  return authorIds.length
    ? current.map((reaction) =>
        reaction.emoji === emoji ? { ...reaction, authorIds } : reaction
      )
    : current.filter((reaction) => reaction.emoji !== emoji);
}

export type ChannelCollab = {
  channelId: string;
  orchestratorId: string;
  specialistIds: string[];
  inviteStatus: ChannelInviteStatus;
};

export type ChannelJobThreadMessage = {
  id: string;
  authorKind: "agent" | "orchestrator";
  agentId: string;
  content: string;
  createdAt: number;
};

export type ChannelJobThread = {
  id: string;
  channelId: string;
  agentId: string;
  parentMessageId: string;
  title: string;
  status: ChannelJobStatus;
  findingsShared: boolean;
  messages: ChannelJobThreadMessage[];
  // A private note the owner leaves for themselves on a finished job - part
  // of building a relationship with the agent, not shared with the team.
  note?: string;
};

export type DmMessage = {
  id: string;
  dmId: string;
  authorId: string;
  content: string;
  createdAt: number;
};

export type AgentAvatar = {
  seed: number;
  spec: Record<string, unknown>;
  image: string;
};

// An AgentDefinition is the reusable, personally-owned agent identity: its
// name, personality and avatar. It is created once on the Personal side and
// does not belong to any project. Deliberately NOT here: which model runs
// it, how hard it's pushed, or its token budget - those are properties of
// each deployment below, not of who the agent is.
export type AgentDefinition = {
  id: string;
  ownerId: string;
  name: string;
  role: string;
  identity: string;
  createdAt: number;
  avatar?: AgentAvatar;
};

// A ProjectAgent is one definition unleashed into one project: the
// per-engagement state (status, current focus) AND the per-engagement
// runtime configuration (model, effort, token budget). The same definition
// can have many ProjectAgent rows across many projects at once, each free to
// run a different model at a different budget - "Bob" can be Codex Astra at
// Medium effort on one project and Sonnet 5 at High effort on another.
export type ProjectAgent = {
  id: string;
  definitionId: string;
  projectId: string;
  ownerId: string;
  status: AgentStatus;
  focus: string;
  model: string;
  effort: string;
  tokenBudget: TokenBudget;
  createdAt: number;
};

// A ProjectAgent merged with its AgentDefinition, for anywhere the UI needs
// to display an agent (name, avatar, role, ...) without looking up both.
// model/effort/tokenBudget already live on ProjectAgent itself, so only the
// identity fields need merging in.
export type ResolvedAgent = ProjectAgent & {
  name: string;
  role: string;
  identity: string;
  avatar?: AgentAvatar;
};

export function resolveAgent(
  agent: ProjectAgent,
  definitions: AgentDefinition[]
): ResolvedAgent | null {
  const definition = definitions.find((item) => item.id === agent.definitionId);
  if (!definition) return null;
  return {
    ...agent,
    name: definition.name,
    role: definition.role,
    identity: definition.identity,
    avatar: definition.avatar
  };
}

export function resolveAgents(
  agents: ProjectAgent[],
  definitions: AgentDefinition[]
): ResolvedAgent[] {
  return agents
    .map((agent) => resolveAgent(agent, definitions))
    .filter((agent): agent is ResolvedAgent => agent !== null);
}

// Every project this definition is currently unleashed into.
export function projectsForDefinition(
  definitionId: string,
  agents: ProjectAgent[]
): ProjectAgent[] {
  return agents.filter((agent) => agent.definitionId === definitionId);
}

export type AgentEvent = {
  id: string;
  agentId: string;
  at: number;
  label: string;
};

export type WhisperKind = "correction" | "blocker";

export type AgentWhisper = {
  id: string;
  agentId: string;
  recipientId: string;
  kind: WhisperKind;
  title: string;
  body: string;
  provenance: { title: string; detail: string }[];
  channelMessageId?: string;
  createdAt: number;
  read: boolean;
};

// The stable half of soul.md: who this agent is. Written once, on the
// Personal side, and carried unchanged into every project it's unleashed
// into. No model/effort/budget in here - that runtime configuration is
// chosen per deployment and belongs in the live half below.
export function generateAgentIdentity(input: { name: string; role: string }) {
  const role = input.role.trim() || "teammate";
  const name = input.name.trim() || role;
  return `# ${name}

You are ${name}, a ${role}.
Your owner refers to you as ${name}. Answer to that name in memory and in any workshop you're unleashed into.

## Stance
- Prefer facts from memory over improvising.
- If blocked, ping your owner privately. Do not lecture the project channel.
- The team may watch this workshop. They cannot join your private thread.
`;
}

// The live half of soul.md: this project's context, pulled from that
// project's own memory, plus this deployment's own runtime configuration.
// Regenerate this on every visit rather than caching it, so neither the
// memory briefing nor the runtime line ever goes stale — and so the same
// agent can honestly show a different model/effort/budget on every project
// it's unleashed into.
export function generateProjectContextBrief(input: {
  name: string;
  projectName: string;
  model: string;
  effort: string;
  tokenBudget: TokenBudget;
}) {
  const name = input.name.trim() || "This agent";
  return `## Working in: ${input.projectName}

${name} is drawing on ${input.projectName}'s shared memory here: channels, reviews, and prior decisions in this project. This section is live, not written once — it reflects whatever this project's memory currently holds, and updates as that memory grows.

## Running here
- Model: ${input.model}
- Effort: ${input.effort}
- Token budget: ${TOKEN_BUDGET_LABEL[input.tokenBudget]}
`;
}

// Stitches the stable identity and the live per-project brief into one
// document for preview/export. Kept separate above so the UI can render
// them as two distinct blocks instead of one flat file.
export function composeSoul(identity: string, contextBrief: string) {
  return `${identity}\n${contextBrief}`;
}

// One channel per project, per team that project is shared with - the
// project itself, represented as a channel, named to match its Personal-side
// project folder so the two stay easy to recognize as the same thing.
export function projectChannel(
  teamId: string,
  projectId: string,
  projectName: string
): Channel {
  return { id: createId("channel"), teamId, projectId, name: projectName };
}

// The one pinned, team-wide channel every team gets - not tied to any single
// project, since it's where team-wide (not project-specific) chat belongs.
export function teamGeneralChannel(teamId: string): Channel {
  return { id: createId("channel"), teamId, projectId: null, name: "general" };
}

export function slugifyChannelName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function chatChannel(teamId: string, name: string): Channel {
  return {
    id: createId("channel"),
    teamId,
    projectId: null,
    name: slugifyChannelName(name)
  };
}

export function channelMessageKind(
  message: ChannelMessage
): ChannelMessageKind {
  return message.kind ?? "chat";
}

export function channelAuthorKind(message: ChannelMessage): ChannelAuthorKind {
  return message.authorKind ?? "human";
}

export function agentHandle(name: string) {
  const handle = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 16);
  return handle || "agent";
}

export function pickOrchestrator(
  agents: ResolvedAgent[],
  ownerId = CURRENT_USER_ID
) {
  return [...agents]
    .filter((agent) => agent.ownerId === ownerId)
    .sort((left, right) => left.createdAt - right.createdAt)[0];
}

export function channelAuthorName(
  message: ChannelMessage,
  members: TeamMember[],
  agents: ResolvedAgent[]
) {
  if (
    channelAuthorKind(message) === "system" ||
    channelMessageKind(message) === "invite"
  ) {
    return "System";
  }
  if (message.agentId) {
    return (
      agents.find((agent) => agent.id === message.agentId)?.name ?? "Agent"
    );
  }
  if (channelAuthorKind(message) === "agent") {
    return (
      agents.find((agent) => agent.id === message.authorId)?.name ?? "Agent"
    );
  }
  return (
    members.find((member) => member.id === message.authorId)?.name ?? "Unknown"
  );
}

export function dmLabel(memberIds: string[], members: TeamMember[]) {
  const others = memberIds.filter((id) => id !== CURRENT_USER_ID);
  const names = others
    .map((id) => members.find((member) => member.id === id)?.name ?? "Unknown")
    .sort((left, right) => left.localeCompare(right));
  return names.join(", ") || "You";
}

export function sameDmMembers(left: string[], right: string[]) {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

// Shared "is this conversation unread" logic - one place, used by both
// For you's Direct messages notification and the sidebar's DM list, so
// the two never disagree about what counts as unread: the newest message
// isn't yours, and it landed after the last time you opened this DM.
export function latestDmMessage(
  dmMessages: DmMessage[],
  dmId: string
): DmMessage | undefined {
  return dmMessages
    .filter((message) => message.dmId === dmId)
    .sort((left, right) => right.createdAt - left.createdAt)[0];
}

export function isDmUnread(
  dm: Dm,
  dmMessages: DmMessage[],
  dmReadAt: Record<string, number>
): boolean {
  const latest = latestDmMessage(dmMessages, dm.id);
  if (!latest || latest.authorId === CURRENT_USER_ID) return false;
  return latest.createdAt > (dmReadAt[dm.id] ?? 0);
}

export function statusLabel(status: AgentStatus) {
  if (status === "running") return "Working";
  if (status === "waiting") return "Waiting on owner";
  return "Idle";
}

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

export type ProjectActivity = {
  authorName: string;
  channelId: string;
  channelName: string;
  at: number;
};

export type BriefingAgent = {
  id: string;
  name: string;
  ownerId: string;
  focus: string;
};

export type BriefingAttention = "needs-you" | "moving" | "quiet";

export type ProjectBriefing = {
  projectId: string;
  running: number;
  waiting: number;
  idle: number;
  lastActivity: ProjectActivity | null;
  unreadWhispers: number;
  waitingOnYou: number;
  waitingAgentsOnYou: BriefingAgent[];
  runningAgents: BriefingAgent[];
};

export function relativeTime(at: number, now = Date.now()) {
  const elapsed = Math.max(0, now - at);
  if (elapsed < MS_PER_MINUTE) return "just now";
  if (elapsed < MS_PER_HOUR)
    return `${Math.floor(elapsed / MS_PER_MINUTE)}m ago`;
  if (elapsed < MS_PER_DAY) return `${Math.floor(elapsed / MS_PER_HOUR)}h ago`;
  const days = Math.floor(elapsed / MS_PER_DAY);
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

export function needsYourAction(briefing: ProjectBriefing) {
  return briefing.waitingOnYou > 0 || briefing.unreadWhispers > 0;
}

export function briefingAttention(
  briefing: ProjectBriefing
): BriefingAttention {
  if (needsYourAction(briefing)) return "needs-you";
  if (briefing.running > 0 || briefing.waiting > 0 || briefing.lastActivity)
    return "moving";
  return "quiet";
}

export function attentionLabel(attention: BriefingAttention) {
  if (attention === "needs-you") return "Needs you";
  if (attention === "moving") return "Moving";
  return "Quiet";
}

export function squareLine(briefing: ProjectBriefing) {
  if (!briefing.lastActivity) return "No posts in the square yet";
  return `${briefing.lastActivity.authorName} in #${briefing.lastActivity.channelName} · ${relativeTime(briefing.lastActivity.at)}`;
}

export function nextActionLine(briefing: ProjectBriefing) {
  const waiting = briefing.waitingAgentsOnYou[0];
  if (waiting) {
    const focus = waiting.focus.trim();
    if (focus && focus !== "No active job") return `${waiting.name} · ${focus}`;
    return `${waiting.name} is waiting on you`;
  }
  if (briefing.unreadWhispers > 0) {
    return briefing.unreadWhispers === 1
      ? "1 private ping waiting"
      : `${briefing.unreadWhispers} private pings waiting`;
  }
  if (briefing.runningAgents[0]) {
    return `${briefing.runningAgents[0].name} is working`;
  }
  if (briefing.lastActivity) return squareLine(briefing);
  return "Nothing waiting on you";
}

export function briefProject(input: {
  projectId: string;
  members: TeamMember[];
  channels: Channel[];
  channelMessages: ChannelMessage[];
  agents: ResolvedAgent[];
  whispers: AgentWhisper[];
}): ProjectBriefing {
  const channels = input.channels.filter(
    (channel) => channel.projectId === input.projectId
  );
  const channelIds = new Set(channels.map((channel) => channel.id));
  const agents = input.agents.filter(
    (agent) => agent.projectId === input.projectId
  );
  const agentIds = new Set(agents.map((agent) => agent.id));
  const messages = input.channelMessages.filter(
    (message) =>
      channelIds.has(message.channelId) &&
      channelMessageKind(message) === "chat"
  );
  const latest = [...messages].sort((left, right) => {
    const leftAt = left.editedAt ?? left.createdAt;
    const rightAt = right.editedAt ?? right.createdAt;
    return rightAt - leftAt;
  })[0];
  const lastChannel = latest
    ? channels.find((channel) => channel.id === latest.channelId)
    : undefined;
  const lastActivity = latest
    ? {
        authorName: channelAuthorName(latest, input.members, agents),
        channelId: latest.channelId,
        channelName: lastChannel?.name ?? "general",
        at: latest.editedAt ?? latest.createdAt
      }
    : null;
  const toBriefingAgent = (agent: ResolvedAgent): BriefingAgent => ({
    id: agent.id,
    name: agent.name,
    ownerId: agent.ownerId,
    focus: agent.focus
  });
  const waitingAgentsOnYou = agents
    .filter(
      (agent) => agent.ownerId === CURRENT_USER_ID && agent.status === "waiting"
    )
    .map(toBriefingAgent);

  return {
    projectId: input.projectId,
    running: agents.filter((agent) => agent.status === "running").length,
    waiting: agents.filter((agent) => agent.status === "waiting").length,
    idle: agents.filter((agent) => agent.status === "idle").length,
    lastActivity,
    unreadWhispers: input.whispers.filter(
      (whisper) =>
        whisper.recipientId === CURRENT_USER_ID &&
        !whisper.read &&
        agentIds.has(whisper.agentId)
    ).length,
    waitingOnYou: waitingAgentsOnYou.length,
    waitingAgentsOnYou,
    runningAgents: agents
      .filter((agent) => agent.status === "running")
      .map(toBriefingAgent)
  };
}

export function compareProjectBriefings(
  left: ProjectBriefing,
  right: ProjectBriefing
) {
  const leftNeedsYou = needsYourAction(left);
  const rightNeedsYou = needsYourAction(right);
  if (leftNeedsYou !== rightNeedsYou) return leftNeedsYou ? -1 : 1;
  const leftMoving = left.running > 0 || left.lastActivity !== null;
  const rightMoving = right.running > 0 || right.lastActivity !== null;
  if (leftMoving !== rightMoving) return leftMoving ? -1 : 1;
  const leftAt = left.lastActivity?.at ?? 0;
  const rightAt = right.lastActivity?.at ?? 0;
  return rightAt - leftAt;
}
