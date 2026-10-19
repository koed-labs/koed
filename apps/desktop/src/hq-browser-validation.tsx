import { useLayoutEffect, useMemo } from "react";
import type {
  PersonalDesktopApi,
  PersonalDesktopProject,
  PersonalDesktopProjectMetadata
} from "@koed/shared/personal-desktop";

import { App } from "./renderer/App.js";
import {
  COLLABORATION_DEFAULT_LIMITS,
  COLLABORATION_CONTRACT_VERSION,
  collaborationSnapshotSchema
} from "@koed/shared/collaboration";
import type { CollaborationRendererClient } from "./collaboration/renderer-client.js";
import type { DesktopApi, KoedServerStatus } from "./types.js";
import type { ManagedConversationDesktopApi } from "./ipc/managed-conversation-protocol.js";
import type { DesktopStatusStore } from "./renderer/services/desktop-commands.js";

const FIXTURE_ID = "hq-approved-map-fixture-v1";
const FIXTURE_TIME = "2026-10-19T09:00:00.000Z";
const SIDEBAR_FIXTURE_TIME = "2026-10-19T12:00:00.000Z";

// Deterministic renderer-only Settings fixture. No native/profile command is dispatched.
const settingsOperations: string[] = [];
const fixtureHealthy = { state: "healthy" as const };
const settingsStatus: KoedServerStatus = {
  ok: true,
  state: "healthy",
  koedHome: "/hq-renderer-fixture",
  generatedAt: FIXTURE_TIME,
  runtimeMode: "developer",
  dependencyMode: "external",
  api: { ...fixtureHealthy, url: "http://127.0.0.1:43300" },
  database: fixtureHealthy,
  redis: fixtureHealthy,
  workerQueues: fixtureHealthy,
  embeddingService: fixtureHealthy,
  apiToken: { ...fixtureHealthy, configured: true },
  mcpServer: fixtureHealthy,
  captureHook: fixtureHealthy,
  codex: {
    configured: false,
    state: "not_configured",
    message: "Codex is not set up"
  },
  lcmSummaryService: fixtureHealthy,
  upstreamBackends: {
    ...fixtureHealthy,
    registered: 0,
    validated: 0,
    stale: 0,
    failed: 0,
    notChecked: 0
  },
  lastVerification: { ...fixtureHealthy, checkedAt: null }
};
const settingsStatusSnapshot = {
  status: settingsStatus,
  error: null,
  revision: 1,
  busyCommand: null
};
const settingsStatusStore = {
  current: () => settingsStatusSnapshot,
  subscribe: () => () => undefined,
  refresh: async () => settingsStatus,
  run: async () => {
    throw new Error(
      "HQ browser fixture never dispatches trusted profile/service mutations."
    );
  }
} as unknown as DesktopStatusStore;
const settingsCollaborationSnapshot = collaborationSnapshotSchema.parse({
  contractVersion: COLLABORATION_CONTRACT_VERSION,
  snapshotRevision: "hq-settings-fixture-v1",
  generatedAt: FIXTURE_TIME,
  connection: {
    state: "live",
    backendId: "hq-renderer-fixture",
    connectedAt: FIXTURE_TIME,
    retryAt: null,
    reconnectAttempt: 0,
    protocolVersion: COLLABORATION_CONTRACT_VERSION
  },
  limits: COLLABORATION_DEFAULT_LIMITS,
  navigation: {
    personalOwner: {
      id: "00000000-0000-4000-8000-000000000109",
      displayName: "HQ Settings User",
      presence: "available",
      membershipState: "enabled"
    },
    teamPrincipal: null,
    personal: { memory: [], channels: [] },
    teams: []
  },
  selection: { kind: "personal_memory" },
  view: { kind: "empty" }
});
const settingsCollaborationClient = {
  current: () => settingsCollaborationSnapshot,
  load: async () => settingsCollaborationSnapshot,
  currentSelection: () => settingsCollaborationSnapshot.selection,
  subscribe: () => () => undefined,
  currentRemoteUrl: () => "https://fixture.example.test",
  connectRemote: async () => {
    settingsOperations.push("connect");
  },
  reconnect: async () => {
    settingsOperations.push("reconnect");
  },
  disconnect: async () => {
    settingsOperations.push("disconnect");
  }
} as unknown as CollaborationRendererClient;
let startupEnabled = false;
let accelerationEnabled = true;
const installSettingsDesktop = () => {
  const originalDesktop = window.koedDesktop;
  window.koedDesktop = {
    ...originalDesktop,
    invoke: async (channel: string) => {
      if (channel === "ensure_independent_project")
        return {
          project: sidebarProjectMetadata.find(
            (item) => item.localProjectId === "hq103-loose"
          )
        };
      throw new Error(`Unsupported HQ fixture command: ${channel}`);
    },
    launchAtStartup: {
      get: async () => ({
        enabled: startupEnabled,
        supported: true,
        status: startupEnabled ? "enabled" : "disabled"
      }),
      set: async (enabled: boolean) => {
        startupEnabled = enabled;
        settingsOperations.push(`startup:${enabled}`);
        return {
          enabled,
          supported: true,
          status: enabled ? "enabled" : "disabled"
        };
      }
    },
    hardwareAcceleration: {
      get: async () => ({
        enabled: accelerationEnabled,
        managedByEnvironment: false
      }),
      set: async (enabled: boolean) => {
        accelerationEnabled = enabled;
        settingsOperations.push(`acceleration:${enabled}`);
        return { enabled, managedByEnvironment: false };
      }
    }
  } as DesktopApi;
  (
    window as Window & { __koedHqSettingsOperations?: string[] }
  ).__koedHqSettingsOperations = settingsOperations;
  return () => {
    if (originalDesktop) window.koedDesktop = originalDesktop;
    else delete window.koedDesktop;
    delete (window as Window & { __koedHqSettingsOperations?: string[] })
      .__koedHqSettingsOperations;
  };
};

