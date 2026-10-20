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
import type {
  CollaborationClientListener,
  CollaborationClientUpdate,
  CollaborationRendererClient
} from "./collaboration/renderer-client.js";
import type { DesktopApi, KoedServerStatus } from "./types.js";
import type { Project } from "@koed/shared";
import type { ManagedConversationDesktopApi } from "./ipc/managed-conversation-protocol.js";
import type { DesktopStatusStore } from "./renderer/services/desktop-commands.js";

const FIXTURE_ID = "hq-approved-map-fixture-v1";
const FIXTURE_TIME = "2026-10-19T09:00:00.000Z";
const SIDEBAR_FIXTURE_TIME = "2026-10-19T12:00:00.000Z";
const hq108Overflow =
  new URLSearchParams(window.location.search).get("nowOverflow") === "yes";
const hq203Empty =
  new URLSearchParams(window.location.search).get("hq203Empty") === "yes";
// Renderer-only presentation fixture. API behavior is verified in Project route tests.
const hq208Capture =
  new URLSearchParams(window.location.search).get("hq208Capture") === "yes";
const hq204Capture =
  new URLSearchParams(window.location.search).get("hq204Capture") === "yes";
const hq205Capture =
  new URLSearchParams(window.location.search).get("hq205Capture") === "yes";
