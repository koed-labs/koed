import { CURRENT_USER_ID } from "./collab";
import type {
  AgentDefinition,
  AgentEvent,
  AgentStatus,
  AgentWhisper,
  Channel,
  ChannelCollab,
  ChannelJobThread,
  ChannelMessage,
  Dm,
  DmMessage,
  ProjectAgent,
} from "./collab";
import { AGENT_MODELS, generateAgentIdentity, projectChannel, relativeTime, teamGeneralChannel } from "./collab";
import { createId } from "./id";
import type { MemoryItem } from "./memoryInbox";

export { createId } from "./id";
export { CURRENT_USER_ID } from "./collab";

export type ChatRole = "user" | "agent";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
};

export type Thread = {
  id: string;
  title: string;
  projectId: string | null;
  messages: ChatMessage[];
  sharedWith: string[];
  createdAt: number;
  updatedAt: number;
};

export type Project = {
  id: string;
  name: string;
  path: string;
  branch: string;
  githubRepo?: string;
  gitStatus: "clean" | "dirty" | "syncing";
  sharedWith: string[];
  createdAt: number;
};

// The team's own review-loop state for a PR - who opened it, who (if
// anyone) has claimed reviewing it out of the open pool, and what's
// happened since. Kept separate from `status` below (that's the
// GitHub-style open/merged/draft lifecycle); this is "who owes who a
// look" - the thing that today gets tracked over Signal instead of here.
export type PullRequestReviewStatus = "needs-reviewer" | "in-review" | "changes-requested" | "approved";

export type PullRequestFeedback = {
  id: string;
  authorId: string;
  body: string;
  createdAt: number;
};

export type PullRequest = {
  id: string;
  title: string;
  repo: string;
  branch: string;
  baseBranch: string;
  time: string;
  added: number;
  removed: number;
  status: "open" | "merged" | "draft";
  avatar?: string;
  author: string;
  authorId: string;
  projectId: string;
  reviewStatus: PullRequestReviewStatus;
  reviewerId: string | null;
  feedback: PullRequestFeedback[];
  updatedAt: number;
};

export type TeamMember = {
  id: string;
  name: string;
};

export type Team = {
  id: string;
  name: string;
  members: TeamMember[];
};

// A running "checked in on this team" streak - count is consecutive days,
// lastDay is the most recent day (as a YYYY-MM-DD key) it advanced on.
export type TeamCheckIn = {
  count: number;
  lastDay: string;
};

export type WorkspaceSnapshot = {
  version: 1;
  projects: Project[];
  threads: Thread[];
  pullRequests: PullRequest[];
  teams: Team[];
  channels: Channel[];
  dms: Dm[];
  channelMessages: ChannelMessage[];
  channelCollabs: ChannelCollab[];
  channelJobThreads: ChannelJobThread[];
  dmMessages: DmMessage[];
  agentDefinitions: AgentDefinition[];
  projectAgents: ProjectAgent[];
  agentEvents: AgentEvent[];
  whispers: AgentWhisper[];
  memoryItems: MemoryItem[];
  // Per-team "when did I last have this team active" - the raw material
  // for "For you"'s "since you were last here" recap. Keyed by team id.
  teamVisits: Record<string, number>;
  teamCheckIns: Record<string, TeamCheckIn>;
  // Per-DM "when did I last open this conversation" - lets For you compute
  // "unread" (a message from someone else, newer than this) without
  // needing a read flag on every DmMessage. Keyed by dm id.
  dmReadAt: Record<string, number>;
  activeThreadId: string | null;
  lastSessionAt: number | null;
};

export type SuggestionReason = {
  id: string;
  category: "provenance" | "project" | "activity" | "pull-request" | "team";
  title: string;
  detail: string;
};

export type SuggestedAction = {
  id: string;
  label: string;
  prompt: string;
  reasons: SuggestionReason[];
};

export const WORKSPACE_STORAGE_KEY = "memory-layer.workspace.v1";

export const DEFAULT_THREAD_TITLE = "New chat";

export const DEFAULT_TEAMS: Team[] = [
  {
    id: "t1",
    name: "Team Alpha",
    members: [
      { id: CURRENT_USER_ID, name: "You" },
      { id: "maya", name: "Maya" },
      { id: "jordan", name: "Jordan" },
    ],
  },
  {
    id: "t2",
    name: "Team Beta",
    members: [
      { id: CURRENT_USER_ID, name: "You" },
      { id: "riley", name: "Riley" },
    ],
  },
];

