import {
  briefProject,
  briefingAttention,
  relativeTime,
  resolveAgents,
  type ProjectBriefing,
} from "./collab";
import { CURRENT_USER_ID, isPersistedThread, resolveThreadTitle, type Project, type Team, type WorkspaceSnapshot } from "./workspace";

const HOME_FEED_LIMIT = 12;
const EARLY_THREAD_LIMIT = 2;
export const HOME_VISIBLE_COUNT = 5;

export type HomeKind = "personal" | "collaborative";
export type HomeUrgency = "now" | "soon" | "idle";

export type CollabLanding = {
  teamId: string;
  // Most landings point at a specific project's briefing (an agent waiting
  // on you, a channel with recent activity). A landing that points at the
  // team overall - the Square, For you, or #general - has no project of
  // its own, hence optional.
  projectId: string | null;
  view: "square" | "inbox" | "agent" | "channel";
  viewId?: string;
};

export type HomeDestination =
  | { type: "thread"; threadId: string }
  | { type: "draft"; projectId: string | null }
  | { type: "prompt"; projectId: string | null; prompt: string }
  | { type: "collab"; landing: CollabLanding }
  | { type: "team"; teamId: string }
  | { type: "pull-requests" };

export type HomeItem = {
  id: string;
  kind: HomeKind;
  kicker: string;
  title: string;
  detail: string;
  actionLabel: string;
  destination: HomeDestination;
  urgency: HomeUrgency;
  mix?: { waiting: number; running: number; idle: number };
  // Who/what this belongs to - purely identity, not status. Lets the UI
  // give each team its own color tag and each project its own label,
  // instead of that only living inside the kicker/title prose.
  team?: { id: string; name: string };
  project?: { name: string };
};

function teamForProject(workspace: WorkspaceSnapshot, project: Project): Team | null {
  for (const teamId of project.sharedWith) {
    const team = workspace.teams.find((item) => item.id === teamId);
    if (team) return team;
  }
  return null;
}

function briefingFor(workspace: WorkspaceSnapshot, project: Project, team: Team): ProjectBriefing {
  return briefProject({
    projectId: project.id,
    members: team.members,
    channels: workspace.channels,
    channelMessages: workspace.channelMessages,
    agents: resolveAgents(workspace.projectAgents, workspace.agentDefinitions),
    whispers: workspace.whispers,
  });
}

function mixFrom(briefing: ProjectBriefing) {
  return { waiting: briefing.waiting, running: briefing.running, idle: briefing.idle };
}

function projectMemoryPrompt(project: Project) {
  return `Using the memory layer, summarize recent work and next steps for ${project.name} on ${project.branch}.`;
}

function isPromptLikeTitle(title: string) {
  return (
    title.length > 42 ||
    /^(using|based on|summarize|continue the|what |check |help me|explain )/i.test(title)
  );
}

function collabLanding(teamId: string, briefing: ProjectBriefing): CollabLanding {
  const waiting = briefing.waitingAgentsOnYou[0];
  if (waiting) {
    return { teamId, projectId: briefing.projectId, view: "agent", viewId: waiting.id };
  }
  if (briefing.unreadWhispers > 0) {
    return { teamId, projectId: briefing.projectId, view: "inbox" };
  }
  if (briefing.lastActivity) {
    return {
      teamId,
      projectId: briefing.projectId,
      view: "channel",
      viewId: briefing.lastActivity.channelId,
    };
  }
  return { teamId, projectId: briefing.projectId, view: "square" };
}