const hq205ProjectId = "00000000-0000-4000-8000-000000002031";
const hq205SourceOwnerId = "00000000-0000-4000-8000-000000002051";
const hq205SourceTime = "2026-10-20T09:00:00.000Z";
const hq205InitialSources = [
  {
    id: "00000000-0000-4000-8000-000000002052",
    projectId: hq205ProjectId,
    kind: "repo" as const,
    name: "koed-labs/koed",
    uri: "github.com/koed-labs/koed",
    currentRevisionId: null,
    status: "ready" as const,
    failureReason: null,
    addedBy: hq205SourceOwnerId,
    uses: 0,
    deletedAt: null,
    createdAt: hq205SourceTime
  },
  {
    id: "00000000-0000-4000-8000-000000002053",
    projectId: hq205ProjectId,
    kind: "doc" as const,
    name: "Plan.md",
    uri: null,
    currentRevisionId: "00000000-0000-4000-8000-000000002054",
    status: "ready" as const,
    failureReason: null,
    addedBy: hq205SourceOwnerId,
    uses: 12,
    deletedAt: null,
    createdAt: hq205SourceTime
  },
  {
    id: "00000000-0000-4000-8000-000000002055",
    projectId: hq205ProjectId,
    kind: "skill" as const,
    name: "code-review",
    uri: null,
    currentRevisionId: null,
    status: "ready" as const,
    failureReason: null,
    addedBy: hq205SourceOwnerId,
    uses: 0,
    deletedAt: null,
    createdAt: hq205SourceTime
  }
];
let hq205Sources = structuredClone(hq205InitialSources);
const hq204ProjectId = "00000000-0000-4000-8000-000000002038";
const hq204ExecutionId = "00000000-0000-4000-8000-000000002044";
const hq204SessionId = "00000000-0000-4000-8000-000000002045";
let hq204Started = false;
const hq204Trace = {
  reserve: 0,
  reserveByProject: {} as Record<string, number>,
  start: 0,
  inspect: 0,
  resume: 0,
  send: 0,
  firstPrompt: "",
  nextPrompt: ""
};
const hq108ProjectIds = [
  "hq103-koed",
  "hq103-notes",
  "hq103-trip",
  "hq103-work",
  "hq108-extra-1",
  "hq108-extra-2",
  "hq108-extra-3"
];
const hq108Executions = Array.from(
  { length: hq108Overflow ? 7 : 2 },
  (_, index) => {
    const projectId = hq108ProjectIds[index]!;
    const conversationIndex = (index + 1) * 20 + 1;
    return {
      executionId: `hq108-execution-${index}`,
      projectId,
      sessionId: `00000000-0000-4000-8000-${String(conversationIndex).padStart(12, "0")}`,
      threadId: `${projectId}-conversation-${conversationIndex}`,
      state: "running"
    };
  }
);

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
const hq105VisibilityListeners = new Set<CollaborationClientListener>();
const publishHq105VisibilityUpdate = (update: CollaborationClientUpdate) => {
  for (const listener of hq105VisibilityListeners)
    void listener(settingsCollaborationSnapshot, update);
};
const settingsCollaborationClient = {
  current: () => settingsCollaborationSnapshot,
  load: async () => settingsCollaborationSnapshot,
  currentSelection: () => settingsCollaborationSnapshot.selection,
  subscribe: (listener: CollaborationClientListener) => {
    hq105VisibilityListeners.add(listener);
    return () => hq105VisibilityListeners.delete(listener);
  },
  currentRemoteUrl: () => "https://fixture.example.test",
  listOwnedSharedMemoryGrants: async ({
    logicalMemoryId
  }: {
    logicalMemoryId: string;
  }) => {
    hq105VisibilityReads.grants += 1;
    if (logicalMemoryId !== hq105LogicalMemoryId)
      throw new Error("Unknown HQ visibility fixture identity");
    return hq105ShareActive
      ? [
          {
            lifecycle: "active",
            source: {
              kind: "captured_session",
              logicalMemoryId: hq105LogicalMemoryId,
              sessionId: hq105CapturedSessionId
            }
          }
        ]
      : [];
  },
  listOwnedShares: async ({ cursor }: { cursor: string | null }) => {
    hq105VisibilityReads.shares += 1;
    if (cursor !== null) throw new Error("Unexpected HQ visibility page");
    return { shares: [], nextCursor: null };
  },
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
    ...(hq204Capture || hq205Capture
      ? {
          agents: {
            list: async () => [
              {
                id: "00000000-0000-4000-8000-000000002046",
                ownerUserId: "00000000-0000-4000-8000-000000000109",
                name: "Chief of Staff",
                role: "Project assistant",
                look: {},
                aiClientInstanceId: "codex.fixture",
                defaultPermissionMode: "supervised",
                defaultModel: "gpt-fixture",
                isChiefOfStaff: true,
                createdAt: FIXTURE_TIME
              }
            ]
          },
          projectHqConversation: {
            reserve: async (projectId: string) => {
              hq204Trace.reserve += 1;
              hq204Trace.reserveByProject[projectId] =
                (hq204Trace.reserveByProject[projectId] ?? 0) + 1;
              return {
                projectId,
                executionId:
                  projectId === hq204ProjectId && hq204Started
                    ? hq204ExecutionId
                    : null,
                createdAt: FIXTURE_TIME
              };
            },
            read: async (projectId: string) => ({
              conversation: {
                projectId,
                executionId:
                  projectId === hq204ProjectId && hq204Started
                    ? hq204ExecutionId
                    : null,
                createdAt: FIXTURE_TIME
              },
              execution:
                projectId === hq204ProjectId && hq204Started
                  ? {
                      state: "running",
                      capturedSessionId: hq204SessionId,
                      threadId: "hq204-fixture-thread",
                      graphProjectId: "unassigned",
                      graphThreadId: "hq204-fixture-thread",
                      provider: "codex",
                      aiClientInstanceId: "codex.fixture"
                    }
                  : null
            }),
            start: async (projectId: string, prompt: string) => {
              hq204Trace.start += 1;
              hq204Trace.firstPrompt = prompt;
              hq204Started = true;
              return {
                projectId,
                executionId: hq204ExecutionId,
                commandId: "00000000-0000-4000-8000-000000002047",
                commandState: "queued" as const
              };
            }
          }
        }
      : {}),
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
const hq105LogicalMemoryId = "00000000-0000-4000-8000-000000000105";
const hq105CapturedSessionId = "00000000-0000-4000-8000-000000000091";
const hq105VisibilityReads = { grants: 0, shares: 0 };
let hq105ShareActive = false;
const hq105VisibilityFixture = {
  setShared(active: boolean) {
    hq105ShareActive = active;
    publishHq105VisibilityUpdate({
      kind: "realtime",
      realtimeUpdate: {
        type: "owned_share_status_changed",
        pendingShareId: "00000000-0000-4000-8000-000000000109",
        sourceTitle: "Conversation 91",
        state: active ? "activated" : "revoked",
        stage: "complete",
        workspaceAccessState: active ? "active" : "revoked",
        sourceUpdateState: active ? "active" : "stopped",
        redactedFailureCode: null
      }
    });
  }
};
let hq104SentMessageId = "";
const hq104Recovery = new Map<string, string>();
const hq104Identity = {
  executionId: "hq104-execution",
  projectId: "hq103-loose",
  capturedSessionId: "hq104-session",
  threadId: "hq104-thread",
  executionOwner: { driverId: "codex" as const, instanceId: "codex.fixture" }
};
const resumedFixtureIdentities = new Map<string, typeof hq104Identity>();
const hq104ManagedConversations = {
  list: async () => ({
    operation: "list",
    complete: true,
    executions: hq108Executions
  }),
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
  resume: async (input: {
    projectId: string;
    capturedSessionId: string;
    threadId: string;
  }) => {
    const conversation = {
      ...hq104Identity,
      executionId:
        input.threadId === hq104Identity.threadId
          ? hq104Identity.executionId
          : (hq108Executions.find(
              ({ sessionId, threadId }) =>
                sessionId === input.capturedSessionId &&
                threadId === input.threadId
            )?.executionId ?? input.threadId),
      projectId: input.projectId,
      capturedSessionId: input.capturedSessionId,
      threadId: input.threadId
    };
    resumedFixtureIdentities.set(conversation.executionId, conversation);
    return { operation: "resume", status: "ready", conversation };
  },
  send: async (input: {
    executionId: string;
    capturedSessionId: string;
    threadId: string;
    prompt: string;
    idempotencyKey: string;
    clientUserMessageId: string;
  }) => {
    if (input.executionId === hq104Identity.executionId) {
      hq104SentPrompt = input.prompt;
      hq104SentMessageId = input.clientUserMessageId;
    }
    return {
      operation: "send",
      status: "queued",
      conversation:
        resumedFixtureIdentities.get(input.executionId) ?? hq104Identity,
      idempotencyKey: input.idempotencyKey,
      clientUserMessageId: input.clientUserMessageId
    };
  },
  runtime: async (executionId: string) => ({
    operation: "runtime",
    executionId,
    executionGeneration: 1,
    executionStateVersion: 1,
    executionState: "running",
    executionLastErrorCode: null,
    latestCommand:
      executionId === hq104Identity.executionId && hq104SentMessageId
        ? {
            id: "hq104-prompt-command",
            sequence: 1,
            executionGeneration: 1,
            commandKind: "prompt",
            clientUserMessageId: hq104SentMessageId,
            state: "completed",
            lastErrorCode: null,
            updatedAt: FIXTURE_TIME
          }
        : null,
    items: hq108Executions.some(
      (execution) => execution.executionId === executionId
    )
      ? [
          {
            id: `${executionId}-item`,
            executionGeneration: 1,
            providerTurnId: null,
            providerItemId: null,
            itemKind: executionId.endsWith("-1")
              ? "user_input"
              : "command_approval",
            presentation: {
              mode: "expanded",
              renderer: executionId.endsWith("-1") ? "user_input" : "approval",
              policyKey: "hq108-fixture",
              policyRevision: 1,
              reason: "Pending"
            },
            state: "pending",
            payload: executionId.endsWith("-1")
              ? {
                  questions: [
                    { id: "date", question: "Choose the review date" }
                  ]
                }
              : { command: ["review", "release"] },
            revision: 1,
            createdAt: FIXTURE_TIME,
            updatedAt: FIXTURE_TIME,
            answered: false
          }
        ]
      : []
  }),
  usage: async (executionId: string) => ({
    operation: "usage",
    executionId,
    provider: "codex",
    model: "gpt-fixture",
    reasoningEffort: "medium",
    permissionMode: "supervised",
    usage: null
  }),
  readDraft: async () => ({ operation: "draft_read", value: "" }),
  writeDraft: async () => ({ operation: "draft_write", ok: true }),
  deleteDraft: async () => ({ operation: "draft_delete", ok: true }),
  readRecovery: async (ownerId: string) => ({
    operation: "recovery_read",
    value: hq104Recovery.get(ownerId) ?? ""
  }),
  writeRecovery: async (ownerId: string, value: string) => {
    hq104Recovery.set(ownerId, value);
    return { operation: "recovery_write", ok: true };
  },
  discoverCommands: async () => ({
    operation: "command_discovery",
    status: "ok",
    commands: []
  }),
  targets: async () => ({ operation: "targets", devices: [] })
} as unknown as ManagedConversationDesktopApi;

const hq204ManagedConversations = {
  ...hq104ManagedConversations,
  inspect: async (executionId: string) => {
    hq204Trace.inspect += 1;
    return {
      operation: "inspect" as const,
      executionId,
      status: hq204Started ? ("ready" as const) : ("starting" as const),
      ...(hq204Started
        ? {
            conversation: {
              executionId: hq204ExecutionId,
              projectId: hq204ProjectId,
              capturedSessionId: hq204SessionId,
              threadId: "hq204-fixture-thread",
              executionOwner: {
                driverId: "codex" as const,
                instanceId: "codex.fixture"
              }
            }
          }
        : {})
    };
  },
  resume: async () => {
    hq204Trace.resume += 1;
    return {
      operation: "resume" as const,
      status: "ready" as const,
      conversation: {
        executionId: hq204ExecutionId,
        projectId: hq204ProjectId,
        capturedSessionId: hq204SessionId,
        threadId: "hq204-fixture-thread",
        executionOwner: {
          driverId: "codex" as const,
          instanceId: "codex.fixture"
        }
      }
    };
  },
  send: async (input: {
    prompt: string;
    idempotencyKey: string;
    clientUserMessageId: string;
  }) => {
    hq204Trace.send += 1;
    hq204Trace.nextPrompt = input.prompt;
    return {
      operation: "send" as const,
      status: "queued" as const,
      conversation: {
        executionId: hq204ExecutionId,
        projectId: hq204ProjectId,
        capturedSessionId: hq204SessionId,
        threadId: "hq204-fixture-thread",
        executionOwner: {
          driverId: "codex" as const,
          instanceId: "codex.fixture"
        }
      },
      idempotencyKey: input.idempotencyKey,
      clientUserMessageId: input.clientUserMessageId
    };
  }
} as ManagedConversationDesktopApi;

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
    ...(index === 91 ? { logicalMemoryId: hq105LogicalMemoryId } : {}),
    name:
      threadKind === "subagent" ? `Subagent ${index}` : `Conversation ${index}`,
    originDevice: null,
    parentSessionId: threadKind === "subagent" ? sessionId : null,
    parentThreadId: threadKind === "subagent" ? `${projectId}-parent` : null,
    projectAssignmentSource: null,
    projectId,
    personalProjectId: sidebarPersonalProjectIds[projectId] ?? null,
    projectName,
    projectPath: null,
    presentation: null,
    sample: "",
    sessionId,
    sourceAiClient: null,
    threadKind
  };
};

