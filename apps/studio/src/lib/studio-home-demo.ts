import type { HomeItem } from "./home";

export type DemoDestination =
  | { type: "chat"; id: "chat-migration" }
  | { type: "collaboration"; id: "collab-auth" }
  | { type: "decision"; id: "decision-index" }
  | { type: "review"; id: "review-migration" }
  | { type: "briefing"; id: "briefing-auth" };

export type DemoHomeItem = HomeItem & { demoDestination: DemoDestination };

export type DemoChat = {
  id: string;
  title: string;
  projectId: string;
};

export type DemoProject = {
  id: string;
  name: string;
};

export type DemoScreen =
  | { type: "home" }
  | { type: "new-chat" }
  | { type: "chat"; id: "chat-migration" }
  | { type: "collaboration"; id: "collab-auth" }
  | { type: "decision"; id: "decision-index" }
  | { type: "review"; id: "review-migration" }
  | { type: "briefing"; id: "briefing-auth" };

export type DemoState = {
  screen: DemoScreen;
  selectedProject: string | null;
  chatMessages: string[];
  collaborationReplies: string[];
  decision: "pending" | "approved" | "changes-requested";
  reviewDecision: "pending" | "accepted" | "follow-up";
};

export type DemoAction =
  | { type: "open"; screen: DemoScreen }
  | { type: "select-project"; projectId: string | null }
  | { type: "send-chat"; text: string }
  | { type: "reply-collaboration"; text: string }
  | { type: "decide"; decision: "approved" | "changes-requested" }
  | { type: "review"; decision: "accepted" | "follow-up" }
  | { type: "reset" };

export const DEMO_PROJECTS: DemoProject[] = [
  { id: "project-x", name: "Project X" },
  { id: "data-migration", name: "Data migration" }
];

export const DEMO_CHATS: DemoChat[] = [
  {
    id: "chat-migration",
    title: "Plan the database migration",
    projectId: "data-migration"
  }
];

export const DEMO_HOME_ITEMS: DemoHomeItem[] = [
  {
    id: "demo-briefing",
    kind: "personal",
    kicker: "Change briefing · Relevant to your work",
    title: "Project X changed its authentication approach",
    detail:
      "The new provider-ID mapping affects the session-table migration you are preparing.",
    actionLabel: "Read briefing",
    destination: { type: "pull-requests" },
    urgency: "idle",
    project: { name: "Project X" },
    demoDestination: { type: "briefing", id: "briefing-auth" }
  },
  {
    id: "demo-chat",
    kind: "personal",
    kicker: "Data migration · Ongoing chat",
    title: "Continue the migration plan",
    detail:
      "Your last discussion mapped the backfill steps. Pick up where you left off with the rollback check still open.",
    actionLabel: "Open chat",
    destination: { type: "thread", threadId: "demo-chat" },
    urgency: "soon",
    project: { name: "Data migration" },
    demoDestination: { type: "chat", id: "chat-migration" }
  },
  {
    id: "demo-collaboration",
    kind: "collaborative",
    kicker: "Project X · Unread discussion",
    title: "Review the authentication thread",
    detail:
      "Alice asked for a second look at the session boundary. Two replies are waiting in the project discussion.",
    actionLabel: "Open discussion",
    destination: {
      type: "collab",
      landing: {
        teamId: "demo-team",
        projectId: "project-x",
        view: "channel",
        viewId: "auth"
      }
    },
    urgency: "now",
    team: { id: "demo-team", name: "Project X" },
    project: { name: "Project X" },
    demoDestination: { type: "collaboration", id: "collab-auth" }
  },
  {
    id: "demo-decision",
    kind: "personal",
    kicker: "Agent decision · Needs you",
    title: "Approve the index backfill",
    detail:
      "The migration agent is ready to create the new index during the next maintenance window.",
    actionLabel: "Review decision",
    destination: { type: "team", teamId: "demo-decision" },
    urgency: "now",
    project: { name: "Data migration" },
    demoDestination: { type: "decision", id: "decision-index" }
  },
  {
    id: "demo-review",
    kind: "personal",
    kicker: "Agent review · Ready",
    title: "Check the migration agent's work",
    detail:
      "The dry run completed with one warning. Confirm the checklist before the agent continues.",
    actionLabel: "Open review",
    destination: { type: "team", teamId: "demo-review" },
    urgency: "soon",
    project: { name: "Data migration" },
    demoDestination: { type: "review", id: "review-migration" }
  },
  {
    id: "demo-briefing-reference",
    kind: "personal",
    kicker: "Project X · Reference",
    title: "Recheck the provider-ID mapping",
    detail:
      "The authentication briefing has the context you need before returning to the migration plan.",
    actionLabel: "Read briefing",
    destination: { type: "pull-requests" },
    urgency: "idle",
    project: { name: "Project X" },
    demoDestination: { type: "briefing", id: "briefing-auth" }
  },
  {
    id: "demo-review-reference",
    kind: "personal",
    kicker: "Data migration · Reference",
    title: "Revisit the rollback warning",
    detail:
      "The review keeps the one remaining warning visible while you decide the next migration step.",
    actionLabel: "Open review",
    destination: { type: "team", teamId: "demo-review" },
    urgency: "idle",
    project: { name: "Data migration" },
    demoDestination: { type: "review", id: "review-migration" }
  }
];