function collabInvitation(project: Project, team: Team, briefing: ProjectBriefing): HomeItem {
  const landing = collabLanding(team.id, briefing);
  const mix = mixFrom(briefing);
  const waiting = briefing.waitingAgentsOnYou[0];

  if (waiting) {
    const focus = waiting.focus.trim();
    return {
      id: `collab-${project.id}`,
      kind: "collaborative",
      kicker: `${team.name} · Needs you`,
      title: `Unblock ${waiting.name} on ${project.name}`,
      detail:
        focus && focus !== "No active job"
          ? `${waiting.name} is waiting: ${focus}`
          : `${waiting.name} is blocked until you decide.`,
      actionLabel: "Decide",
      destination: { type: "collab", landing },
      urgency: "now",
      mix,
      team: { id: team.id, name: team.name },
      project: { name: project.name },
    };
  }

  if (briefing.unreadWhispers > 0) {
    return {
      id: `collab-${project.id}`,
      kind: "collaborative",
      kicker: `${team.name} · Needs you`,
      title: `Read the private ping on ${project.name}`,
      detail:
        briefing.unreadWhispers === 1
          ? "Koed held this in your inbox. The team cannot see it."
          : `${briefing.unreadWhispers} private pings are waiting in your inbox.`,
      actionLabel: "Open inbox",
      destination: { type: "collab", landing },
      urgency: "now",
      mix,
      team: { id: team.id, name: team.name },
      project: { name: project.name },
    };
  }

  if (briefing.runningAgents[0]) {
    const agent = briefing.runningAgents[0];
    return {
      id: `collab-${project.id}`,
      kind: "collaborative",
      kicker: `${team.name} · Moving`,
      title: `Watch ${agent.name} on ${project.name}`,
      detail: agent.focus.trim() && agent.focus !== "No active job" ? agent.focus : `${agent.name} is working now.`,
      actionLabel: `Watch ${agent.name}`,
      destination: {
        type: "collab",
        landing: { teamId: team.id, projectId: project.id, view: "agent", viewId: agent.id },
      },
      urgency: "soon",
      mix,
      team: { id: team.id, name: team.name },
      project: { name: project.name },
    };
  }

  if (briefing.lastActivity) {
    return {
      id: `collab-${project.id}`,
      kind: "collaborative",
      kicker: `${team.name} · Moving`,
      title: `Catch up in #${briefing.lastActivity.channelName} on ${project.name}`,
      detail: `${briefing.lastActivity.authorName} was last in #${briefing.lastActivity.channelName}.`,
      actionLabel: `Open #${briefing.lastActivity.channelName}`,
      destination: { type: "collab", landing },
      urgency: "soon",
      mix,
      team: { id: team.id, name: team.name },
      project: { name: project.name },
    };
  }

  return {
    id: `collab-${project.id}`,
    kind: "collaborative",
    kicker: `${team.name} · Memory`,
    title: `What did we last do on ${project.name}?`,
    detail: `Nothing is waiting in ${team.name}. Ask Koed to reconstruct the last stretch from memory.`,
    actionLabel: "Ask Koed",
    destination: { type: "prompt", projectId: project.id, prompt: projectMemoryPrompt(project) },
    urgency: "idle",
    mix,
    team: { id: team.id, name: team.name },
    project: { name: project.name },
  };
}

function pushUnique(target: HomeItem[], source: HomeItem[], limit: number) {
  for (const item of source) {
    if (target.length >= limit) return;
    if (target.some((existing) => existing.id === item.id)) continue;
    target.push(item);
  }
}