export function firstUserPrompt(thread: Thread) {
  return thread.messages.find((message) => message.role === "user")?.content ?? "";
}

export function isPersistedThread(thread: Thread) {
  return thread.messages.length > 0;
}

export function resolveThreadTitle(thread: Thread) {
  const named = thread.title.trim();
  if (named && named !== DEFAULT_THREAD_TITLE) return named;
  const fromPrompt = titleFromPrompt(firstUserPrompt(thread));
  return fromPrompt || DEFAULT_THREAD_TITLE;
}

export function hydrateThreads(threads: Thread[]) {
  return threads.filter(isPersistedThread).map((thread) => ({
    ...thread,
    title: resolveThreadTitle(thread),
  }));
}

export function moveThreadToProject(
  threads: Thread[],
  threadId: string,
  projectId: string | null
) {
  const thread = threads.find((item) => item.id === threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (thread.projectId === projectId) return threads;
  return threads.map((item) =>
    item.id === threadId ? { ...item, projectId, updatedAt: Date.now() } : item
  );
}

export function createEmptyWorkspace(): WorkspaceSnapshot {
  return {
    version: 1,
    projects: [],
    threads: [],
    pullRequests: [],
    teams: DEFAULT_TEAMS,
    channels: [],
    dms: [],
    channelMessages: [],
    channelCollabs: [],
    channelJobThreads: [],
    dmMessages: [],
    agentDefinitions: [],
    projectAgents: [],
    agentEvents: [],
    whispers: [],
    memoryItems: [],
    teamVisits: {},
    teamCheckIns: {},
    dmReadAt: {},
    activeThreadId: null,
    lastSessionAt: null,
  };
}

const MS_PER_DAY = 86_400_000;

function dayKey(at: number) {
  return new Date(at).toISOString().slice(0, 10);
}

// Advances a team's check-in streak by one more visit "now": a visit on a
// fresh day right after the last one continues the streak, a visit on the
// same day leaves it alone, and any gap resets it to 1. Kept pure (and
// exported) so WorkspaceProvider can call it without owning the calendar
// math itself.
export function nextCheckInCount(existing: TeamCheckIn | undefined, now = Date.now()): TeamCheckIn {
  const today = dayKey(now);
  if (!existing) return { count: 1, lastDay: today };
  if (existing.lastDay === today) return existing;
  if (existing.lastDay === dayKey(now - MS_PER_DAY)) return { count: existing.count + 1, lastDay: today };
  return { count: 1, lastDay: today };
}

export function titleFromPrompt(text: string) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= 42) return compact || DEFAULT_THREAD_TITLE;
  return `${compact.slice(0, 42).trim()}…`;
}

export function parseWorkspace(raw: string | null): WorkspaceSnapshot {
  if (!raw) return createEmptyWorkspace();
  try {
    const parsed = JSON.parse(raw) as Partial<WorkspaceSnapshot>;
    if (parsed.version !== 1) return createEmptyWorkspace();
    const threads = hydrateThreads(parsed.threads ?? []);
    const activeThreadId =
      parsed.activeThreadId && threads.some((thread) => thread.id === parsed.activeThreadId)
        ? parsed.activeThreadId
        : null;
    return hydrateCollab({
      ...createEmptyWorkspace(),
      projects: parsed.projects ?? [],
      threads,
      pullRequests: parsed.pullRequests ?? [],
      teams: hydrateTeams(parsed.teams),
      channels: parsed.channels ?? [],
      dms: parsed.dms ?? [],
      channelMessages: parsed.channelMessages ?? [],
      channelCollabs: Array.isArray(parsed.channelCollabs) ? parsed.channelCollabs : [],
      channelJobThreads: Array.isArray(parsed.channelJobThreads) ? parsed.channelJobThreads : [],
      dmMessages: parsed.dmMessages ?? [],
      agentDefinitions: parsed.agentDefinitions ?? [],
      projectAgents: parsed.projectAgents ?? [],
      agentEvents: parsed.agentEvents ?? [],
      whispers: parsed.whispers ?? [],
      memoryItems: Array.isArray(parsed.memoryItems) ? parsed.memoryItems : [],
      teamVisits: parsed.teamVisits && typeof parsed.teamVisits === "object" ? parsed.teamVisits : {},
      teamCheckIns: parsed.teamCheckIns && typeof parsed.teamCheckIns === "object" ? parsed.teamCheckIns : {},
      dmReadAt: parsed.dmReadAt && typeof parsed.dmReadAt === "object" ? parsed.dmReadAt : {},
      activeThreadId,
      lastSessionAt: parsed.lastSessionAt ?? null,
    });
  } catch {
    return createEmptyWorkspace();
  }
}

