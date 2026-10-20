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
import type { Project, ProjectSource, WorkItem } from "@koed/shared";
import type { ManagedConversationDesktopApi } from "./ipc/managed-conversation-protocol.js";
import type {
  CuratedAssertion,
  CuratedMemoryDesktopApi
} from "./ipc/curated-memory-protocol.js";
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
  new URLSearchParams(window.location.search).get("hq204Capture") === "yes" ||
  new URLSearchParams(window.location.search).get("hq306Capture") === "yes";
const hq306Capture =
  new URLSearchParams(window.location.search).get("hq306Capture") === "yes";
const hq306Race =
  new URLSearchParams(window.location.search).get("hq306Race") === "yes";
const hq306Trace = { aliasLookups: 0, detailOpens: 0, raceComplete: false };
const hq205Capture =
  new URLSearchParams(window.location.search).get("hq205Capture") === "yes";
const hq209Capture =
  new URLSearchParams(window.location.search).get("hq209Capture") === "yes";
const hq404Capture =
  new URLSearchParams(window.location.search).get("hq404Capture") === "yes";
const hq403Capture =
  new URLSearchParams(window.location.search).get("hq403Capture") === "yes" ||
  hq404Capture;
const hq106Capture =
  new URLSearchParams(window.location.search).get("hq106Capture") === "yes";
const hq106Pending = new Map<string, string>();
const hq106Deleted = new Map<string, string>();
const hq106Forgotten = new Map<string, string>();
const hq207Capture =
  new URLSearchParams(window.location.search).get("hq207Capture") === "yes" ||
  hq209Capture ||
  hq403Capture ||
  new URLSearchParams(window.location.search).get("hq304Capture") === "yes";
const hq304Capture =
  new URLSearchParams(window.location.search).get("hq304Capture") === "yes";
