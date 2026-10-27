import { describe, expect, it, vi } from "vitest";
import type { Agent } from "@koed/shared/agent-contract";
import type {
  ManagedConversationRequest,
  ManagedConversationRuntimeItem
} from "../ipc/managed-conversation-protocol.js";
import {
  createPhoneGatewayService,
  isRiskyApproval,
  type PhoneGatewayDeps
} from "./service.js";
import { createGamificationStore } from "./gamification.js";
import { createPhoneGatewayStore } from "./store.js";

const chief: Agent = {
  id: "11111111-1111-4111-8111-111111111111",
  ownerUserId: "22222222-2222-4222-8222-222222222222",
  name: "Cooper",
  role: "Chief of staff",
  look: { seed: "cooper" },
  aiClientInstanceId: "claude.default",
  defaultPermissionMode: "supervised",
  defaultModel: "opus",
  isChiefOfStaff: true,
  createdAt: "2026-10-01T09:00:00.000Z"
};

const item = (
  overrides: Partial<ManagedConversationRuntimeItem>
): ManagedConversationRuntimeItem => ({
  id: "item-1",
  executionGeneration: 3,
  providerTurnId: "turn-1",
  providerItemId: null,
  itemKind: "command_approval",
  presentation: {
    mode: "expanded",
    renderer: "approval",
    policyKey: "k",
    policyRevision: 1,
    reason: "r"
  },
  state: "pending",
  payload: {
    command: ["git", "push", "origin", "main"],
    cwd: "/work",
    reason: "Publish the fix"
  },
  revision: 1,
  createdAt: "2026-10-27T10:00:00.000Z",
  updatedAt: "2026-10-27T10:00:00.000Z",
  answered: false,
  ...overrides
});

const memorySecrets = () => {
  const values = new Map<string, string>();
  return {
    get: async (reference: string) => values.get(reference) ?? null,
    put: async (reference: string, value: string) =>
      void values.set(reference, value),
    delete: async (reference: string) => void values.delete(reference)
  };
};