const COLLEAGUE_ROLES = ["Reviewer", "Backend"];

export function hydrateTeams(teams: Team[] | undefined): Team[] {
  if (!teams?.length) return DEFAULT_TEAMS;
  return teams.map((team) => {
    const fallback = DEFAULT_TEAMS.find((item) => item.id === team.id);
    const members = team.members?.length
      ? team.members
      : fallback?.members ?? [{ id: CURRENT_USER_ID, name: "You" }];
    return { ...team, members };
  });
}

// A colleague's agent is seeded once as a personal AgentDefinition (owned by
// that colleague) plus a ProjectAgent assignment into this project - the
// same shape a real "unleash" produces, just generated as demo data.
function colleagueAgentForMember(
  project: Project,
  member: TeamMember,
  index: number
): { definition: AgentDefinition; agent: ProjectAgent } {
  const role = COLLEAGUE_ROLES[index % COLLEAGUE_ROLES.length];
  const definition: AgentDefinition = {
    id: createId("agentdef"),
    ownerId: member.id,
    name: role,
    role,
    identity: generateAgentIdentity({ name: role, role }),
    createdAt: Date.now(),
  };
  const agent: ProjectAgent = {
    id: createId("agent"),
    definitionId: definition.id,
    projectId: project.id,
    ownerId: member.id,
    status: "idle",
    focus: "No active job",
    model: "GPT-6 Astra",
    effort: "Medium",
    tokenBudget: "standard",
    createdAt: Date.now(),
  };
  return { definition, agent };
}

// Team Alpha gets a deliberately richer Square: on top of whatever agents
// already exist for a project it shares (including one you created by hand
// through the Agent Workshop), top each owner up to a target agent count -
// a few more of yours, and a fuller bench for every colleague. Driven by
// live counts rather than a one-time flag, so it tops up instead of
// skipping once anything already exists, and stays idempotent once every
// owner has reached its target.
const ALPHA_TEAM_ID = "t1";
const YOUR_TARGET_PER_PROJECT = 3;
const COLLEAGUE_TARGET_PER_PROJECT = 3;
const YOUR_EXTRA_ROLES = ["QA", "Research", "Docs"];
const ALPHA_COLLEAGUE_ROLES = ["Design", "Infra", "Data"];
const ALPHA_FOCUS_LINES = [
  "Triaging flaky tests on the CI pipeline",
  "Drafting release notes for the next cut",
  "Chasing down a memory leak in the sync worker",
  "Writing integration tests for the new endpoint",
  "Refactoring the auth middleware",
  "Reviewing open PRs in the queue",
  "Auditing API error responses",
  "Cleaning up dead code in the legacy module",
  "Benchmarking the new caching layer",
];

function topUpAlphaAgent(
  project: Project,
  ownerId: string,
  role: string,
  index: number
): { definition: AgentDefinition; agent: ProjectAgent } {
  const definition: AgentDefinition = {
    id: createId("agentdef"),
    ownerId,
    name: role,
    role,
    identity: generateAgentIdentity({ name: role, role }),
    createdAt: Date.now(),
  };
  const statuses: AgentStatus[] = ["running", "waiting", "idle"];
  const status = statuses[index % statuses.length];
  const agent: ProjectAgent = {
    id: createId("agent"),
    definitionId: definition.id,
    projectId: project.id,
    ownerId,
    status,
    focus:
      status === "idle"
        ? "No active job"
        : ALPHA_FOCUS_LINES[(index * 5 + role.length) % ALPHA_FOCUS_LINES.length],
    model: AGENT_MODELS[index % AGENT_MODELS.length],
    effort: "Medium",
    tokenBudget: "standard",
    createdAt: Date.now(),
  };
  return { definition, agent };
}

