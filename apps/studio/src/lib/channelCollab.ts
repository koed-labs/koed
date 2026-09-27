import {
  CURRENT_USER_ID,
  agentHandle,
  pickOrchestrator,
  resolveAgents,
  type AgentDefinition,
  type ChannelCollab,
  type ChannelJobThread,
  type ChannelJobThreadMessage,
  type ChannelMessage,
  type ProjectAgent,
  type ResolvedAgent,
} from "./collab";
import { createId } from "./id";

export const MAX_INVITE_CANDIDATES = 3;

type ChannelWorkspace = {
  channels: { id: string; teamId: string; projectId: string | null; name: string }[];
  projects: { id: string; name: string; sharedWith: string[] }[];
  teams: { id: string; name: string }[];
  projectAgents: ProjectAgent[];
  agentDefinitions: AgentDefinition[];
  channelMessages: ChannelMessage[];
  channelCollabs: ChannelCollab[];
  channelJobThreads: ChannelJobThread[];
};

type ChannelContext = { name: string; agents: ResolvedAgent[] };

// A channel's "context" is the project it belongs to, when it has one - or,
// for a team-wide channel like #general, the team itself: its name stands
// in for a project name in agent chatter, and its agents are every agent
// across every project that team shares, aggregated.
export function contextForChannel(
  workspace: ChannelWorkspace,
  channel: ChannelWorkspace["channels"][number]
): ChannelContext | null {
  const resolved = resolveAgents(workspace.projectAgents, workspace.agentDefinitions);
  if (channel.projectId) {
    const project = workspace.projects.find((item) => item.id === channel.projectId);
    if (!project) return null;
    return { name: project.name, agents: resolved.filter((agent) => agent.projectId === project.id) };
  }
  const team = workspace.teams.find((item) => item.id === channel.teamId);
  if (!team) return null;
  const teamProjectIds = new Set(
    workspace.projects.filter((project) => project.sharedWith.includes(channel.teamId)).map((project) => project.id)
  );
  return { name: team.name, agents: resolved.filter((agent) => teamProjectIds.has(agent.projectId)) };
}

export type ChannelCollabUpdate = {
  userMessage: ChannelMessage;
  channelMessages: ChannelMessage[];
  channelCollabs: ChannelCollab[];
  channelJobThreads: ChannelJobThread[];
};

function clip(text: string, max = 80) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max).trim()}…`;
}

export function joinNames(names: string[]) {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

export function mentionHandles(text: string) {
  return Array.from(text.matchAll(/@([a-z0-9]+)/gi), (match) => match[1].toLowerCase());
}

export function mentionedAgents(text: string, agents: ResolvedAgent[]) {
  const handles = new Set(mentionHandles(text));
  if (handles.size === 0) return [];
  return agents.filter((agent) => handles.has(agentHandle(agent.name)));
}

export function inviteCandidates(agents: ResolvedAgent[], orchestratorId: string) {
  return [...agents]
    .filter((agent) => agent.id !== orchestratorId)
    .sort((left, right) => left.createdAt - right.createdAt)
    .slice(0, MAX_INVITE_CANDIDATES);
}

function tick(start: number) {
  let at = start;
  return () => {
    at += 1;
    return at;
  };
}

function collabForChannel(collabs: ChannelCollab[], channelId: string) {
  return collabs.find((item) => item.channelId === channelId) ?? null;
}

function upsertCollab(collabs: ChannelCollab[], next: ChannelCollab) {
  const exists = collabs.some((item) => item.channelId === next.channelId);
  if (!exists) return [...collabs, next];
  return collabs.map((item) => (item.channelId === next.channelId ? next : item));
}

function orchestratorReply(input: {
  orchestrator: ResolvedAgent;
  projectName: string;
  prompt: string;
  first: boolean;
  hasCandidates: boolean;
}) {
  const prompt = clip(input.prompt, 120);
  if (input.first && input.hasCandidates) {
    return `${input.orchestrator.name} here — ${input.orchestrator.role} for ${input.projectName}. I read that as: "${prompt}". I can stay on this with you, or we can bring in specialists for their own threads.`;
  }
  if (input.first) {
    return `${input.orchestrator.name} here — ${input.orchestrator.role} for ${input.projectName}. I'll stay on this with you from: "${prompt}".`;
  }
  return `Got it. I'll keep this aligned with ${input.projectName}: "${prompt}".`;
}

