import { useLayoutEffect, useMemo } from "react";

import { App } from "./renderer/App.js";

const FIXTURE_ID = "hq-approved-map-fixture-v1";
const FIXTURE_TIME = "2026-10-19T09:00:00.000Z";

const seededData = {
  fixedAt: FIXTURE_TIME,
  projects: [
    { id: "koed-main", name: "koed-main", people: ["Mark"] },
    { id: "investor-deck", name: "Investor deck", people: ["Sam"] },
    { id: "koed-mobile", name: "koed-mobile", people: [] },
    { id: "japan-trip", name: "Japan trip", people: [] },
    { id: "econ-101", name: "Econ 101", people: ["Lena", "Omar"] }
  ],
  conversations: [
    {
      id: "conversation-koed-main-launch",
      projectId: "koed-main",
      title: "Launch checklist",
      summary: "The release checklist and review schedule are up to date.",
      latestAt: FIXTURE_TIME,
      visibility: "shared-summary"
    },
    {
      id: "conversation-investor-deck-outline",
      projectId: "investor-deck",
      title: "Investor outline",
      summary: "The deck outline has a clear market and product story.",
      latestAt: FIXTURE_TIME,
      visibility: "shared-summary"
    },
    {
      id: "conversation-koed-mobile-release",
      projectId: "koed-mobile",
      title: "Mobile release notes",
      summary: "The next mobile build is ready for a device check.",
      latestAt: FIXTURE_TIME,
      visibility: "personal"
    },
    {
      id: "conversation-japan-trip-plan",
      projectId: "japan-trip",
      title: "Travel plan",
      summary: "The itinerary keeps each transfer on a separate day.",
      latestAt: FIXTURE_TIME,
      visibility: "personal"
    },
    {
      id: "conversation-econ-study",
      projectId: "econ-101",
      title: "Elasticity review",
      summary: "The study guide covers price and income elasticity.",
      latestAt: FIXTURE_TIME,
      visibility: "shared-summary"
    }
  ],
  privateHqConversations: [
    { id: "hq-koed-main-mark", projectId: "koed-main", owner: "Mark" },
    { id: "hq-koed-main-local", projectId: "koed-main", owner: "You" },
    {
      id: "hq-investor-deck-sam",
      projectId: "investor-deck",
      owner: "Sam"
    },
    {
      id: "hq-investor-deck-local",
      projectId: "investor-deck",
      owner: "You"
    },
    { id: "hq-koed-mobile-local", projectId: "koed-mobile", owner: "You" },
    { id: "hq-japan-trip-local", projectId: "japan-trip", owner: "You" },
    { id: "hq-econ-101-lena", projectId: "econ-101", owner: "Lena" },
    { id: "hq-econ-101-omar", projectId: "econ-101", owner: "Omar" },
    { id: "hq-econ-101-local", projectId: "econ-101", owner: "You" }
  ],
  capturedSessions: [
    {
      id: "session-koed-main-launch",
      projectId: "koed-main",
      title: "Release checklist",
      source: "captured-session",
      latestAt: FIXTURE_TIME
    },
    {
      id: "session-econ-101-elasticity",
      projectId: "econ-101",
      title: "Elasticity examples",
      source: "captured-session",
      latestAt: FIXTURE_TIME
    }
  ],
  runtimeItems: [
    {
      id: "runtime-koed-main-review",
      projectId: "koed-main",
      label: "Review release notes",
      status: "needs-you",
      step: "Review"
    },
    {
      id: "runtime-investor-deck-research",
      projectId: "investor-deck",
      label: "Check market figures",
      status: "working",
      step: "Research"
    },
    {
      id: "runtime-econ-101-quiz",
      projectId: "econ-101",
      label: "Prepare practice questions",
      status: "scheduled",
      step: "Prepare"
    }
  ],
  memories: [
    {
      id: "memory-koed-main-release-window",
      projectId: "koed-main",
      text: "The release review is scheduled for Thursday.",
      sourceConversationId: "conversation-koed-main-launch",
      scope: "personal"
    },
    {
      id: "memory-econ-101-study-order",
      projectId: "econ-101",
      text: "Review demand before comparing market structures.",
      sourceConversationId: "conversation-econ-study",
      scope: "personal"
    }
  ],
  projectSources: [
    {
      id: "source-investor-deck-brief",
      projectId: "investor-deck",
      name: "Investor brief",
      kind: "document",
      origin: "project-source"
    },
    {
      id: "source-econ-101-syllabus",
      projectId: "econ-101",
      name: "Course syllabus",
      kind: "document",
      origin: "project-source"
    },
    {
      id: "source-koed-main-repository",
      projectId: "koed-main",
      name: "Koed repository",
      kind: "repository",
      origin: "project-source"
    }
  ],
  workItems: [
    {
      id: "work-koed-main-release-notes",
      projectId: "koed-main",
      title: "Review release notes",
      status: "open",
      dueOn: "2026-10-20"
    },
    {
      id: "work-econ-101-practice",
      projectId: "econ-101",
      title: "Complete practice set",
      status: "open",
      dueOn: "2026-10-22"
    }
  ],
  flashcardDecks: [
    {
      id: "deck-econ-101",
      projectId: "econ-101",
      title: "Economics basics",
      cards: [
        { id: "card-econ-101-1", question: "What is elasticity?" },
        { id: "card-econ-101-2", question: "What shifts supply?" }
      ],
      memberProgress: { Lena: 1, Omar: 0 }
    }
  ],
  teamMessages: [
    {
      id: "team-message-human-sentinel",
      projectId: "koed-main",
      author: "Mark",
      authorKind: "human",
      unreadFor: ["You"],
      text: "The launch review is now scheduled for Thursday."
    }
  ],
  teamCatchUpMessageIds: [],
  teamAgentTurnInputs: [],
  teamMemoryProposalInputs: [],
  teamMessageSourceIds: []
} as const;