// Top a single project up to Team Alpha's richer target, per owner -
// yourself plus every colleague on the team - without touching any other
// team. Counts what's already there (seeded or hand-made) before deciding
// how many more to add, so re-running this after the target is reached is
// a no-op.
function topUpAlphaSquare(
  project: Project,
  team: Team,
  existingAgents: ProjectAgent[]
): { definitions: AgentDefinition[]; agents: ProjectAgent[] } {
  if (team.id !== ALPHA_TEAM_ID) {
    return { definitions: [], agents: [] };
  }
  const definitions: AgentDefinition[] = [];
  const agents: ProjectAgent[] = [];
  const countFor = (ownerId: string) =>
    existingAgents.filter((agent) => agent.projectId === project.id && agent.ownerId === ownerId).length +
    agents.filter((agent) => agent.ownerId === ownerId).length;

  const yourShortfall = YOUR_TARGET_PER_PROJECT - countFor(CURRENT_USER_ID);
  for (let index = 0; index < yourShortfall; index++) {
    const role = YOUR_EXTRA_ROLES[index % YOUR_EXTRA_ROLES.length];
    const { definition, agent } = topUpAlphaAgent(project, CURRENT_USER_ID, role, index);
    definitions.push(definition);
    agents.push(agent);
  }

  for (const member of team.members.filter((item) => item.id !== CURRENT_USER_ID)) {
    const shortfall = COLLEAGUE_TARGET_PER_PROJECT - countFor(member.id);
    for (let index = 0; index < shortfall; index++) {
      const role = ALPHA_COLLEAGUE_ROLES[index % ALPHA_COLLEAGUE_ROLES.length];
      const { definition, agent } = topUpAlphaAgent(project, member.id, role, index);
      definitions.push(definition);
      agents.push(agent);
    }
  }

  return { definitions, agents };
}

// A couple of realistic pull requests per project, seeded once - the same
// "generate it as demo data, in the same shape a real action would produce"
// approach as colleagueAgentForMember above. One is a colleague's PR still
// waiting for someone on the team to pick it up and review (the open pool,
// the "Signal ping" moment); the other is your own PR that already got a
// look, with feedback attached - the second half of that loop, closing
// back to you instead of a side channel.
function seedPullRequestsForProject(project: Project, teams: Team[]): PullRequest[] {
  const team = project.sharedWith
    .map((teamId) => teams.find((item) => item.id === teamId))
    .find((item): item is Team => Boolean(item));
  if (!team) return [];
  const colleagues = team.members.filter((member) => member.id !== CURRENT_USER_ID);
  if (colleagues.length === 0) return [];
  const now = Date.now();
  const opener = colleagues[0];
  const reviewer = colleagues[colleagues.length > 1 ? 1 : 0];
  const openedAt = now - 3 * 60 * 60 * 1000;
  const feedbackAt = now - 45 * 60 * 1000;

  const needsReviewer: PullRequest = {
    id: createId("pr"),
    title: `Tighten up ${project.name} error handling`,
    repo: project.name,
    branch: `${agentHandleFromName(opener.name)}/error-handling`,
    baseBranch: project.branch,
    time: relativeTime(openedAt, now),
    added: 64,
    removed: 21,
    status: "open",
    author: opener.name,
    authorId: opener.id,
    projectId: project.id,
    reviewStatus: "needs-reviewer",
    reviewerId: null,
    feedback: [],
    updatedAt: openedAt,
  };

  const yourPr: PullRequest = {
    id: createId("pr"),
    title: `Add retry logic to ${project.name} sync`,
    repo: project.name,
    branch: "you/retry-logic",
    baseBranch: project.branch,
    time: relativeTime(feedbackAt, now),
    added: 38,
    removed: 9,
    status: "open",
    author: "You",
    authorId: CURRENT_USER_ID,
    projectId: project.id,
    reviewStatus: "changes-requested",
    reviewerId: reviewer.id,
    feedback: [
      {
        id: createId("prfeedback"),
        authorId: reviewer.id,
        body: `${reviewer.name}: the retry loop needs a max-attempts cap before this can merge.`,
        createdAt: feedbackAt,
      },
    ],
    updatedAt: feedbackAt,
  };

  return [needsReviewer, yourPr];
}