function assignmentTask(role: string, prompt: string) {
  return `Look at this as ${role}: ${clip(prompt)}`;
}

function specialistFinding(agent: ResolvedAgent, prompt: string, projectName: string) {
  return `From a ${agent.role.toLowerCase()} view on ${projectName}: "${clip(prompt, 72)}" wants a first cut that's useful before we widen the job.`;
}

function synthesisReply(input: {
  orchestrator: ResolvedAgent;
  specialists: ResolvedAgent[];
  projectName: string;
  prompt: string;
}) {
  const handles = input.specialists.map((agent) => `@${agentHandle(agent.name)}`);
  return `${joinNames(handles)} finished their threads. Here's a first pass from ${input.projectName} memory: start with "${clip(input.prompt)}", keep the first step useful on its own, and check back here before expanding.`;
}

function suggestionFor(input: { prompt: string; specialists: ResolvedAgent[] }) {
  const first = input.specialists[0];
  return {
    title: "Our suggestion",
    steps: [
      `Start from: ${clip(input.prompt, 64)}`,
      first ? `${first.role} can own the first cut` : "Keep the first step useful on its own",
      "Bring findings back here before expanding the team",
    ],
    prompt: "How does that feel to you?",
  };
}

function agentChatMessage(input: {
  channelId: string;
  agent: ResolvedAgent;
  content: string;
  createdAt: number;
  kind?: ChannelMessage["kind"];
  jobThreadId?: string;
}): ChannelMessage {
  return {
    id: createId("cmsg"),
    channelId: input.channelId,
    authorId: input.agent.id,
    content: input.content,
    createdAt: input.createdAt,
    kind: input.kind ?? "chat",
    authorKind: "agent",
    agentId: input.agent.id,
    jobThreadId: input.jobThreadId,
  };
}

function buildJobThread(input: {
  channelId: string;
  specialist: ResolvedAgent;
  orchestrator: ResolvedAgent;
  parentMessageId: string;
  prompt: string;
  projectName: string;
  now: () => number;
}): { thread: ChannelJobThread; assignment: ChannelMessage } {
  const threadId = createId("cjob");
  const title = assignmentTask(input.specialist.role, input.prompt);
  const messages: ChannelJobThreadMessage[] = [
    {
      id: createId("cjm"),
      authorKind: "agent",
      agentId: input.specialist.id,
      content: "On it. I'll keep this in its own thread.",
      createdAt: input.now(),
    },
    {
      id: createId("cjm"),
      authorKind: "agent",
      agentId: input.specialist.id,
      content: specialistFinding(input.specialist, input.prompt, input.projectName),
      createdAt: input.now(),
    },
    {
      id: createId("cjm"),
      authorKind: "orchestrator",
      agentId: input.orchestrator.id,
      content: "Useful. I'll fold this back into the channel once you're done.",
      createdAt: input.now(),
    },
  ];
  const thread: ChannelJobThread = {
    id: threadId,
    channelId: input.channelId,
    agentId: input.specialist.id,
    parentMessageId: input.parentMessageId,
    title,
    status: "done",
    findingsShared: true,
    messages,
  };
  const assignment = agentChatMessage({
    channelId: input.channelId,
    agent: input.orchestrator,
    content: `@${agentHandle(input.specialist.name)} — ${title}`,
    createdAt: input.now(),
    kind: "assignment",
    jobThreadId: threadId,
  });
  return { thread, assignment };
}

function latestHumanPrompt(messages: ChannelMessage[], channelId: string) {
  const latest = [...messages]
    .filter(
      (message) =>
        message.channelId === channelId &&
        message.authorId === CURRENT_USER_ID &&
        (message.kind ?? "chat") === "chat"
    )
    .sort((left, right) => right.createdAt - left.createdAt)[0];
  return latest?.content ?? "";
}