const sidebarPersonalProjectIds: Record<string, string> = {
  "hq103-koed": "00000000-0000-4000-8000-000000002031",
  "hq103-notes": "00000000-0000-4000-8000-000000002032",
  "hq103-trip": "00000000-0000-4000-8000-000000002033",
  "hq103-work": "00000000-0000-4000-8000-000000002034",
  "hq108-extra-1": "00000000-0000-4000-8000-000000002035",
  "hq108-extra-2": "00000000-0000-4000-8000-000000002036",
  "hq108-extra-3": "00000000-0000-4000-8000-000000002037"
};

const sidebarProjectGroups: PersonalDesktopProject[] = [
  ...[
    { id: "hq103-koed", name: "Koed" },
    { id: "hq103-notes", name: "Research notes" },
    { id: "hq103-trip", name: "Travel planning" },
    { id: "hq103-work", name: "Work" },
    ...(hq108Overflow
      ? [
          { id: "hq108-extra-1", name: "Garden" },
          { id: "hq108-extra-2", name: "Course notes" },
          { id: "hq108-extra-3", name: "Reading list" }
        ]
      : [])
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

const sidebarProjectRecord = (id: string, name: string): Project => ({
  id,
  name,
  key: "HQ",
  folderPath: null,
  lifecycle: "active" as const,
  deletionPhase: null,
  deleteBatchId: null,
  deletedAt: null,
  createdAt: SIDEBAR_FIXTURE_TIME,
  updatedAt: SIDEBAR_FIXTURE_TIME,
  version: 1
});
const initialSidebarPersonalProjects = sidebarProjectGroups
  .filter(({ id }) => id !== "hq103-loose")
  .map(({ id, name }) =>
    sidebarProjectRecord(
      sidebarPersonalProjectIds[id]!,
      id === "hq103-notes" ? "Research archive" : name
    )
  );
if (hq203Empty || hq204Capture)
  initialSidebarPersonalProjects.push(
    sidebarProjectRecord(hq204ProjectId, "New empty Project")
  );
let sidebarPersonalProjects: Project[] = structuredClone(
  initialSidebarPersonalProjects
);
let hq208Deleted: Project | null = null;
let hq208BatchId: string | null = null;
const hq208Status = () => {
  if (!hq208Deleted || !hq208BatchId)
    throw new Error("No capture delete batch.");
  return {
    project: structuredClone(hq208Deleted),
    operation: { batchId: hq208BatchId, state: "complete" as const },
    complete: true,
    retryable: false,
    pendingFreezeCount: 0,
    pendingExecutionCount: 0,
    pendingReviews: [],
    cancellationPending: false
  };
};
const sidebarProjectsApi = {
  sourceList: async (projectId: string) =>
    hq205Capture && projectId === hq205ProjectId
      ? structuredClone(hq205Sources)
      : [],
  sourceDiscoverRepos: async () =>
    hq205Capture
      ? [
          {
            name: "github.com/koed-labs/koed",
            uri: "github.com/koed-labs/koed"
          }
        ]
      : [],
  sourceCreate: async (
    _projectId: string,
    input: { kind: string; name: string; uri?: string | null }
  ) => {
    if (!hq205Capture || input.kind === "doc")
      throw new Error("Document ingestion is unavailable.");
    const source = {
      ...hq205InitialSources[0]!,
      id: crypto.randomUUID(),
      kind: input.kind as "repo",
      name: input.name,
      uri: input.uri ?? "",
      currentRevisionId: null
    };
    hq205Sources.unshift(source);
    return source;
  },
  sourceRemove: async (_projectId: string, sourceId: string) => {
    const source = hq205Sources.find((item) => item.id === sourceId);
    if (!source) throw new Error("Source missing.");
    hq205Sources = hq205Sources.filter((item) => item.id !== sourceId);
    return { ...source, deletedAt: hq205SourceTime };
  },
  sourceRetry: async () => {
    throw new Error("Fixture sources are unavailable.");
  },
  pickFolder: async () => null,
  list: async () => {
    if (failInitialFirstClassProjectsLoad) {
      failInitialFirstClassProjectsLoad = false;
      throw new Error("Fixture Project list failure");
    }
    return structuredClone(sidebarPersonalProjects);
  },
  hq: async () => {
    throw new Error("HQ Project view is a later ticket.");
  },
  create: async ({
    name,
    folderPath
  }: {
    name: string;
    folderPath?: string | null;
  }) => {
    if (!hq208Capture)
      throw new Error("Fixture Project writes are unavailable.");
    const project = {
      ...sidebarProjectRecord(crypto.randomUUID(), name),
      folderPath: folderPath ?? null
    };
    sidebarPersonalProjects.push(project);
    return structuredClone(project);
  },
  deletePreview: async (id: string) => {
    if (!hq208Capture)
      throw new Error("Fixture Project writes are unavailable.");
    const project = sidebarPersonalProjects.find((item) => item.id === id);
    if (!project) throw new Error("Project unavailable.");
    return {
      project: structuredClone(project),
      executionSetHash: "b".repeat(64),
      activeExecutions: []
    };
  },
  delete: async (id: string, { batchId }: { batchId: string }) => {
    if (!hq208Capture)
      throw new Error("Fixture Project writes are unavailable.");
    const project = sidebarPersonalProjects.find((item) => item.id === id);
    if (!project) throw new Error("Project unavailable.");
    hq208BatchId = batchId;
    hq208Deleted = {
      ...project,
      lifecycle: "deleted",
      deletionPhase: "complete",
      deleteBatchId: batchId,
      deletedAt: FIXTURE_TIME,
      version: project.version + 1
    };
    sidebarPersonalProjects = sidebarPersonalProjects.filter(
      (item) => item.id !== id
    );
    return hq208Status();
  },
  deleteProgress: async () => {
    throw new Error("Fixture Project writes are unavailable.");
  },
  deleteStatus: async (_id: string, batchId: string) => {
    if (!hq208Capture || batchId !== hq208BatchId)
      throw new Error("Fixture Project writes are unavailable.");
    return hq208Status();
  },
  deleteCancel: async () => {
    throw new Error("Fixture Project writes are unavailable.");
  },
  restore: async () => {
    if (!hq208Capture || !hq208Deleted)
      throw new Error("Fixture Project writes are unavailable.");
    const restored: Project = {
      ...hq208Deleted,
      lifecycle: "active",
      deletionPhase: null,
      deleteBatchId: null,
      deletedAt: null,
      version: hq208Deleted.version + 1
    };
    sidebarPersonalProjects.push(restored);
    hq208Deleted = restored;
    return structuredClone(restored);
  },
  restoreReconcile: async () => {
    if (!hq208Capture || !hq208Deleted)
      throw new Error("Fixture Project writes are unavailable.");
    return { project: structuredClone(hq208Deleted), released: true };
  }
};

let failInitialProjectsLoad =
  new URLSearchParams(window.location.search).get("projectsFailure") === "once";
let failInitialFirstClassProjectsLoad = failInitialProjectsLoad;

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
    threadId === "hq204-fixture-thread" && hq204Started
      ? [
          {
            id: "hq204-first-user",
            actor: "user",
            eventType: "message",
            timestamp: FIXTURE_TIME,
            sourceEventTime: FIXTURE_TIME,
            sourceSequence: 1,
            content: hq204Trace.firstPrompt,
            contentPreview: hq204Trace.firstPrompt,
            invalidatedAt: null,
            metadata: {}
          }
        ]
      : threadId === "hq103-loose-conversation-91"
        ? [
            {
              id: "hq105-conversation-91-user",
              actor: "user",
              eventType: "message",
              timestamp: FIXTURE_TIME,
              sourceEventTime: FIXTURE_TIME,
              sourceSequence: 1,
              content: "Captured message for Conversation 91.",
              contentPreview: "Captured message for Conversation 91.",
              invalidatedAt: null,
              metadata: {}
            }
          ]
        : threadId === hq104Identity.threadId && hq104SentPrompt
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
  changePersonalProject: (projectId: string, name: string | null) => void;
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
      sidebarPersonalProjects = structuredClone(initialSidebarPersonalProjects);
      operations = { prompts: [], proposals: [], turns: [], mutations: [] };
    },
    changeProjectName: (projectId, name) => {
      const project = data.projects.find(({ id }) => id === projectId);
      if (!project) throw new Error(`Unknown fixture Project: ${projectId}`);
      project.name = name;
      record("mutations", `project-name:${projectId}`);
    },
    changePersonalProject: (projectId, name) => {
      const current = sidebarPersonalProjects.find(
        ({ id }) => id === projectId
      );
      if (!current) throw new Error(`Unknown Personal Project: ${projectId}`);
      const next = {
        ...current,
        version: current.version + 1,
        updatedAt: new Date(
          Date.parse(current.updatedAt) + 1_000
        ).toISOString(),
        ...(name === null
          ? { lifecycle: "deleted" as const, deletedAt: FIXTURE_TIME }
          : { name })
      };
      sidebarPersonalProjects = sidebarPersonalProjects.filter(
        ({ id }) => id !== projectId
      );
      if (name !== null) sidebarPersonalProjects.push(next);
      publishHq105VisibilityUpdate({
        kind: "realtime",
        realtimeUpdate: { type: "project_changed", projectId, project: next }
      });
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
    hq205Sources = structuredClone(hq205InitialSources);
    document.documentElement.dataset.browserValidationReady = "false";
    document.documentElement.dataset.hqFixtureReady = "false";
    const shell = document.querySelector("[data-hq-shell]");
    if (!shell) {
      throw new Error("The real HQ shell scaffold did not mount.");
    }
    fixture.reset();
    hq104SentPrompt = "";
    hq204Started = false;
    Object.assign(hq204Trace, {
      reserve: 0,
      reserveByProject: {},
      start: 0,
      inspect: 0,
      resume: 0,
      send: 0,
      firstPrompt: "",
      nextPrompt: ""
    });
    (
      window as Window & { __koedHq204Trace?: typeof hq204Trace }
    ).__koedHq204Trace = hq204Trace;
    hq104SentMessageId = "";
    hq104Recovery.clear();
    resumedFixtureIdentities.clear();
    hq105VisibilityReads.grants = 0;
    hq105VisibilityReads.shares = 0;
    hq105ShareActive = false;
    (
      window as Window & {
        __koedHqVisibilityReads?: typeof hq105VisibilityReads;
      }
    ).__koedHqVisibilityReads = hq105VisibilityReads;
    (
      window as Window & {
        __koedHqVisibilityFixture?: typeof hq105VisibilityFixture;
      }
    ).__koedHqVisibilityFixture = hq105VisibilityFixture;
    window.__koedHqFixture = fixture;
    document.documentElement.dataset.hqFixtureReady = "true";
    document.documentElement.dataset.browserValidationReady = "true";
    return () => {
      restoreDesktop();
      delete window.__koedHqFixture;
      delete (
        window as Window & {
          __koedHqVisibilityReads?: typeof hq105VisibilityReads;
        }
      ).__koedHqVisibilityReads;
      delete (
        window as Window & {
          __koedHqVisibilityFixture?: typeof hq105VisibilityFixture;
        }
      ).__koedHqVisibilityFixture;
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
      projectsApi={sidebarProjectsApi}
      managedConversations={
        hq204Capture ? hq204ManagedConversations : hq104ManagedConversations
      }
      statusReadyOverride
      teamCollaborationEnabled
    />
  );
}