function agentHandleFromName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "teammate";
}

// One example conversation per team, seeded once - a short back-and-forth
// that ends on a message from a colleague, so "For you"'s Direct messages
// section has something real to show instead of an empty state. The
// content deliberately echoes the PR feedback loop seeded above, since
// that's exactly the kind of exchange this section exists to surface.
function seedDmForTeam(team: Team): { dm: Dm; messages: DmMessage[] } | null {
  const colleagues = team.members.filter((member) => member.id !== CURRENT_USER_ID);
  if (colleagues.length === 0) return null;
  const colleague = colleagues[0];
  const dm: Dm = { id: createId("dm"), teamId: team.id, memberIds: [CURRENT_USER_ID, colleague.id] };
  const now = Date.now();
  const messages: DmMessage[] = [
    {
      id: createId("dmsg"),
      dmId: dm.id,
      authorId: CURRENT_USER_ID,
      content: "Hey, can you take a look at my PR when you get a sec?",
      createdAt: now - 40 * 60 * 1000,
    },
    {
      id: createId("dmsg"),
      dmId: dm.id,
      authorId: colleague.id,
      content: "On it - left feedback, one thing to tighten up before it merges.",
      createdAt: now - 15 * 60 * 1000,
    },
  ];
  return { dm, messages };
}

export function bootstrapProjectCollab(project: Project, teams: Team[]) {
  if (project.sharedWith.length === 0) {
    return {
      channels: [] as Channel[],
      definitions: [] as AgentDefinition[],
      agents: [] as ProjectAgent[],
    };
  }
  const channels: Channel[] = [];
  const definitions: AgentDefinition[] = [];
  const agents: ProjectAgent[] = [];
  const seededOwners = new Set<string>();
  for (const teamId of project.sharedWith) {
    const team = teams.find((item) => item.id === teamId);
    if (!team) continue;
    // The project shows up as its own channel inside every team it's
    // shared with - that's the "project as channel" mapping, one row per
    // team so each team's flat sidebar list only shows what's theirs.
    channels.push(projectChannel(teamId, project.id, project.name));
    team.members
      .filter((member) => member.id !== CURRENT_USER_ID)
      .forEach((member, index) => {
        if (seededOwners.has(member.id)) return;
        seededOwners.add(member.id);
        const { definition, agent } = colleagueAgentForMember(project, member, index);
        definitions.push(definition);
        agents.push(agent);
      });
  }
  return { channels, definitions, agents };
}

export function hydrateCollab(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  let channels = [...snapshot.channels];
  let definitions = [...snapshot.agentDefinitions];
  let agents = [...snapshot.projectAgents];
  let pullRequests = [...snapshot.pullRequests];
  let dms = [...snapshot.dms];
  let dmMessages = [...snapshot.dmMessages];

  // Every team gets exactly one pinned #general channel - team-wide, not
  // tied to any project, created once and never duplicated.
  for (const team of snapshot.teams) {
    if (!channels.some((channel) => channel.teamId === team.id && channel.projectId === null)) {
      channels = [...channels, teamGeneralChannel(team.id)];
    }
    if (!dms.some((dm) => dm.teamId === team.id)) {
      const seededDm = seedDmForTeam(team);
      if (seededDm) {
        dms = [...dms, seededDm.dm];
        dmMessages = [...dmMessages, ...seededDm.messages];
      }
    }
  }

  for (const project of snapshot.projects) {
    if (project.sharedWith.length === 0) continue;
    for (const teamId of project.sharedWith) {
      const team = snapshot.teams.find((item) => item.id === teamId);
      if (!team) continue;
      if (!channels.some((channel) => channel.teamId === teamId && channel.projectId === project.id)) {
        channels = [...channels, projectChannel(teamId, project.id, project.name)];
      }
    }
    const alreadySeeded = agents.some((item) => item.projectId === project.id);
    if (!alreadySeeded) {
      const seeded = bootstrapProjectCollab(project, snapshot.teams);
      definitions = [...definitions, ...seeded.definitions];
      agents = [...agents, ...seeded.agents];
    }
    const alphaTeam = project.sharedWith.includes(ALPHA_TEAM_ID)
      ? snapshot.teams.find((item) => item.id === ALPHA_TEAM_ID)
      : undefined;
    if (alphaTeam) {
      const toppedUp = topUpAlphaSquare(project, alphaTeam, agents);
      if (toppedUp.definitions.length > 0) {
        definitions = [...definitions, ...toppedUp.definitions];
        agents = [...agents, ...toppedUp.agents];
      }
    }
    const prsAlreadySeeded = pullRequests.some((pr) => pr.projectId === project.id);
    if (!prsAlreadySeeded) {
      pullRequests = [...pullRequests, ...seedPullRequestsForProject(project, snapshot.teams)];
    }
  }
  return { ...snapshot, channels, agentDefinitions: definitions, projectAgents: agents, pullRequests, dms, dmMessages };
}