let hq104SentPrompt = "";
let hq104SentMessageId = "";
const hq104Identity = {
  executionId: "hq104-execution",
  projectId: "hq103-loose",
  capturedSessionId: "hq104-session",
  threadId: "hq104-thread",
  executionOwner: { driverId: "codex" as const, instanceId: "codex.fixture" }
};
const hq104ManagedConversations = {
  launchOptions: async () => ({
    operation: "launch_options",
    options: {
      runners: [],
      instances: [
        {
          instanceId: "codex.fixture",
          driverId: "codex",
          displayName: "Codex",
          ready: true,
          readiness: "ready",
          models: [
            {
              id: "gpt-fixture",
              displayName: "GPT-5.5",
              isDefault: true,
              supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
              defaultReasoningEffort: "medium"
            }
          ],
          capabilities: {
            defaultPermissionMode: "full_access",
            permissionModes: [
              { mode: "supervised", support: "supported" },
              { mode: "full_access", support: "supported" },
              { mode: "auto_edit", support: "supported" },
              { mode: "auto", support: "unsupported" }
            ]
          }
        }
      ]
    }
  }),
  start: async () => ({
    operation: "start",
    status: "ready",
    executionId: hq104Identity.executionId,
    conversation: hq104Identity
  }),
  resume: async () => ({
    operation: "resume",
    status: "ready",
    conversation: hq104Identity
  }),
  send: async (input: {
    prompt: string;
    idempotencyKey: string;
    clientUserMessageId: string;
  }) => {
    hq104SentPrompt = input.prompt;
    hq104SentMessageId = input.clientUserMessageId;
    return {
      operation: "send",
      status: "queued",
      conversation: hq104Identity,
      idempotencyKey: input.idempotencyKey,
      clientUserMessageId: input.clientUserMessageId
    };
  },
  runtime: async () => ({
    operation: "runtime",
    executionId: hq104Identity.executionId,
    executionGeneration: 1,
    executionStateVersion: 1,
    executionState: "running",
    executionLastErrorCode: null,
    latestCommand: null,
    items: []
  }),
  usage: async () => ({
    operation: "usage",
    executionId: hq104Identity.executionId,
    provider: "codex",
    model: "gpt-fixture",
    reasoningEffort: "medium",
    permissionMode: "supervised",
    usage: null
  }),
  readDraft: async () => ({ operation: "draft_read", value: "" }),
  writeDraft: async () => ({ operation: "draft_write", ok: true }),
  deleteDraft: async () => ({ operation: "draft_delete", ok: true }),
  discoverCommands: async () => ({
    operation: "command_discovery",
    status: "ok",
    commands: []
  }),
  targets: async () => ({ operation: "targets", devices: [] })
} as unknown as ManagedConversationDesktopApi;

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

const sidebarConversation = (
  projectId: string,
  projectName: string,
  index: number,
  threadKind: "conversation" | "subagent" = "conversation"
) => {
  const sessionId = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  return {
    eventCount: 1,
    id: `${projectId}-conversation-${index}`,
    invalidatedCount: 0,
    latestAt: SIDEBAR_FIXTURE_TIME,
    name:
      threadKind === "subagent" ? `Subagent ${index}` : `Conversation ${index}`,
    originDevice: null,
    parentSessionId: threadKind === "subagent" ? sessionId : null,
    parentThreadId: threadKind === "subagent" ? `${projectId}-parent` : null,
    projectAssignmentSource: null,
    projectId,
    projectName,
    projectPath: null,
    presentation: null,
    sample: "",
    sessionId,
    sourceAiClient: null,
    threadKind
  };
};