function startJobsFor(input: {
  channelId: string;
  specialists: ResolvedAgent[];
  orchestrator: ResolvedAgent;
  parentMessageId: string;
  prompt: string;
  projectName: string;
  now: () => number;
  existingThreads: ChannelJobThread[];
}) {
  const already = new Set(
    input.existingThreads.filter((thread) => thread.channelId === input.channelId).map((thread) => thread.agentId)
  );
  const threads: ChannelJobThread[] = [];
  const assignments: ChannelMessage[] = [];
  for (const specialist of input.specialists) {
    if (already.has(specialist.id)) continue;
    const built = buildJobThread({
      channelId: input.channelId,
      specialist,
      orchestrator: input.orchestrator,
      parentMessageId: input.parentMessageId,
      prompt: input.prompt,
      projectName: input.projectName,
      now: input.now,
    });
    threads.push(built.thread);
    assignments.push(built.assignment);
    already.add(specialist.id);
  }
  return { threads, assignments };
}

export function applyChannelUserPost(
  workspace: ChannelWorkspace,
  channelId: string,
  text: string,
  now = Date.now()
): ChannelCollabUpdate {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Cannot post an empty channel message");
  }
  const channel = workspace.channels.find((item) => item.id === channelId);
  if (!channel) {
    throw new Error(`Unknown channel: ${channelId}`);
  }
  const context = contextForChannel(workspace, channel);
  if (!context) {
    throw new Error("Unknown project or team for this channel");
  }

  const userMessage: ChannelMessage = {
    id: createId("cmsg"),
    channelId,
    authorId: CURRENT_USER_ID,
    content: trimmed,
    createdAt: now,
    kind: "chat",
    authorKind: "human",
  };

  const agents = context.agents;
  const orchestrator = pickOrchestrator(agents);
  let channelMessages = [...workspace.channelMessages, userMessage];
  let channelCollabs = [...workspace.channelCollabs];
  let channelJobThreads = [...workspace.channelJobThreads];

  if (!orchestrator) {
    return { userMessage, channelMessages, channelCollabs, channelJobThreads };
  }

  const next = tick(now);
  const existing = collabForChannel(channelCollabs, channelId);
  const candidates = inviteCandidates(agents, orchestrator.id);

  if (!existing || existing.inviteStatus === "none") {
    const collab: ChannelCollab = {
      channelId,
      orchestratorId: orchestrator.id,
      specialistIds: [],
      inviteStatus: candidates.length > 0 ? "offered" : "declined",
    };
    channelMessages = [
      ...channelMessages,
      agentChatMessage({
        channelId,
        agent: orchestrator,
        content: orchestratorReply({
          orchestrator,
          projectName: context.name,
          prompt: trimmed,
          first: true,
          hasCandidates: candidates.length > 0,
        }),
        createdAt: next(),
      }),
    ];
    if (candidates.length > 0) {
      channelMessages = [
        ...channelMessages,
        {
          id: createId("cmsg"),
          channelId,
          authorId: "system",
          content: "",
          createdAt: next(),
          kind: "invite",
          authorKind: "system",
          inviteCandidateIds: candidates.map((agent) => agent.id),
        },
      ];
    }
    channelCollabs = upsertCollab(channelCollabs, collab);
    return { userMessage, channelMessages, channelCollabs, channelJobThreads };
  }

  if (existing.inviteStatus === "offered") {
    return { userMessage, channelMessages, channelCollabs, channelJobThreads };
  }

  const mentioned = mentionedAgents(
    trimmed,
    agents.filter((agent) => agent.id !== orchestrator.id)
  );
  const jobs = startJobsFor({
    channelId,
    specialists: mentioned,
    orchestrator,
    parentMessageId: userMessage.id,
    prompt: trimmed,
    projectName: context.name,
    now: next,
    existingThreads: channelJobThreads,
  });
  channelMessages = [...channelMessages, ...jobs.assignments];
  channelJobThreads = [...channelJobThreads, ...jobs.threads];
  channelMessages = [
    ...channelMessages,
    agentChatMessage({
      channelId,
      agent: orchestrator,
      content: orchestratorReply({
        orchestrator,
        projectName: context.name,
        prompt: trimmed,
        first: false,
        hasCandidates: false,
      }),
      createdAt: next(),
    }),
  ];
  if (jobs.threads.length > 0) {
    channelCollabs = upsertCollab(channelCollabs, {
      ...existing,
      specialistIds: Array.from(new Set([...existing.specialistIds, ...jobs.threads.map((thread) => thread.agentId)])),
    });
  }
  return { userMessage, channelMessages, channelCollabs, channelJobThreads };
}