const setup = (
  runtimeItems: ManagedConversationRuntimeItem[] = [],
  overrides: Partial<PhoneGatewayDeps> = {}
) => {
  const calls: ManagedConversationRequest[] = [];
  const managedConversation = vi.fn(
    async (request: ManagedConversationRequest) => {
      calls.push(request);
      switch (request.operation) {
        case "list":
          return {
            operation: "list",
            complete: true,
            executions: [
              {
                executionId: "exec-1",
                projectId: "lp_1",
                sessionId: "sess-1",
                threadId: "thread-1",
                state: "running"
              }
            ]
          };
        case "runtime":
          return {
            operation: "runtime",
            executionId: request.executionId,
            executionGeneration: 3,
            executionStateVersion: 1,
            executionState: "running",
            executionLastErrorCode: null,
            latestCommand: {
              id: "c",
              sequence: 1,
              executionGeneration: 3,
              commandKind: "prompt",
              clientUserMessageId: null,
              state: "dispatching",
              lastErrorCode: null,
              updatedAt: "2026-10-27T10:00:00.000Z"
            },
            items: runtimeItems
          };
        case "launch_options":
          return {
            operation: "launch_options",
            options: {
              runners: [],
              instances: [
                {
                  instanceId: "claude.default",
                  driverId: "claude",
                  displayName: "Claude Code",
                  ready: true,
                  readiness: "ready",
                  models: [
                    {
                      id: "claude-opus",
                      model: "opus",
                      supportedReasoningEfforts: ["medium"],
                      defaultReasoningEffort: "medium"
                    }
                  ],
                  capabilities: {
                    defaultPermissionMode: "auto_edit",
                    permissionModes: [
                      { mode: "supervised", support: "supported" }
                    ]
                  }
                }
              ]
            }
          };
        case "start":
          return {
            operation: "start",
            status: "starting",
            executionId: "exec-new"
          };
        case "inspect":
          return {
            operation: "inspect",
            status: "ready",
            executionId: request.executionId,
            conversation: {
              executionId: "exec-new",
              projectId: "lp_chats",
              capturedSessionId: "sess-new",
              threadId: "thread-new"
            }
          };
        case "send":
          return {
            operation: "send",
            status: "queued",
            conversation: {
              executionId: request.executionId,
              projectId: "lp_chats",
              capturedSessionId: request.capturedSessionId,
              threadId: request.threadId
            },
            idempotencyKey: request.idempotencyKey,
            clientUserMessageId: request.clientUserMessageId
          };
        case "runtime_respond":
          return {
            operation: "runtime_respond",
            accepted: true,
            itemId: request.itemId
          };
        default:
          throw new Error(`unexpected ${request.operation}`);
      }
    }
  );
  const deps: PhoneGatewayDeps = {
    macName: () => "Studio",
    agents: async (request) =>
      (request.operation === "list"
        ? { operation: "list", agents: [chief] }
        : { operation: "ensureChief", agent: chief }) as never,
    managedConversation: managedConversation as never,
    personalMemory: async (request) => {
      if (request.operation === "personal.projects.list")
        return {
          contractVersion: 8,
          operation: request.operation,
          ok: true,
          data: {
            projects: [
              {
                id: "lp_1",
                name: "koed",
                path: null,
                eventCount: 2,
                threads: [
                  {
                    id: "thread-1",
                    name: "Fix the webhook",
                    sessionId: "sess-1",
                    sourceAiClient: "claude-code",
                    projectId: "lp_1",
                    projectName: "koed",
                    projectPath: null,
                    projectAssignmentSource: null,
                    eventCount: 2,
                    invalidatedCount: 0,
                    latestAt: "2026-10-27T10:00:00.000Z",
                    sample: "",
                    presentation: null
                  }
                ]
              }
            ]
          }
        } as never;
      if (request.operation === "personal.events.load_page")
        return {
          contractVersion: 8,
          operation: request.operation,
          ok: true,
          data: {
            events: [
              {
                id: "e1",
                actor: "user",
                eventType: "message",
                timestamp: "2026-10-27T09:59:00.000Z",
                sourceEventTime: null,
                sourceSequence: 1,
                content: "Fix the webhook",
                contentPreview: "Fix the webhook",
                invalidatedAt: null,
                metadata: {}
              },
              {
                id: "e2",
                actor: "assistant",
                eventType: "message",
                timestamp: "2026-10-27T10:00:00.000Z",
                sourceEventTime: null,
                sourceSequence: 2,
                content: "On it.",
                contentPreview: "On it.",
                invalidatedAt: null,
                metadata: { providerTurnId: "turn-1" }
              }
            ]
          }
        } as never;
      throw new Error(`unexpected ${request.operation}`);
    },
    scheduledJobs: async (request) => {
      if (request.operation === "list")
        return {
          operation: "list",
          nextCursor: null,
          jobs: [
            {
              id: "33333333-3333-4333-8333-333333333333",
              ownerUserId: chief.ownerUserId,
              projectId: null,
              agentId: chief.id,
              conversationSessionId: "44444444-4444-4444-8444-444444444444",
              title: "Morning brief",
              instruction: "Summarise",
              schedule: { kind: "daily", at: "07:30", tz: "Europe/Oslo" },
              paused: false,
              pausedReason: null,
              runnerDeviceId: "55555555-5555-4555-8555-555555555555",
              version: 2,
              createdAt: "",
              updatedAt: ""
            }
          ]
        };
      if (request.operation === "runs")
        return {
          operation: "runs",
          jobId: request.jobId,
          nextCursor: null,
          runs: [
            {
              id: "66666666-6666-4666-8666-666666666666",
              jobId: request.jobId,
              scheduledFor: "2026-10-27T06:30:00.000Z",
              trigger: "scheduled",
              attempt: 0,
              status: "missed",
              skipReason: null,
              startedAt: null,
              finishedAt: null,
              executionId: null,
              error: null
            }
          ]
        };
      throw new Error(`unexpected ${request.operation}`);
    },
    localAiClients: async () =>
      ({
        operation: "list",
        readModel: {
          instances: [
            {
              instanceId: "claude.default",
              driverId: "claude",
              displayName: "Claude Code",
              enabled: true
            }
          ],
          capabilitySnapshots: [],
          settings: [],
          defaults: {}
        }
      }) as never,
    ensureIndependentProject: async () => ({ localProjectId: "lp_chats" }),
    now: () => new Date("2026-10-27T10:00:30.000Z"),
    sleep: async () => undefined,
    ...overrides
  };
  const store = createPhoneGatewayStore(memorySecrets());
  return { service: createPhoneGatewayService(deps, store), store, calls };
};