const sidebarProjectGroups: PersonalDesktopProject[] = [
  ...[
    { id: "hq103-koed", name: "Koed" },
    { id: "hq103-notes", name: "Research notes" },
    { id: "hq103-trip", name: "Travel planning" },
    { id: "hq103-work", name: "Work" }
  ].map(({ id, name }, projectIndex) => ({
    eventCount: 5,
    id,
    name,
    path: null,
    threads: [
      ...Array.from({ length: 4 }, (_, index) =>
        sidebarConversation(id, name, (projectIndex + 1) * 20 + index + 1)
      ),
      sidebarConversation(id, name, (projectIndex + 1) * 20 + 9, "subagent")
    ]
  })),
  {
    eventCount: 7,
    id: "hq103-loose",
    name: "Chats",
    path: null,
    threads: Array.from({ length: 7 }, (_, index) =>
      sidebarConversation("hq103-loose", "Chats", 90 + index + 1)
    )
  }
];

const sidebarProjectMetadata: PersonalDesktopProjectMetadata[] =
  sidebarProjectGroups.map((project) => ({
    contextKind: project.id === "hq103-loose" ? "independent" : "project",
    discoveredAt: SIDEBAR_FIXTURE_TIME,
    git: { branch: null, isWorktree: false, remotes: [] },
    lastSeenAt: SIDEBAR_FIXTURE_TIME,
    localProjectId: project.id,
    displayName: project.name,
    path: { cwd: `/hq-validation/${project.id}`, projectRoot: null },
    schemaVersion: 1
  }));

let failInitialProjectsLoad =
  new URLSearchParams(window.location.search).get("projectsFailure") === "once";

const sidebarPersonalMemoryApi: PersonalDesktopApi = {
  listProjects: async () => {
    if (failInitialProjectsLoad) {
      failInitialProjectsLoad = false;
      throw new Error("Fixture project list failure");
    }
    return structuredClone(sidebarProjectGroups);
  },
  listProjectMetadata: async () => structuredClone(sidebarProjectMetadata),
  loadEventPage: async ({ threadId }) =>
    threadId === hq104Identity.threadId && hq104SentPrompt
      ? [
          {
            id: "hq104-user",
            actor: "user",
            eventType: "message",
            timestamp: FIXTURE_TIME,
            sourceEventTime: FIXTURE_TIME,
            sourceSequence: 1,
            content: hq104SentPrompt,
            contentPreview: hq104SentPrompt,
            invalidatedAt: null,
            metadata: { clientUserMessageId: hq104SentMessageId }
          },
          {
            id: "hq104-assistant",
            actor: "assistant",
            eventType: "message",
            timestamp: FIXTURE_TIME,
            sourceEventTime: FIXTURE_TIME,
            sourceSequence: 2,
            content: "I can help with that. Here is the first step.",
            contentPreview: "I can help with that.",
            invalidatedAt: null,
            metadata: {}
          }
        ]
      : [],
  assignSessionProject: async () => ({ projectId: null }),
  updateSessionTitle: async ({ title }) => ({ title }),
  updateSessionPresentation: async () => ({
    presentation: {
      displayMode: "automatic",
      pinnedAt: null,
      snoozedAt: null,
      snoozedUntil: null,
      updatedAt: SIDEBAR_FIXTURE_TIME,
      version: 0
    }
  }),
  subscribe: () => () => undefined
};

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
  const restoreDesktop = useMemo(installSettingsDesktop, []);

  useLayoutEffect(() => {
    document.documentElement.dataset.browserValidationReady = "false";
    document.documentElement.dataset.hqFixtureReady = "false";
    const shell = document.querySelector("[data-hq-shell]");
    if (!shell) {
      throw new Error("The real HQ shell scaffold did not mount.");
    }
    fixture.reset();
    hq104SentPrompt = "";
    hq104SentMessageId = "";
    window.__koedHqFixture = fixture;
    document.documentElement.dataset.hqFixtureReady = "true";
    document.documentElement.dataset.browserValidationReady = "true";
    return () => {
      restoreDesktop();
      delete window.__koedHqFixture;
      delete document.documentElement.dataset.hqFixtureReady;
      delete document.documentElement.dataset.browserValidationReady;
    };
  }, [fixture, restoreDesktop]);

  return (
    <App
      hqEnabled
      collaborationClient={settingsCollaborationClient}
      statusStoreOverride={settingsStatusStore}
      onboardingComplete
      personalMemoryApi={sidebarPersonalMemoryApi}
      managedConversations={hq104ManagedConversations}
      statusReadyOverride
      teamCollaborationEnabled
    />
  );
}