export function applyChannelInviteDecision(
  workspace: ChannelWorkspace,
  inviteMessageId: string,
  decision: "accepted" | "declined",
  now = Date.now()
): Omit<ChannelCollabUpdate, "userMessage"> {
  const invite = workspace.channelMessages.find((message) => message.id === inviteMessageId);
  if (!invite || invite.kind !== "invite") {
    throw new Error("Unknown invite");
  }
  if (invite.inviteResolved) {
    throw new Error("This invite was already answered");
  }
  const channel = workspace.channels.find((item) => item.id === invite.channelId);
  if (!channel) {
    throw new Error("Unknown channel");
  }
  const context = contextForChannel(workspace, channel);
  if (!context) {
    throw new Error("Unknown project or team for this channel");
  }
  const agents = context.agents;
  const collab = collabForChannel(workspace.channelCollabs, invite.channelId);
  const orchestrator =
    agents.find((agent) => agent.id === collab?.orchestratorId) ?? pickOrchestrator(agents);
  if (!orchestrator || !collab) {
    throw new Error("No orchestrator in this channel");
  }

  const next = tick(now);
  let channelMessages = workspace.channelMessages.map((message) =>
    message.id === inviteMessageId ? { ...message, inviteResolved: decision } : message
  );
  let channelJobThreads = [...workspace.channelJobThreads];

  if (decision === "declined") {
    return {
      channelMessages,
      channelCollabs: upsertCollab(workspace.channelCollabs, { ...collab, inviteStatus: "declined" }),
      channelJobThreads,
    };
  }

  const specialists = (invite.inviteCandidateIds ?? [])
    .map((id) => agents.find((agent) => agent.id === id))
    .filter((agent): agent is ResolvedAgent => Boolean(agent));
  if (specialists.length === 0) {
    throw new Error("No specialists to invite");
  }

  const prompt = latestHumanPrompt(workspace.channelMessages, invite.channelId);
  const handles = specialists.map((agent) => `@${agentHandle(agent.name)}`);
  channelMessages = [
    ...channelMessages,
    {
      id: createId("cmsg"),
      channelId: invite.channelId,
      authorId: "system",
      content: `${orchestrator.name} added ${joinNames(handles)}`,
      createdAt: next(),
      kind: "system",
      authorKind: "system",
    },
  ];

  const jobs = startJobsFor({
    channelId: invite.channelId,
    specialists,
    orchestrator,
    parentMessageId: inviteMessageId,
    prompt,
    projectName: context.name,
    now: next,
    existingThreads: channelJobThreads,
  });
  channelMessages = [...channelMessages, ...jobs.assignments];
  channelJobThreads = [...channelJobThreads, ...jobs.threads];
  channelMessages = [
    ...channelMessages,
    agentChatMessage({
      channelId: invite.channelId,
      agent: orchestrator,
      content: synthesisReply({
        orchestrator,
        specialists,
        projectName: context.name,
        prompt,
      }),
      createdAt: next(),
    }),
    {
      id: createId("cmsg"),
      channelId: invite.channelId,
      authorId: orchestrator.id,
      content: "",
      createdAt: next(),
      kind: "suggestion",
      authorKind: "agent",
      agentId: orchestrator.id,
      suggestion: suggestionFor({ prompt, specialists }),
    },
  ];

  return {
    channelMessages,
    channelCollabs: upsertCollab(workspace.channelCollabs, {
      ...collab,
      inviteStatus: "accepted",
      specialistIds: specialists.map((agent) => agent.id),
    }),
    channelJobThreads,
  };
}