export const INITIAL_DEMO_STATE: DemoState = {
  screen: { type: "home" },
  selectedProject: null,
  chatMessages: [],
  collaborationReplies: [],
  decision: "pending",
  reviewDecision: "pending"
};

export function demoReducer(state: DemoState, action: DemoAction): DemoState {
  switch (action.type) {
    case "open":
      return { ...state, screen: action.screen };
    case "select-project":
      return {
        ...state,
        selectedProject: action.projectId,
        screen: { type: "home" }
      };
    case "send-chat":
      return {
        ...state,
        chatMessages: [...state.chatMessages, action.text.trim()]
      };
    case "reply-collaboration":
      return {
        ...state,
        collaborationReplies: [
          ...state.collaborationReplies,
          action.text.trim()
        ]
      };
    case "decide":
      return { ...state, decision: action.decision };
    case "review":
      return { ...state, reviewDecision: action.decision };
    case "reset":
      return INITIAL_DEMO_STATE;
    default:
      return state;
  }
}

export function demoItemsForProject(projectId: string | null) {
  if (!projectId) return DEMO_HOME_ITEMS;
  return DEMO_HOME_ITEMS.filter((item) => {
    const project = DEMO_PROJECTS.find(
      (candidate) => candidate.name === item.project?.name
    );
    return project?.id === projectId;
  });
}

export function demoItemsForState(
  state: DemoState,
  projectId: string | null
): DemoHomeItem[] {
  return demoItemsForProject(projectId).map((item) => {
    if (
      item.demoDestination.type === "decision" &&
      state.decision !== "pending"
    ) {
      const approved = state.decision === "approved";
      return {
        ...item,
        title: approved
          ? "Backfill approved"
          : "Changes requested for the backfill",
        detail: approved
          ? "Your local approval is recorded. The migration agent remains simulated and will not run."
          : "Your local request is recorded. Review the migration steps again before approving.",
        actionLabel: "View decision",
        urgency: "idle" as const
      };
    }
    if (
      item.demoDestination.type === "review" &&
      state.reviewDecision !== "pending"
    ) {
      const accepted = state.reviewDecision === "accepted";
      return {
        ...item,
        title: accepted ? "Review accepted" : "Follow-up requested",
        detail: accepted
          ? "Your local review result is recorded for this simulated agent run."
          : "Your local follow-up request is recorded for the warning in the dry run.",
        actionLabel: "View review",
        urgency: "idle" as const
      };
    }
    return item;
  });
}