export function buildHomeFeed(workspace: WorkspaceSnapshot, previousSessionAt: number | null): HomeItem[] {
  const collab = workspace.projects
    .map((project) => {
      const team = teamForProject(workspace, project);
      if (!team) return null;
      const briefing = briefingFor(workspace, project, team);
      return { item: collabInvitation(project, team, briefing), attention: briefingAttention(briefing) };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  const needsYou = collab.filter((entry) => entry.attention === "needs-you").map((entry) => entry.item);
  const moving = collab.filter((entry) => entry.attention === "moving").map((entry) => entry.item);
  const quiet = collab.filter((entry) => entry.attention === "quiet").map((entry) => entry.item);

  const threads: HomeItem[] = [...workspace.threads]
    .filter(isPersistedThread)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, EARLY_THREAD_LIMIT)
    .map((thread) => {
      const project = workspace.projects.find((item) => item.id === thread.projectId);
      const title = resolveThreadTitle(thread);
      const promptLike = isPromptLikeTitle(title);
      return {
        id: `thread-${thread.id}`,
        kind: "personal" as const,
        kicker: project ? `${project.name} · 1:1` : "1:1 · Memory",
        title: project ? `Continue in ${project.name}` : `Continue · ${relativeTime(thread.updatedAt)}`,
        detail: promptLike
          ? project
            ? `Last turn ${relativeTime(thread.updatedAt)} · ${project.name} is already in memory.`
            : `Last turn ${relativeTime(thread.updatedAt)}.`
          : `“${title}” is still open.`,
        actionLabel: "Open chat",
        destination: { type: "thread" as const, threadId: thread.id },
        urgency: "soon" as const,
        project: project ? { name: project.name } : undefined,
      };
    });

  const coveredProjectIds = new Set(
    [...needsYou, ...moving, ...quiet].map((item) => {
      const destination = item.destination;
      if (destination.type === "collab") return destination.landing.projectId;
      if (destination.type === "prompt") return destination.projectId;
      return null;
    })
  );

  const localProjects: HomeItem[] = workspace.projects
    .filter((project) => project.sharedWith.length === 0 && !coveredProjectIds.has(project.id))
    .map((project) => ({
      id: `local-${project.id}`,
      kind: "personal" as const,
      kicker: "1:1 · Memory",
      title: `What did we last do on ${project.name}?`,
      detail: `Koed can summarize ${project.branch} at ${project.path}.`,
      actionLabel: "Ask Koed",
      destination: { type: "prompt" as const, projectId: project.id, prompt: projectMemoryPrompt(project) },
      urgency: "idle" as const,
      project: { name: project.name },
    }));

  const openPullRequest = [...workspace.pullRequests]
    .filter(
      (pullRequest) =>
        (pullRequest.status === "open" || pullRequest.status === "draft") &&
        pullRequest.authorId !== CURRENT_USER_ID
    )
    .sort((left, right) => left.title.localeCompare(right.title))[0];

  const pullRequests: HomeItem[] = openPullRequest
    ? [
        {
          id: `pr-${openPullRequest.id}`,
          kind: "personal",
          kicker: "Review · Memory",
          title: `Review ${openPullRequest.author}'s latest PR`,
          detail: `${openPullRequest.title} · ${openPullRequest.repo}`,
          actionLabel: "Open PR",
          destination: { type: "pull-requests" },
          urgency: "soon",
          project: { name: openPullRequest.repo },
        },
      ]
    : [
        {
          id: "pr-watch",
          kind: "personal",
          kicker: "Review · Memory",
          title: "Check pull requests with my name on them",
          detail: "Koed will surface reviews here when a repo is connected. Open the queue to look anyway.",
          actionLabel: "Open PRs",
          destination: { type: "pull-requests" },
          urgency: "idle",
        },
      ];

  const memoryQuestions: HomeItem[] = [
    {
      id: "memory-next",
      kind: "personal",
      kicker: "Koed · Memory",
      title: "What should I work on next?",
      detail:
        workspace.threads.length > 0 || workspace.projects.length > 0
          ? "Koed will rank unfinished threads, project activity, and anything waiting on you."
          : "There is little history yet. Ask anyway and Koed will tell you what it can see.",
      actionLabel: "Ask Koed",
      destination: {
        type: "prompt",
        projectId: null,
        prompt: "Based on the memory layer, what should I work on next across my projects, teams, and reviews?",
      },
      urgency: "idle",
    },
  ];

  if (previousSessionAt) {
    memoryQuestions.push({
      id: "memory-last-session",
      kind: "personal",
      kicker: "Koed · Memory",
      title: "Summarize what changed since last time",
      detail: "Threads, projects, and anything that started waiting after you left.",
      actionLabel: "Ask Koed",
      destination: {
        type: "prompt",
        projectId: null,
        prompt:
          "Summarize what changed since I last opened Koed: threads, projects, and anything waiting on me.",
      },
      urgency: "idle",
    });
  }

  const ranked: HomeItem[] = [];
  pushUnique(ranked, needsYou, HOME_FEED_LIMIT);
  pushUnique(ranked, threads, HOME_FEED_LIMIT);
  pushUnique(ranked, moving, HOME_FEED_LIMIT);
  pushUnique(ranked, pullRequests.slice(0, openPullRequest ? 1 : 0), HOME_FEED_LIMIT);
  pushUnique(ranked, quiet, HOME_FEED_LIMIT);
  pushUnique(ranked, localProjects, HOME_FEED_LIMIT);
  pushUnique(ranked, memoryQuestions, HOME_FEED_LIMIT);
  if (!openPullRequest) {
    pushUnique(ranked, pullRequests, HOME_FEED_LIMIT);
  }

  for (const team of workspace.teams) {
    if (ranked.length >= HOME_FEED_LIMIT) break;
    if (ranked.some((item) => item.kind === "collaborative" && item.kicker.startsWith(team.name))) continue;
    ranked.push({
      id: `team-${team.id}`,
      kind: "collaborative",
      kicker: `${team.name} · Collaborative`,
      title: `Catch up with ${team.name}`,
      detail: "Open briefings to see shared projects and anything Koed thinks you should see.",
      actionLabel: "Open briefings",
      destination: { type: "team", teamId: team.id },
      urgency: "idle",
      team: { id: team.id, name: team.name },
    });
  }

  return ranked;
}