describe("phone gateway service", () => {
  it("marks pushes, merges, deletes and permission changes as risky", () => {
    expect(isRiskyApproval(item({}))).toBe(true);
    expect(isRiskyApproval(item({ payload: { command: "pnpm test" } }))).toBe(
      false
    );
    expect(
      isRiskyApproval(item({ payload: { command: "rm -rf build" } }))
    ).toBe(true);
    expect(
      isRiskyApproval(item({ itemKind: "permissions_approval", payload: {} }))
    ).toBe(true);
    expect(
      isRiskyApproval(item({ itemKind: "file_approval", payload: {} }))
    ).toBe(false);
  });

  it("builds home from agents, pending runtime items and missed job runs", async () => {
    const { service } = setup([
      item({}),
      item({
        id: "q-1",
        itemKind: "user_input",
        presentation: {
          mode: "expanded",
          renderer: "user_input",
          policyKey: "k",
          policyRevision: 1,
          reason: "r"
        },
        payload: {
          questions: [
            {
              id: "which",
              header: "Which branch?",
              options: [{ label: "main" }, { label: "release" }]
            }
          ]
        }
      })
    ]);
    const home = await service.home();
    expect(home.chief?.name).toBe("Cooper");
    expect(home.mac.name).toBe("Studio");
    const approval = home.needs.find((need) => need.kind === "approval");
    expect(approval && approval.kind === "approval" && approval.risky).toBe(
      true
    );
    expect(approval && approval.kind === "approval" && approval.command).toBe(
      "git push origin main"
    );
    expect(
      approval && approval.kind === "approval" && approval.conversation?.title
    ).toBe("Fix the webhook");
    const question = home.needs.find((need) => need.kind === "question");
    expect(
      question &&
        question.kind === "question" &&
        question.questions[0]?.options.map((option) => option.label)
    ).toEqual(["main", "release"]);
    expect(home.needs.some((need) => need.kind === "missed")).toBe(true);
    expect(home.working).toHaveLength(1);
    expect(home.upcoming[0]?.title).toBe("Morning brief");
  });

  it("starts the Chief's Chat on its own AI Client, then delivers the message once", async () => {
    const { service, store, calls } = setup();
    const result = await service.sendToChief(
      "What's on today?",
      "77777777-7777-4777-8777-777777777777"
    );
    expect(result.accepted).toBe(true);
    await vi.waitFor(() =>
      expect(calls.some((call) => call.operation === "send")).toBe(true)
    );
    const start = calls.find((call) => call.operation === "start");
    expect(start).toMatchObject({
      projectId: "lp_chats",
      contextKind: "independent",
      aiClientInstanceId: "claude.default",
      model: "claude-opus",
      permissionMode: "supervised",
      runnerKind: "local_device"
    });
    const send = calls.find((call) => call.operation === "send");
    expect(send).toMatchObject({
      executionId: "exec-new",
      capturedSessionId: "sess-new",
      threadId: "thread-new",
      prompt: "What's on today?",
      idempotencyKey: "koed-phone:77777777-7777-4777-8777-777777777777"
    });
    expect((await store.read()).chiefConversation).toMatchObject({
      projectId: "lp_chats",
      threadId: "thread-new",
      agentId: chief.id
    });
  });

  it("answers an approval with the person's decision", async () => {
    const { service, calls } = setup();
    await service.respond({
      executionId: "exec-1",
      itemId: "item-1",
      executionGeneration: 3,
      itemKind: "command_approval",
      decision: "accept"
    });
    expect(calls.at(-1)).toEqual({
      operation: "runtime_respond",
      executionId: "exec-1",
      itemId: "item-1",
      itemKind: "command_approval",
      executionGeneration: 3,
      decision: "accept"
    });
  });

  it("reads a conversation's transcript and shows the live text of a turn in progress", async () => {
    const { service } = setup([
      item({
        id: "live",
        itemKind: "transient_output",
        presentation: {
          mode: "expanded",
          renderer: "message",
          policyKey: "k",
          policyRevision: 1,
          reason: "r"
        },
        payload: { text: "Checking the retries" }
      })
    ]);
    const timeline = await service.conversationTimeline("lp_1", "thread-1");
    expect(timeline.events.map((event) => [event.role, event.text])).toEqual([
      ["user", "Fix the webhook"],
      ["assistant", "On it."]
    ]);
    expect(timeline.execution?.busy).toBe(true);
    expect(timeline.streaming).toBe("Checking the retries");
  });

  it("shows a job the Chief proposed, and schedules it exactly once on approval", async () => {
    const actionId = "88888888-8888-4888-8888-888888888888";
    let state: "awaiting_review" | "ready" | "claimed" | "applied" =
      "awaiting_review";
    let revision = 1;
    const projection = () => ({
      id: actionId,
      ownerUserId: chief.ownerUserId,
      logicalSessionId: "44444444-4444-4444-8444-444444444444",
      executionId: "99999999-9999-4999-8999-999999999999",
      commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      executionGeneration: 1,
      providerTurnId: "turn-1",
      toolCallId: "call-1",
      name: "koed_job_create" as const,
      arguments: {
        title: "Issue digest",
        instruction: "Summarise the open Koed GitHub issues",
        schedule: { kind: "weekly", at: "08:00", tz: "Europe/Oslo", dow: [1] }
      },
      snapshot: {
        agentId: chief.id,
        conversationSessionId: "44444444-4444-4444-8444-444444444444",
        projectId: null
      },
      state,
      revision,
      reviewKind: "ask_first" as const,
      effectKey: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      createdAt: "2026-10-27T10:00:00.000Z",
      decidedAt: null
    });
    const textCalls: string[] = [];
    const managedTextActions = vi.fn(async (request: { operation: string }) => {
      textCalls.push(request.operation);
      if (request.operation === "list")
        return {
          operation: "list",
          executionId: projection().executionId,
          actions: [projection()]
        };
      if (request.operation === "review") {
        state = "ready";
        revision++;
      } else if (request.operation === "claim") {
        state = "claimed";
        revision++;
      } else if (request.operation === "complete") {
        state = "applied";
        revision++;
      }
      return {
        operation: request.operation,
        executionId: projection().executionId,
        action: projection()
      };
    });
    const jobCalls: Array<{ operation: string; value?: unknown }> = [];
    const { service } = setup([], {
      managedTextActions: managedTextActions as never,
      managedConversation: (async (request: { operation: string }) => {
        if (request.operation === "list")
          return {
            operation: "list",
            complete: true,
            executions: [
              {
                executionId: "99999999-9999-4999-8999-999999999999",
                projectId: "lp_chats",
                sessionId: "sess-new",
                threadId: "thread-new",
                state: "running"
              }
            ]
          };
        return {
          operation: "runtime",
          executionId: "99999999-9999-4999-8999-999999999999",
          executionGeneration: 1,
          executionStateVersion: 1,
          executionState: "running",
          executionLastErrorCode: null,
          latestCommand: null,
          items: []
        };
      }) as never,
      scheduledJobs: (async (request: {
        operation: string;
        value?: unknown;
      }) => {
        jobCalls.push(request);
        if (request.operation === "list")
          return { operation: "list", jobs: [], nextCursor: null };
        return { operation: request.operation, job: {} };
      }) as never
    });
    const home = await service.home();
    const proposal = home.needs.find((need) => need.kind === "job_proposal");
    expect(proposal).toMatchObject({
      action: "create",
      title: "Issue digest",
      schedule: { kind: "weekly", dow: [1], at: "08:00" }
    });
    await service.resolveProposal({
      executionId: "99999999-9999-4999-8999-999999999999",
      actionId,
      decision: "approve"
    });
    expect(textCalls).toEqual(["list", "get", "review", "claim", "complete"]);
    expect(jobCalls.filter((call) => call.operation === "create")).toEqual([
      {
        operation: "create",
        value: {
          requestId: actionId,
          textActionId: actionId,
          agentId: chief.id,
          conversationSessionId: "44444444-4444-4444-8444-444444444444",
          projectId: null,
          title: "Issue digest",
          instruction: "Summarise the open Koed GitHub issues",
          schedule: {
            kind: "weekly",
            at: "08:00",
            tz: "Europe/Oslo",
            dow: [1]
          }
        }
      }
    ]);
  });

  it("changes a job's time with the current version", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const job = {
      id: "33333333-3333-4333-8333-333333333333",
      ownerUserId: chief.ownerUserId,
      projectId: null,
      agentId: chief.id,
      conversationSessionId: "44444444-4444-4444-8444-444444444444",
      title: "Morning brief",
      instruction: "Summarise",
      schedule: { kind: "daily", at: "07:30", tz: "Europe/Oslo" },
      paused: false,
      pausedReason: null,
      runnerDeviceId: "55555555-5555-4555-8555-555555555555",
      version: 7,
      createdAt: "",
      updatedAt: ""
    };
    const { service } = setup([], {
      scheduledJobs: (async (request: Record<string, unknown>) => {
        calls.push(request);
        return { operation: request.operation, job };
      }) as never
    });
    await service.editJob(job.id, {
      schedule: { kind: "weekdays", at: "09:15", tz: "Europe/Oslo" }
    });
    expect(calls.at(-1)).toEqual({
      operation: "edit",
      jobId: job.id,
      expectedVersion: 7,
      schedule: { kind: "weekdays", at: "09:15", tz: "Europe/Oslo" }
    });
  });

  it("counts unblocks from the phone towards an edition", async () => {
    const values = new Map<string, string>();
    const game = createGamificationStore({
      get: async (key) => values.get(key) ?? null,
      put: async (key, value) => void values.set(key, value),
      delete: async (key) => void values.delete(key)
    });
    const store = createPhoneGatewayStore({
      get: async () => null,
      put: async () => undefined,
      delete: async () => undefined
    });
    const service = createPhoneGatewayService(
      {
        macName: () => "Studio",
        agents: (async () => ({ operation: "list", agents: [chief] })) as never,
        managedConversation: (async () => ({
          operation: "runtime_respond",
          accepted: true
        })) as never,
        personalMemory: (async () => ({ ok: false })) as never,
        scheduledJobs: (async () => ({
          operation: "list",
          jobs: [],
          nextCursor: null
        })) as never,
        localAiClients: (async () => ({
          operation: "list",
          readModel: { instances: [] }
        })) as never,
        ensureIndependentProject: async () => ({ localProjectId: "lp" })
      },
      store,
      game
    );
    await service.respond({
      executionId: "exec-1",
      itemId: "item-1",
      executionGeneration: 3,
      itemKind: "command_approval",
      decision: "accept"
    });
    expect((await game.read()).counters.unblocks).toBe(1);
    const collection = await service.collection();
    expect(collection.agents[0]).toMatchObject({
      agentId: chief.id,
      rank: "New recruit"
    });
    expect(
      collection.editions.find((edition) => edition.id === "glass")?.progress
    ).toEqual({ current: 1, target: 10 });
  });
});