const hq304OwnerId = "00000000-0000-4000-8000-000000000109";
const hq304Ids = [
  "00000000-0000-4000-8000-000000003041",
  "00000000-0000-4000-8000-000000003042",
  "00000000-0000-4000-8000-000000003043"
];
const hq304Row = (
  id: string,
  scope: "project" | "me" | "unscoped",
  kind: "decision" | "fact" | "learning" | "preference",
  text: string
): CuratedAssertion => ({
  id,
  ownerUserId: hq304OwnerId,
  visibility: "personal",
  scope,
  projectId:
    scope === "project" ? "00000000-0000-4000-8000-000000002038" : null,
  kind,
  authorKind: "user",
  authorRef: hq304OwnerId,
  classificationVersion: 1,
  assertionText: text,
  status: "current",
  createdAt: FIXTURE_TIME,
  observedAt: FIXTURE_TIME,
  updatedAt: FIXTURE_TIME,
  suppressionToken: null,
  sources: [
    {
      id: crypto.randomUUID(),
      sourceType: "conversation_item",
      sourceRole: "primary_evidence",
      metadata: { title: "Project planning chat" },
      createdAt: FIXTURE_TIME
    }
  ],
  replaces:
    id === hq304Ids[0]
      ? [
          {
            id: crypto.randomUUID(),
            text: "Use the old launch plan",
            author: { kind: "user", ref: hq304OwnerId },
            at: "2026-10-18T09:00:00.000Z"
          }
        ]
      : []
});
let hq304Rows = [
  hq304Row(
    hq304Ids[0]!,
    "project",
    "decision",
    "Ship the smaller launch first"
  ),
  hq304Row(hq304Ids[1]!, "me", "preference", "Prefer concise updates"),
  hq304Row(hq304Ids[2]!, "unscoped", "fact", "The legacy note needs a home")
];
const hq304MemoryApi: CuratedMemoryDesktopApi = {
  page: async (scope, projectId) => ({
    assertions: await hq304MemoryApi.list(scope, projectId),
    nextCursor: null
  }),
  list: async (scope, projectId) =>
    structuredClone(
      hq304Rows.filter(
        (row) =>
          row.scope === scope &&
          (scope !== "project" || row.projectId === projectId) &&
          row.status === "current"
      )
    ),
  detail: async (id) =>
    structuredClone(hq304Rows.find((row) => row.id === id)!),
  forget: async (id) => {
    const row = hq304Rows.find((item) => item.id === id)!;
    row.status = "suppressed";
    row.suppressionToken = "1792490400123456";
    return structuredClone(row);
  },
  undo: async (id, token) => {
    const row = hq304Rows.find((item) => item.id === id)!;
    if (row.suppressionToken !== token) throw new Error("Invalid Undo token");
    row.status = "current";
    row.suppressionToken = null;
    return structuredClone(row);
  },
  move: async (id, scope, version, projectId) => {
    const row = hq304Rows.find((item) => item.id === id)!;
    if (row.scope !== "unscoped" || row.classificationVersion !== version)
      throw new Error("Classification changed");
    row.scope = scope;
    row.projectId = scope === "project" ? projectId! : null;
    row.classificationVersion++;
    return { assertion: structuredClone(row), pending: false };
  }
};
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
let hq205Sources: ProjectSource[] = structuredClone(hq205InitialSources);
const hq204ProjectId = "00000000-0000-4000-8000-000000002038";
const hq207RuntimeExecutionIds = Array.from(
  { length: 5 },
  (_, index) =>
    `00000000-0000-4000-8000-${String(2078 + index).padStart(12, "0")}`
);
const hq207OtherExecutionId = "00000000-0000-4000-8000-000000002083";
const hq207TerminalExecutionId = "00000000-0000-4000-8000-000000002084";
const hq204ExecutionId = "00000000-0000-4000-8000-000000002044";
const hq204SessionId = "00000000-0000-4000-8000-000000002045";
const hq306Citations = [
  {
    alias: "r11111111111141118111111111111111c1",
    providerTurnId: "hq306-turn-1",
    sourceType: "curated_memory" as const,
    sourceId: "00000000-0000-4000-8000-000000003061",
    visibility: "personal" as const,
    detailAvailable: true,
    title: "Chat · Plan my week",
    summary: null
  },
  {
    alias: "r22222222222242228222222222222222c1",
    providerTurnId: "hq306-turn-1",
    sourceType: "memory_node" as const,
    sourceId: "00000000-0000-4000-8000-000000003062",
    visibility: "personal" as const,
    detailAvailable: true,
    title: "Deck outline.md",
    summary: null
  }
];
const hq306Answer = `Here's a draft. Nothing before 9am, as you prefer [m:${hq306Citations[0]!.alias}].\n\n- **Mon** · deep work on koed-main, 9:30–12:30\n- **Tue** · investor calls from 10:00\n- **Wed** · sync with Mark, 11:00\n- **Thu** · deck review with Sam, 14:00 (lead with the memory story [m:${hq306Citations[1]!.alias}])\n- **Fri** · weekly review, 16:30\n\nWant me to send the invites?`;
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
    ...(hq304Capture ? { curatedMemory: hq304MemoryApi } : {}),
    ...(hq106Capture ? { personalMemory: sidebarPersonalMemoryApi } : {}),
    ...(hq204Capture || hq205Capture || hq207Capture
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
              },
              ...(hq404Capture
                ? [
                    {
                      id: "00000000-0000-4000-8000-000000004041",
                      ownerUserId: "00000000-0000-4000-8000-000000000109",
                      name: "Quinn",
                      role: "Builder",
                      look: {},
                      aiClientInstanceId: "codex.fixture",
                      defaultPermissionMode: "supervised" as const,
                      defaultModel: "gpt-fixture",
                      isChiefOfStaff: false,
                      createdAt: FIXTURE_TIME
                    }
                  ]
                : [])
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
      hq306Race && executionId === hq204ExecutionId
        ? {
            id: "hq306-race-command",
            sequence: 1,
            executionGeneration: 1,
            commandKind: "prompt",
            clientUserMessageId: null,
            state: hq306Trace.raceComplete ? "completed" : "dispatching",
            lastErrorCode: null,
            updatedAt: hq306Trace.raceComplete
              ? "2026-10-19T09:00:01.000Z"
              : FIXTURE_TIME
          }
        : executionId === hq104Identity.executionId && hq104SentMessageId
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
  ...(hq306Capture
    ? {
        turnCitations: async (
          executionId: string,
          providerTurnId: string,
          aliases?: string[]
        ) => {
          if (aliases?.length) {
            hq306Trace.aliasLookups++;
            if (hq306Race && hq306Trace.aliasLookups === 1) {
              window.setTimeout(() => {
                hq306Trace.raceComplete = true;
              }, 100);
              return {
                operation: "turn_citations" as const,
                executionId,
                providerTurnId,
                citations: []
              };
            }
          }
          return {
            operation: "turn_citations" as const,
            executionId,
            providerTurnId,
            citations: hq306Citations.filter((citation) =>
              aliases?.includes(citation.alias)
            )
          };
        },
        citationDetail: async (
          executionId: string,
          providerTurnId: string,
          alias: string
        ) => {
          hq306Trace.detailOpens++;
          return {
            operation: "citation_detail" as const,
            executionId,
            providerTurnId,
            alias,
            citation: hq306Citations.find(
              (citation) => citation.alias === alias
            )
              ? {
                  ...hq306Citations.find(
                    (citation) => citation.alias === alias
                  )!,
                  title:
                    alias === hq306Citations[0]!.alias
                      ? "Never book meetings before 9am."
                      : "Deck outline",
                  kind:
                    alias === hq306Citations[0]!.alias ? "preference" : null,
                  provenance:
                    alias === hq306Citations[0]!.alias
                      ? "Chat · Plan my week · You · 9d ago"
                      : "Your memory summary",
                  replaces: null,
                  messageLink: null
                }
              : null
          };
        }
      }
    : {}),
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
const hq207ManagedConversations = {
  ...hq204ManagedConversations,
  list: async () => ({
    operation: "list" as const,
    complete: true,
    executions: [
      ...(hq404Capture &&
      hq403Items.some(
        (item) => item.executionId === "00000000-0000-4000-8000-000000004404"
      )
        ? [
            {
              executionId: "00000000-0000-4000-8000-000000004404",
              projectId: hq204ProjectId,
              sessionId: hq204SessionId,
              threadId: "hq404-fixture-thread",
              state: "running" as const
            }
          ]
        : []),
      ...hq207RuntimeExecutionIds.map((executionId) => ({
        executionId,
        projectId: hq204ProjectId,
        sessionId: null,
        threadId: null,
        state: "running"
      })),
      {
        executionId: hq207OtherExecutionId,
        projectId: hq205ProjectId,
        sessionId: null,
        threadId: null,
        state: "running"
      },
      {
        executionId: hq207TerminalExecutionId,
        projectId: hq204ProjectId,
        sessionId: null,
        threadId: null,
        state: "stopped"
      }
    ]
  }),
  runtime: async (executionId: string) => {
    return {
      ...(await hq204ManagedConversations.runtime(executionId)),
      items:
        hq404Capture && executionId === "00000000-0000-4000-8000-000000004404"
          ? [
              {
                id: `${executionId}-step`,
                executionGeneration: 1,
                providerTurnId: "fixture-turn",
                providerItemId: "fixture-step",
                itemKind: "transient_output" as const,
                presentation: {
                  mode: "status" as const,
                  renderer: "message" as const,
                  policyKey: "hq404-fixture",
                  policyRevision: 1,
                  reason: "Agent update"
                },
                state: "answered" as const,
                payload: {
                  text: "Read the Work Item goal and Project Sources"
                },
                revision: 1,
                createdAt: FIXTURE_TIME,
                updatedAt: FIXTURE_TIME,
                answered: true
              }
            ]
          : hq207RuntimeExecutionIds.includes(executionId)
            ? [
                {
                  id: `${executionId}-approval`,
                  executionGeneration: 1,
                  providerTurnId: null,
                  providerItemId: null,
                  itemKind: "command_approval" as const,
                  presentation: {
                    mode: "expanded" as const,
                    renderer: "approval" as const,
                    policyKey: "hq207-fixture",
                    policyRevision: 1,
                    reason: "Pending"
                  },
                  state: "pending" as const,
                  payload: { command: ["review", "Project plan"] },
                  revision: 1,
                  createdAt: FIXTURE_TIME,
                  updatedAt: FIXTURE_TIME,
                  answered: false
                }
              ]
            : []
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
      ...(hq404Capture && id === "hq103-work"
        ? [
            {
              ...sidebarConversation(id, name, 404),
              id: "hq404-fixture-thread",
              sessionId: hq204SessionId,
              name: "Tidy the Project brief"
            }
          ]
        : []),
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
  },
  ...(hq306Capture
    ? [
        {
          eventCount: 2,
          id: hq204ProjectId,
          name: "New empty Project",
          path: null,
          threads: [
            {
              ...sidebarConversation(hq204ProjectId, "New empty Project", 204),
              id: "hq204-fixture-thread",
              sessionId: hq204SessionId,
              personalProjectId: hq204ProjectId,
              name: "Plan next week"
            }
          ]
        }
      ]
    : [])
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
if (hq203Empty || hq204Capture || hq207Capture)
  initialSidebarPersonalProjects.push({
    ...sidebarProjectRecord(hq204ProjectId, "New empty Project"),
    folderPath: hq207Capture ? "/fixtures/koed" : null
  });
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
const hq403Seed = (
  id: string,
  title: string,
  status: WorkItem["status"],
  dueOn: string | null = null
): WorkItem => ({
  id,
  projectId: hq204ProjectId,
  kind: "todo",
  key: null,
  title,
  goal: title,
  origin: "manual",
  originRef: null,
  idempotencyKey: null,
  status,
  blockedReason:
    status === "blocked"
      ? "The Conversation stopped before completing this item."
      : null,
  assigneeAgentId: null,
  executionId: null,
  dispatchKey: null,
  prProvider: null,
  prNumber: null,
  prUrl: null,
  prState: null,
  dueOn,
  doneAt: status === "done" ? "2026-10-20T09:00:00.000Z" : null,
  doneBy: null,
  createdBy: hq205SourceOwnerId,
  createdAt: "2026-10-19T09:00:00.000Z",
  updatedAt: "2026-10-20T09:00:00.000Z",
  version: 1
});
let hq403Items: WorkItem[] = [
  hq403Seed(
    "00000000-0000-4000-8000-000000004031",
    "Review release notes",
    "todo",
    "2026-10-20"
  ),
  hq403Seed(
    "00000000-0000-4000-8000-000000004032",
    "Tidy the Project brief",
    "todo"
  ),
  hq403Seed("00000000-0000-4000-8000-000000004036", "Check the budget", "todo"),
  hq403Seed(
    "00000000-0000-4000-8000-000000004037",
    "Draft the announcement",
    "todo"
  ),
  hq403Seed(
    "00000000-0000-4000-8000-000000004038",
    "Confirm the venue",
    "todo"
  ),
  hq403Seed("00000000-0000-4000-8000-000000004039", "Update the FAQ", "todo"),
  hq403Seed("00000000-0000-4000-8000-000000004040", "Book the review", "todo"),
  hq403Seed(
    "00000000-0000-4000-8000-000000004033",
    "Check the launch copy",
    "doing"
  ),
  hq403Seed(
    "00000000-0000-4000-8000-000000004034",
    "Fix the build failure",
    "blocked"
  ),
  hq403Seed(
    "00000000-0000-4000-8000-000000004035",
    "Update the outline",
    "done"
  ),
  {
    ...hq403Seed(
      "00000000-0000-4000-8000-000000004041",
      "Review the release PR",
      "review"
    ),
    prProvider: "GitHub",
    prNumber: 42,
    prUrl: "https://github.com/koed-labs/koed/pull/42",
    prState: "open"
  }
];
let hq404ExecutionStarts = 0;
Object.defineProperty(window, "__hq404ExecutionStarts", {
  configurable: true,
  get: () => hq404ExecutionStarts
});
const sidebarProjectsApi = {
  workItemList: async (projectId: string) =>
    hq403Capture && projectId === hq204ProjectId
      ? structuredClone(hq403Items)
      : [],
  workItemCreate: async (
    projectId: string,
    value: { title: string; goal: string; dueOn?: string | null }
  ) => {
    if (!hq403Capture || projectId !== hq204ProjectId)
      throw new Error("Work Items unavailable.");
    const item = {
      ...hq403Seed(
        crypto.randomUUID(),
        value.title,
        "todo",
        value.dueOn ?? null
      ),
      goal: value.goal
    };
    hq403Items = [item, ...hq403Items];
    return structuredClone(item);
  },
  workItemPatch: async (
    projectId: string,
    itemId: string,
    value: { version: number; action?: "mark_done" | "back_to_todo" | "untick" }
  ) => {
    const item = hq403Items.find(
      (row) => row.id === itemId && row.projectId === projectId
    );
    if (!hq403Capture || !item || item.version !== value.version)
      throw new Error("Work Item changed.");
    const updated: WorkItem = {
      ...item,
      status: value.action === "mark_done" ? "done" : "todo",
      doneAt: value.action === "mark_done" ? new Date().toISOString() : null,
      version: item.version + 1,
      updatedAt: new Date().toISOString()
    };
    hq403Items = hq403Items.map((row) => (row.id === itemId ? updated : row));
    return structuredClone(updated);
  },
  workItemDispatch: async (
    projectId: string,
    itemId: string,
    agentId: string,
    version: number
  ) => {
    const item = hq403Items.find(
      (row) => row.id === itemId && row.projectId === projectId
    );
    if (!hq404Capture || !item || item.version !== version)
      throw new Error("Work Item changed.");
    if (item.executionId)
      return {
        item: structuredClone(item),
        executionId: item.executionId,
        reused: true
      };
    hq404ExecutionStarts += 1;
    const executionId = "00000000-0000-4000-8000-000000004404";
    const updated: WorkItem = {
      ...item,
      status: "doing",
      assigneeAgentId: agentId,
      executionId,
      dispatchKey: `${item.id}:${item.version}`,
      version: item.version + 1,
      updatedAt: new Date().toISOString()
    };
    hq403Items = hq403Items.map((row) => (row.id === itemId ? updated : row));
    return { item: structuredClone(updated), executionId, reused: false };
  },
  sourceList: async (projectId: string) =>
    (hq205Capture && projectId === hq205ProjectId) ||
    (hq207Capture && projectId === hq204ProjectId)
      ? structuredClone(hq205Sources).map((source) => ({
          ...source,
          projectId
        }))
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
  sourceUpload: async (projectId: string) => {
    if (!hq209Capture || projectId !== hq204ProjectId)
      throw new Error("Document upload is unavailable in this fixture.");
    const source = {
      ...hq205InitialSources[1]!,
      projectId,
      id: "00000000-0000-4000-8000-000000002095",
      name: "Field report.txt",
      currentRevisionId: "00000000-0000-4000-8000-000000002096"
    };
    if (!hq205Sources.some((item) => item.id === source.id))
      hq205Sources.unshift(source);
    return source;
  },
  sourceRead: async (
    projectId: string,
    sourceId: string,
    noteRevisionId: string
  ) => {
    if (!hq209Capture || projectId !== hq204ProjectId)
      throw new Error("Document read is unavailable in this fixture.");
    const source = hq205Sources.find((item) => item.id === sourceId);
    if (!source || source.currentRevisionId !== noteRevisionId)
      throw new Error("Document revision changed.");
    return {
      sourceId,
      noteRevisionId,
      name: source.name,
      noteId: "00000000-0000-4000-8000-000000002097",
      sourceRevisionId:
        sourceId === "00000000-0000-4000-8000-000000002095"
          ? "00000000-0000-4000-8000-000000002098"
          : "00000000-0000-4000-8000-000000002099",
      text:
        sourceId === "00000000-0000-4000-8000-000000002095"
          ? "Field report: the review owner is Maya; the next checkpoint is Friday."
          : "Plan: review the Project goals and choose the next task."
    };
  },
  sourceRemoval: async (projectId: string, sourceId: string) => {
    if (!hq209Capture || projectId !== hq204ProjectId)
      throw new Error("Source removal is unavailable in this fixture.");
    hq205Sources = hq205Sources.filter((item) => item.id !== sourceId);
    return {
      batchId: "00000000-0000-4000-8000-000000002094",
      state: "complete" as const,
      complete: true,
      retryable: false,
      pendingFreezeCount: 0,
      pendingReviews: [],
      cancellationPending: false
    };
  },
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
  hq: async (projectId: string) => {
    if (!hq207Capture || projectId !== hq204ProjectId)
      throw new Error("HQ Project activity is unavailable in this fixture.");
    const project = sidebarPersonalProjects.find(
      (item) => item.id === projectId
    );
    if (!project) throw new Error("Project unavailable.");
    const counts = [1, 2, 0, 3, 1, 1, 2];
    const completedOrMerged = [0, 1, 0, 1, 1, 0, 2];
    return {
      project: structuredClone(project),
      activity: {
        lastSevenDays: {
          days: counts.map((count, index) => ({
            date: `2026-10-${String(14 + index).padStart(2, "0")}`,
            count
          })),
          total: counts.reduce((sum, count) => sum + count, 0),
          outcomes: {
            days: completedOrMerged.map((count, index) => ({
              date: `2026-10-${String(14 + index).padStart(2, "0")}`,
              count
            })),
            done: 3,
            merged: 2
          }
        }
      },
      sections: {
        conversations: { availability: "available" as const, count: 1 },
        workItems: { availability: "not_implemented" as const },
        sources: { availability: "available" as const, count: 3 },
        decks: { availability: "not_implemented" as const },
        scheduledJobs: { availability: "not_implemented" as const }
      }
    };
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
    return structuredClone(sidebarProjectGroups).map((group) => ({
      ...group,
      threads: group.threads.filter(
        (thread) =>
          !hq106Deleted.has(thread.sessionId ?? "") &&
          !hq106Forgotten.has(thread.sessionId ?? "")
      )
    }));
  },
  ...(hq106Capture
    ? {
        trashSession: async ({
          sessionId,
          batchId
        }: {
          sessionId: string;
          batchId: string;
        }) => {
          hq106Pending.set(sessionId, batchId);
          return {
            sessionId,
            batchId,
            state: "freezing",
            complete: false,
            pending: true,
            pendingReviews: []
          };
        },
        progressSessionDeletion: async ({
          sessionId,
          batchId
        }: {
          sessionId: string;
          batchId: string;
        }) => {
          if (hq106Pending.get(sessionId) !== batchId)
            throw new Error("Fixture deletion batch changed");
          hq106Pending.delete(sessionId);
          hq106Deleted.set(sessionId, batchId);
          return {
            sessionId,
            batchId,
            state: "complete",
            complete: true,
            pending: false,
            pendingReviews: []
          };
        },
        listPendingSessionDeletions: async () =>
          [...hq106Pending].map(([sessionId, batchId]) => ({
            sessionId,
            batchId,
            state: "freezing",
            complete: false,
            pending: true,
            pendingReviews: []
          })),
        listDeletedSessions: async () => ({
          sessions: [...hq106Deleted].map(([sessionId, batchId]) => ({
            sessionId,
            batchId,
            title: "Conversation " + Number(sessionId.slice(-2)),
            trashedAt: FIXTURE_TIME
          })),
          nextCursor: null
        }),
        restoreSession: async ({
          sessionId,
          batchId
        }: {
          sessionId: string;
          batchId?: string;
        }) => {
          if (hq106Deleted.get(sessionId) !== batchId)
            throw new Error("Fixture restore batch changed");
          hq106Deleted.delete(sessionId);
        },
        forgetSession: async ({
          sessionId,
          batchId
        }: {
          sessionId: string;
          batchId: string;
        }) => {
          hq106Forgotten.set(sessionId, batchId);
          return {
            pending: false as const,
            batchId,
            forgottenAt: FIXTURE_TIME,
            suppressedAssertionIds: []
          };
        },
        undoForgetSession: async ({
          sessionId,
          batchId
        }: {
          sessionId: string;
          batchId: string;
        }) => {
          if (hq106Forgotten.get(sessionId) !== batchId)
            throw new Error("Fixture Forget batch changed");
          hq106Forgotten.delete(sessionId);
        },
        listPendingSessionForgets: async () => []
      }
    : {}),
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
          },
          ...(hq306Capture
            ? [
                {
                  id: "hq306-captured-assistant",
                  actor: "assistant" as const,
                  eventType: "message" as const,
                  timestamp: FIXTURE_TIME,
                  sourceEventTime: FIXTURE_TIME,
                  sourceSequence: 2,
                  content: hq306Answer,
                  contentPreview: "Here's a draft. Nothing before 9am",
                  invalidatedAt: null,
                  // Claude/Pi captured history need not carry worker turn IDs.
                  metadata: {}
                }
              ]
            : hq207Capture
              ? [
                  {
                    id: "hq207-plan-answer",
                    actor: "assistant" as const,
                    eventType: "message" as const,
                    timestamp: FIXTURE_TIME,
                    sourceEventTime: FIXTURE_TIME,
                    sourceSequence: 2,
                    content:
                      "For Plan.md, review the goals and choose the next task.",
                    contentPreview:
                      "For Plan.md, review the goals and choose the next task.",
                    invalidatedAt: null,
                    metadata: {}
                  }
                ]
              : [])
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
    hq106Pending.clear();
    hq106Deleted.clear();
    hq106Forgotten.clear();
    hq205Sources = structuredClone(hq205InitialSources);
    hq304Rows = [
      hq304Row(
        hq304Ids[0]!,
        "project",
        "decision",
        "Ship the smaller launch first"
      ),
      hq304Row(hq304Ids[1]!, "me", "preference", "Prefer concise updates"),
      hq304Row(hq304Ids[2]!, "unscoped", "fact", "The legacy note needs a home")
    ];
    document.documentElement.dataset.browserValidationReady = "false";
    document.documentElement.dataset.hqFixtureReady = "false";
    const shell = document.querySelector("[data-hq-shell]");
    if (!shell) {
      throw new Error("The real HQ shell scaffold did not mount.");
    }
    fixture.reset();
    hq104SentPrompt = "";
    hq204Started = hq306Capture;
    Object.assign(hq204Trace, {
      reserve: 0,
      reserveByProject: {},
      start: 0,
      inspect: 0,
      resume: 0,
      send: 0,
      firstPrompt: hq306Capture
        ? "Plan next week around the investor meetings"
        : "",
      nextPrompt: ""
    });
    (
      window as Window & { __koedHq204Trace?: typeof hq204Trace }
    ).__koedHq204Trace = hq204Trace;
    hq306Trace.aliasLookups = 0;
    hq306Trace.detailOpens = 0;
    hq306Trace.raceComplete = false;
    (
      window as Window & { __koedHq306Trace?: typeof hq306Trace }
    ).__koedHq306Trace = hq306Trace;
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
      delete (window as Window & { __koedHq306Trace?: typeof hq306Trace })
        .__koedHq306Trace;
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
        hq207Capture
          ? hq207ManagedConversations
          : hq204Capture
            ? hq204ManagedConversations
            : hq104ManagedConversations
      }
      statusReadyOverride
      teamCollaborationEnabled
    />
  );
}