export function buildMemorySuggestions(
  workspace: WorkspaceSnapshot,
  previousSessionAt: number | null
): SuggestedAction[] {
  const suggestions: SuggestedAction[] = [];
  const koedProvenance: SuggestionReason = {
    id: "provenance-koed",
    category: "provenance",
    title: "Koed Memory",
    detail: "Koed ranked this from your memory layer: projects, teams, threads, and review activity.",
  };

  const recentThreads = [...workspace.threads]
    .filter((thread) => thread.messages.length > 0)
    .sort((left, right) => right.updatedAt - left.updatedAt);

  for (const thread of recentThreads.slice(0, 2)) {
    const project = workspace.projects.find((item) => item.id === thread.projectId);
    const label = project
      ? `Continue ${thread.title} for ${project.name}`
      : `Continue ${thread.title}`;
    const reasons: SuggestionReason[] = [
      koedProvenance,
      {
        id: `activity-${thread.id}`,
        category: "activity",
        title: "Recent thread",
        detail: `"${thread.title}" was the last conversation Koed saved locally.`,
      },
    ];
    if (project) {
      reasons.push({
        id: `project-${project.id}`,
        category: "project",
        title: project.name,
        detail: `Most recent work sits on ${project.branch} at ${project.path}.`,
      });
    }
    if (previousSessionAt && thread.updatedAt <= previousSessionAt) {
      reasons.push({
        id: `session-${thread.id}`,
        category: "activity",
        title: "Since last visit",
        detail: "This was already in progress the last time you opened Koed.",
      });
    }
    suggestions.push({
      id: `thread-${thread.id}`,
      label,
      prompt: project
        ? `Continue the work on "${thread.title}" in ${project.name}. Use the memory layer for what we already know about this project.`
        : `Continue the work on "${thread.title}". Use the memory layer for context from earlier in this thread.`,
      reasons,
    });
  }

  const latestOpenPr = [...workspace.pullRequests]
    .filter(
      (pullRequest) =>
        (pullRequest.status === "open" || pullRequest.status === "draft") &&
        pullRequest.authorId !== CURRENT_USER_ID
    )
    .sort((left, right) => left.title.localeCompare(right.title))[0];

  if (latestOpenPr) {
    suggestions.push({
      id: `pr-${latestOpenPr.id}`,
      label: `Review ${latestOpenPr.author}'s latest PR`,
      prompt: `Review ${latestOpenPr.author}'s pull request "${latestOpenPr.title}" in ${latestOpenPr.repo}. Use the memory layer to check it against our usual patterns.`,
      reasons: [
        koedProvenance,
        {
          id: `pr-reason-${latestOpenPr.id}`,
          category: "pull-request",
          title: latestOpenPr.title,
          detail: `${latestOpenPr.author} has an ${latestOpenPr.status} PR on ${latestOpenPr.repo} (${latestOpenPr.baseBranch} › ${latestOpenPr.branch}).`,
        },
      ],
    });
  } else {
    suggestions.push({
      id: "pr-watch",
      label: "Check pull requests with my name on them",
      prompt: "Check whether any open pull requests mention me or need a review, and use the memory layer for repo context.",
      reasons: [
        koedProvenance,
        {
          id: "pr-empty",
          category: "pull-request",
          title: "No connected PRs yet",
          detail: "Koed will surface reviews here when a repo is connected. This prompt is ready for that workflow.",
        },
      ],
    });
  }

  for (const project of workspace.projects) {
    if (suggestions.length >= 8) break;
    if (suggestions.some((item) => item.id === `project-${project.id}`)) continue;
    suggestions.push({
      id: `project-${project.id}`,
      label: `What did we last do on ${project.name}?`,
      prompt: `Using the memory layer, summarize recent work and next steps for ${project.name} on ${project.branch}.`,
      reasons: [
        koedProvenance,
        {
          id: `project-reason-${project.id}`,
          category: "project",
          title: project.name,
          detail: `Local folder ${project.path} on ${project.branch}${project.gitStatus === "dirty" ? ", with uncommitted changes" : ""}.`,
        },
      ],
    });
  }

  if (workspace.teams.length > 0) {
    const team = workspace.teams[0];
    suggestions.push({
      id: `team-${team.id}`,
      label: `Catch up with ${team.name}`,
      prompt: `Catch me up on ${team.name}: shared projects, recent threads, and anything the memory layer thinks I should see.`,
      reasons: [
        koedProvenance,
        {
          id: `team-reason-${team.id}`,
          category: "team",
          title: team.name,
          detail: "You are a member of this team workspace, so Koed can rank shared memory next.",
        },
      ],
    });
  }

  suggestions.push(
    {
      id: "memory-next",
      label: "What should I work on next?",
      prompt: "Based on the memory layer, what should I work on next across my projects, teams, and reviews?",
      reasons: [
        koedProvenance,
        {
          id: "next-activity",
          category: "activity",
          title: "Ranked next step",
          detail:
            workspace.threads.length > 0 || workspace.projects.length > 0
              ? "Koed combined unfinished threads and project activity to suggest a next move."
              : "There is little history yet, so Koed is asking you to set the next piece of work.",
        },
      ],
    },
    {
      id: "memory-empty-chat",
      label: "What can the memory layer help with?",
      prompt: "Explain how you will use the memory layer across my projects, teams, and pull requests as I work.",
      reasons: [
        koedProvenance,
        {
          id: "help-scope",
          category: "activity",
          title: "Product surface",
          detail: "Koed can recall local chats, shared team memory, and review context once those exist.",
        },
      ],
    },
    {
      id: "memory-empty-project",
      label: "Create a project to start tracking work",
      prompt: "Help me start a local project and describe what the memory layer will remember as I chat and review code.",
      reasons: [
        koedProvenance,
        {
          id: "project-gap",
          category: "project",
          title: workspace.projects.length === 0 ? "No local project yet" : "Another local project",
          detail:
            workspace.projects.length === 0
              ? "Suggestions get sharper after a folder is linked, because Koed can attach chats to that repo."
              : "Another project would give Koed a second memory scope beside your existing folders.",
        },
      ],
    },
    {
      id: "memory-last-session",
      label: "Summarize what changed since last time",
      prompt: "Summarize what changed since I last opened Koed: threads, projects, and anything waiting on me.",
      reasons: [
        koedProvenance,
        {
          id: "session-gap",
          category: "activity",
          title: previousSessionAt ? "Returning session" : "First session",
          detail: previousSessionAt
            ? "Koed compared current local memory with the previous time this app was opened."
            : "This looks like a fresh session, so the summary will start from whatever is already saved locally.",
        },
      ],
    }
  );

  const unique: SuggestedAction[] = [];
  for (const suggestion of suggestions) {
    if (unique.some((item) => item.id === suggestion.id)) continue;
    unique.push(suggestion);
    if (unique.length >= 8) break;
  }
  return unique;
}

export function buildAgentReply(prompt: string, workspace: WorkspaceSnapshot) {
  const projectNames = workspace.projects.map((project) => project.name);
  const teamNames = workspace.teams.map((team) => team.name);
  const parts: string[] = [];

  if (projectNames.length > 0) {
    parts.push(`projects ${projectNames.join(", ")}`);
  }
  if (teamNames.length > 0) {
    parts.push(`teams ${teamNames.join(", ")}`);
  }
  if (workspace.pullRequests.length > 0) {
    parts.push(`${workspace.pullRequests.length} pull requests`);
  }

  const memoryLine =
    parts.length > 0
      ? `I can see ${parts.join("; ")} in the memory layer.`
      : "The memory layer does not have prior project history yet — I will save this thread as we go.";

  return `${memoryLine} Let's work from: "${prompt.trim()}".`;
}

export function projectsForTeam(workspace: WorkspaceSnapshot, teamId: string) {
  return workspace.projects.filter((project) => project.sharedWith.includes(teamId));
}