type Mutable<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T extends readonly (infer Item)[]
        ? Mutable<Item>[]
        : T extends object
          ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
          : T;

type HqFixtureData = Mutable<typeof seededData>;
type HqFixtureOperations = {
  prompts: string[];
  proposals: string[];
  turns: string[];
  mutations: string[];
};

export type HqBrowserFixtureHandle = {
  fixtureId: string;
  identityList: () => string[];
  snapshot: () => HqFixtureData;
  reset: () => void;
  changeProjectName: (projectId: string, name: string) => void;
  recordPrompt: (value: string) => void;
  recordProposal: (value: string) => void;
  recordTurn: (value: string) => void;
  summary: () => {
    fixtureId: string;
    fixedAt: string;
    identities: string[];
    projects: number;
    conversations: number;
    privateHqConversations: number;
    capturedSessions: number;
    runtimeItems: number;
    memories: number;
    projectSources: number;
    workItems: number;
    flashcardDecks: number;
    teamMessages: number;
    teamMessageAuthors: string[];
    teamCatchUpMessageIds: number;
    teamAgentTurnInputs: number;
    teamMemoryProposalInputs: number;
    teamMessageSourceIds: number;
    forbiddenTeamContentPresent: boolean;
    operations: HqFixtureOperations;
  };
};

const cloneSeed = (): HqFixtureData =>
  structuredClone(seededData) as unknown as HqFixtureData;

const createHqBrowserFixture = (): HqBrowserFixtureHandle => {
  let data = cloneSeed();
  let operations: HqFixtureOperations = {
    prompts: [],
    proposals: [],
    turns: [],
    mutations: []
  };
  const record = (key: keyof HqFixtureOperations, value: string) => {
    operations[key].push(value);
  };
  return {
    fixtureId: FIXTURE_ID,
    identityList: () => data.projects.map(({ id }) => id),
    snapshot: () => structuredClone(data),
    reset: () => {
      data = cloneSeed();
      operations = { prompts: [], proposals: [], turns: [], mutations: [] };
    },
    changeProjectName: (projectId, name) => {
      const project = data.projects.find(({ id }) => id === projectId);
      if (!project) throw new Error(`Unknown fixture Project: ${projectId}`);
      project.name = name;
      record("mutations", `project-name:${projectId}`);
    },
    recordPrompt: (value) => record("prompts", value),
    recordProposal: (value) => record("proposals", value),
    recordTurn: (value) => record("turns", value),
    summary: () => ({
      fixtureId: FIXTURE_ID,
      fixedAt: data.fixedAt,
      identities: data.projects.map(({ id }) => id),
      projects: data.projects.length,
      conversations: data.conversations.length,
      privateHqConversations: data.privateHqConversations.length,
      capturedSessions: data.capturedSessions.length,
      runtimeItems: data.runtimeItems.length,
      memories: data.memories.length,
      projectSources: data.projectSources.length,
      workItems: data.workItems.length,
      flashcardDecks: data.flashcardDecks.length,
      teamMessages: data.teamMessages.length,
      teamMessageAuthors: [
        ...new Set(data.teamMessages.map(({ authorKind }) => authorKind))
      ],
      teamCatchUpMessageIds: data.teamCatchUpMessageIds.length,
      teamAgentTurnInputs: data.teamAgentTurnInputs.length,
      teamMemoryProposalInputs: data.teamMemoryProposalInputs.length,
      teamMessageSourceIds: data.teamMessageSourceIds.length,
      forbiddenTeamContentPresent:
        data.teamMessages.some(
          ({ authorKind, text }) =>
            authorKind !== "human" ||
            /saved as a decision|goes against a decision/iu.test(text)
        ) ||
        data.teamCatchUpMessageIds.some((id) =>
          data.teamMessages.some((message) => message.id === id)
        ) ||
        data.teamAgentTurnInputs.length > 0 ||
        data.teamMemoryProposalInputs.length > 0 ||
        data.teamMessageSourceIds.length > 0,
      operations: structuredClone(operations)
    })
  };
};

declare global {
  interface Window {
    __koedHqFixture?: HqBrowserFixtureHandle;
  }
}

export function HqValidationApp() {
  const fixture = useMemo(createHqBrowserFixture, []);

  useLayoutEffect(() => {
    document.documentElement.dataset.browserValidationReady = "false";
    document.documentElement.dataset.hqFixtureReady = "false";
    const shell = document.querySelector("[data-hq-shell]");
    if (!shell) {
      throw new Error("The real HQ shell scaffold did not mount.");
    }
    fixture.reset();
    window.__koedHqFixture = fixture;
    document.documentElement.dataset.hqFixtureReady = "true";
    document.documentElement.dataset.browserValidationReady = "true";
    return () => {
      delete window.__koedHqFixture;
      delete document.documentElement.dataset.hqFixtureReady;
      delete document.documentElement.dataset.browserValidationReady;
    };
  }, [fixture]);

  return (
    <App
      hqEnabled
      onboardingComplete
      statusReadyOverride
      teamCollaborationEnabled
    />
  );
}
