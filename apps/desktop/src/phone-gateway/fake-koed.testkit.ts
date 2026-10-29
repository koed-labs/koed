/**
 * A simulated Koed for exercising the phone gateway end to end: the Desktop
 * handlers the gateway calls (Agents, Managed Conversations, Personal
 * Memory, Scheduled Jobs, Koed actions, Local AI Clients), with state that
 * behaves. AI Clients reply after a short delay; a request to the Chief that
 * says "every …" proposes a Scheduled Job, the way `koed_job_create` does.
 *
 * Test support only: excluded from the Desktop build. Used by
 * workflow.test.ts and by the phone app's end-to-end suite.
 */
import { randomUUID } from "node:crypto";
import type { PhoneGatewayDeps } from "./service.js";

const DAY = 86_400_000;
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

export const FAKE_IDS = {
  owner: "22222222-2222-4222-8222-222222222222",
  chief: "11111111-1111-4111-8111-111111111111",
  quinn: "77777777-7777-4777-8777-777777777777",
  nova: "88888888-1111-4888-8888-888888888888",
  rex: "99999999-1111-4999-8999-999999999999",
  morningBrief: "33333333-3333-4333-8333-333333333333",
  releaseCheck: "33333333-4444-4333-8333-333333333333",
  docsCheck: "33333333-5555-4333-8333-333333333333",
  missedRun: "66666666-6666-4666-8666-666666666666",
  codexExecution: "aaaaaaaa-0000-4aaa-8aaa-000000000001",
  device: "55555555-5555-4555-8555-555555555555"
} as const;

type Event = {
  id: string;
  actor: string;
  eventType: string;
  timestamp: string;
  content: string;
  metadata: Record<string, unknown>;
};
type Thread = {
  projectId: string;
  projectName: string;
  threadId: string;
  sessionId: string;
  name: string;
  ai: string;
  events: Event[];
};
type Execution = {
  executionId: string;
  projectId: string;
  threadId: string;
  sessionId: string;
  state: string;
  generation: number;
  busyUntil: number;
  stream: string;
  items: any[];
};
type Job = {
  id: string;
  ownerUserId: string;
  projectId: null;
  agentId: string;
  conversationSessionId: string;
  title: string;
  instruction: string;
  schedule: any;
  paused: boolean;
  pausedReason: string | null;
  runnerDeviceId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type FakeKoedOptions = {
  /** How long an AI Client takes to reply (ms). */
  replyMs?: number;
  /** Start without a Chief of Staff, as on first use (the gateway asks Koed to make one). */
  noChief?: boolean;
};

export const createFakeKoed = (options: FakeKoedOptions = {}) => {
  const replyMs = options.replyMs ?? 1_200;
  const log: string[] = [];
  let n = 0;
  const note = (entry: string) => void log.push(entry);

  /* ---------- agents ---------- */
  const agent = (
    id: string,
    name: string,
    role: string,
    look: Record<string, unknown>,
    instance: string,
    daysAgo: number,
    chief = false
  ) => ({
    id,
    ownerUserId: FAKE_IDS.owner,
    name,
    role,
    look,
    aiClientInstanceId: instance,
    defaultPermissionMode: "supervised",
    defaultModel: instance.startsWith("codex") ? "gpt-5.5" : "opus",
    isChiefOfStaff: chief,
    createdAt: iso(-daysAgo * DAY)
  });
  const chief = agent(
    FAKE_IDS.chief,
    "Cooper",
    "Chief of staff",
    { seed: "cooper" },
    "claude.default",
    45,
    true
  );
  const team = [
    agent(
      FAKE_IDS.quinn,
      "Quinn",
      "Release engineer",
      { seed: "quinn" },
      "codex.default",
      20
    ),
    agent(
      FAKE_IDS.nova,
      "Nova",
      "Researcher",
      { seed: "nova-research", palette: { base: "#e59a2f" }, top: "antenna" },
      "claude.default",
      70
    ),
    agent(
      FAKE_IDS.rex,
      "Rex",
      "PR reviewer",
      {
        seed: "rex-reviews",
        palette: { base: "#d9573b" },
        body: { shape: "capsule" }
      },
      "codex.default",
      5
    )
  ];
  let chiefExists = !options.noChief;

  /* ---------- Chats ---------- */
  const threads = new Map<string, Thread>();
  const addThread = (thread: Thread) =>
    threads.set(`${thread.projectId}:${thread.threadId}`, thread);
  addThread({
    projectId: "lp_koed",
    projectName: "koed",
    threadId: "thread-codex",
    sessionId: "sess-codex",
    name: "Fix the webhook retries",
    ai: "codex",
    events: [
      {
        id: "c1",
        actor: "user",
        eventType: "message",
        timestamp: iso(-600_000),
        content: "Fix the webhook retries and push it",
        metadata: {}
      },
      {
        id: "c2",
        actor: "assistant",
        eventType: "message",
        timestamp: iso(-300_000),
        content: "Fixed the backoff. Tests pass. Ready to push to main.",
        metadata: { providerTurnId: "t1" }
      }
    ]
  });
  addThread({
    projectId: "lp_site",
    projectName: "website",
    threadId: "thread-claude",
    sessionId: "sess-claude",
    name: "Draft the release notes",
    ai: "claude-code",
    events: [
      {
        id: "d1",
        actor: "user",
        eventType: "message",
        timestamp: iso(-2 * 3_600_000),
        content: "Draft the release notes for 0.9",
        metadata: {}
      },
      {
        id: "d2",
        actor: "assistant",
        eventType: "message",
        timestamp: iso(-2 * 3_600_000 + 60_000),
        content:
          "## Koed 0.9\n\n- **Phone access**: pair your phone with Koed on your Mac\n- Faster memory answers",
        metadata: { providerTurnId: "t1" }
      }
    ]
  });

  const executions = new Map<string, Execution>();
  const approval = (
    id: string,
    command: string[],
    reason: string,
    generation: number
  ) => ({
    id,
    executionGeneration: generation,
    providerTurnId: "t1",
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
    payload: { command, cwd: "/Users/someone/projects/koed", reason },
    revision: 1,
    createdAt: iso(-60_000),
    updatedAt: iso(-60_000),
    answered: false
  });
  executions.set(FAKE_IDS.codexExecution, {
    executionId: FAKE_IDS.codexExecution,
    projectId: "lp_koed",
    threadId: "thread-codex",
    sessionId: "sess-codex",
    state: "running",
    generation: 3,
    busyUntil: 0,
    stream: "",
    items: [
      approval(
        "item-push",
        ["git", "push", "origin", "main"],
        "Publish the webhook fix",
        3
      ),
      approval("item-test", ["pnpm", "test"], "Run the tests once more", 3),
      {
        ...approval("item-question", [], "", 3),
        itemKind: "user_input",
        presentation: {
          mode: "expanded",
          renderer: "question",
          policyKey: "k",
          policyRevision: 1,
          reason: "r"
        },
        payload: {
          questions: [
            {
              id: "branch",
              header: "Release notes branch",
              question: "Which branch should the release notes go on?",
              options: [{ label: "main" }, { label: "release/0.9" }]
            }
          ]
        },
        createdAt: iso(-30_000)
      }
    ]
  });

  const textActions: any[] = [];
  const seenKeys = new Set<string>();

  const reply = (execution: Execution, text: string, after?: () => void) => {
    const thread = threads.get(`${execution.projectId}:${execution.threadId}`)!;
    execution.busyUntil = Date.now() + replyMs;
    execution.stream = "Thinking it through…";
    setTimeout(() => {
      thread.events.push({
        id: `r${++n}`,
        actor: "assistant",
        eventType: "message",
        timestamp: iso(),
        content: text,
        metadata: { providerTurnId: `t${n}` }
      });
      execution.stream = "";
      after?.();
    }, replyMs - 50);
  };

  const conversationOf = (execution: Execution) => ({
    executionId: execution.executionId,
    projectId: execution.projectId,
    capturedSessionId: execution.sessionId,
    threadId: execution.threadId
  });

  const managedConversation = async (request: any): Promise<any> => {
    note(`conversation:${request.operation}`);
    switch (request.operation) {
      case "list":
        return {
          operation: "list",
          complete: true,
          executions: [...executions.values()].map((execution) => ({
            executionId: execution.executionId,
            projectId: execution.projectId,
            sessionId: execution.sessionId,
            threadId: execution.threadId,
            state: execution.state
          }))
        };
      case "runtime": {
        const execution = executions.get(request.executionId);
        if (!execution) throw new Error("Unknown execution");
        const busy = Date.now() < execution.busyUntil;
        return {
          operation: "runtime",
          executionId: execution.executionId,
          executionGeneration: execution.generation,
          executionStateVersion: 1,
          executionState: execution.state,
          executionLastErrorCode: null,
          latestCommand: {
            id: "command",
            sequence: 1,
            executionGeneration: execution.generation,
            commandKind: "prompt",
            clientUserMessageId: null,
            state: busy ? "running" : "completed",
            lastErrorCode: null,
            updatedAt: iso()
          },
          items: [
            ...execution.items,
            ...(busy && execution.stream
              ? [
                  {
                    id: "stream",
                    executionGeneration: execution.generation,
                    itemKind: "transient_output",
                    presentation: { renderer: "stream" },
                    state: "pending",
                    payload: { text: execution.stream },
                    answered: false,
                    createdAt: iso(),
                    updatedAt: iso()
                  }
                ]
              : [])
          ]
        };
      }
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
      case "start": {
        note(`start:${request.aiClientInstanceId}:${request.model}`);
        const id = randomUUID();
        const threadId = `thread-chief-${++n}`;
        addThread({
          projectId: request.projectId,
          projectName: "Chats",
          threadId,
          sessionId: `sess-chief-${n}`,
          name: "Talking with Cooper",
          ai: "claude-code",
          events: []
        });
        executions.set(id, {
          executionId: id,
          projectId: request.projectId,
          threadId,
          sessionId: `sess-chief-${n}`,
          state: "running",
          generation: 1,
          busyUntil: 0,
          stream: "",
          items: []
        });
        return { operation: "start", status: "starting", executionId: id };
      }
      case "inspect": {
        const execution = executions.get(request.executionId);
        return execution
          ? {
              operation: "inspect",
              status: "ready",
              executionId: execution.executionId,
              conversation: conversationOf(execution)
            }
          : {
              operation: "inspect",
              status: "not_found",
              executionId: request.executionId
            };
      }
      case "resume": {
        let execution = [...executions.values()].find(
          (candidate) =>
            candidate.threadId === request.threadId &&
            candidate.projectId === request.projectId
        );
        if (!execution) {
          // A Chat with no session open: Koed opens one on its AI Client.
          execution = {
            executionId: randomUUID(),
            projectId: request.projectId,
            threadId: request.threadId,
            sessionId: request.capturedSessionId,
            state: "running",
            generation: 1,
            busyUntil: 0,
            stream: "",
            items: []
          };
          executions.set(execution.executionId, execution);
          note(`resumed:${request.threadId}`);
        }
        return {
          operation: "resume",
          status: "ready",
          conversation: conversationOf(execution)
        };
      }
      case "send": {
        const execution = executions.get(request.executionId);
        if (!execution) throw new Error("Unknown execution");
        if (seenKeys.has(request.idempotencyKey)) {
          note(`duplicate:${request.idempotencyKey}`);
          return {
            operation: "send",
            status: "queued",
            conversation: conversationOf(execution),
            idempotencyKey: request.idempotencyKey,
            clientUserMessageId: request.clientUserMessageId
          };
        }
        seenKeys.add(request.idempotencyKey);
        const thread = threads.get(
          `${execution.projectId}:${execution.threadId}`
        )!;
        thread.events.push({
          id: `u${++n}`,
          actor: "user",
          eventType: "message",
          timestamp: iso(),
          content: request.prompt,
          metadata: {}
        });
        note(`sent:${thread.ai}:${thread.threadId}:${request.prompt}`);
        if (
          thread.projectId === "lp_chats" &&
          /\bevery\b/iu.test(request.prompt)
        )
          reply(
            execution,
            "I can set that up as a scheduled job. It's in your notifications for an OK.",
            () =>
              textActions.push({
                id: randomUUID(),
                ownerUserId: FAKE_IDS.owner,
                logicalSessionId: randomUUID(),
                executionId: execution.executionId,
                commandId: randomUUID(),
                executionGeneration: 1,
                providerTurnId: "t",
                toolCallId: "c",
                name: "koed_job_create",
                arguments: {
                  title: "Issue digest",
                  instruction:
                    "Summarise the open Koed GitHub issues and flag anything urgent",
                  schedule: {
                    kind: "weekly",
                    at: "08:00",
                    tz: "Europe/Oslo",
                    dow: [1]
                  }
                },
                snapshot: {
                  agentId: FAKE_IDS.chief,
                  conversationSessionId: randomUUID(),
                  projectId: null
                },
                state: "awaiting_review",
                revision: 1,
                reviewKind: "ask_first",
                effectKey: randomUUID(),
                createdAt: iso(),
                decidedAt: null
              })
          );
        else
          reply(
            execution,
            thread.ai === "codex"
              ? `Codex here. Done: ${request.prompt}`
              : thread.projectId === "lp_chats"
                ? `Got it: “${request.prompt}”. I'll ask Quinn and report back.`
                : `Claude here. Done: ${request.prompt}`
          );
        return {
          operation: "send",
          status: "queued",
          conversation: conversationOf(execution),
          idempotencyKey: request.idempotencyKey,
          clientUserMessageId: request.clientUserMessageId
        };
      }
      case "runtime_respond": {
        const execution = executions.get(request.executionId)!;
        const item = execution.items.find(
          (entry) => entry.id === request.itemId
        );
        if (!item) throw new Error("That item is gone");
        execution.items = execution.items.filter(
          (entry) => entry.id !== request.itemId
        );
        note(
          `respond:${request.itemId}:${request.decision ?? JSON.stringify(request.answers)}`
        );
        return {
          operation: "runtime_respond",
          accepted: true,
          itemId: request.itemId
        };
      }
      case "interrupt":
      case "stop": {
        const execution = executions.get(request.executionId);
        if (execution) {
          execution.busyUntil = 0;
          execution.stream = "";
          if (request.operation === "stop") execution.state = "stopped";
        }
        note(`control:${request.operation}`);
        return { operation: request.operation, accepted: true };
      }
      default:
        throw new Error(`unexpected ${request.operation}`);
    }
  };

  /* ---------- memory ---------- */
  const asks = new Map<string, any[]>();
  const personalMemory = async (request: any): Promise<any> => {
    const ok = (data: unknown) => ({
      contractVersion: 8,
      operation: request.operation,
      ok: true,
      data
    });
    switch (request.operation) {
      case "personal.projects.list": {
        const projects = new Map<string, any>();
        for (const thread of threads.values()) {
          const project = projects.get(thread.projectId) ?? {
            id: thread.projectId,
            name: thread.projectName,
            path: null,
            eventCount: 0,
            threads: []
          };
          project.eventCount += thread.events.length;
          project.threads.push({
            id: thread.threadId,
            name: thread.name,
            sessionId: thread.sessionId,
            sourceAiClient: thread.ai,
            projectId: thread.projectId,
            projectName: thread.projectName,
            projectPath: null,
            projectAssignmentSource: null,
            eventCount: thread.events.length,
            invalidatedCount: 0,
            latestAt: thread.events.at(-1)?.timestamp ?? iso(),
            sample: "",
            presentation: null
          });
          projects.set(thread.projectId, project);
        }
        return ok({ projects: [...projects.values()] });
      }
      case "personal.events.load_page": {
        const thread = threads.get(
          `${request.input.projectId}:${request.input.threadId}`
        );
        return ok({
          events: (thread?.events ?? []).map((event, index) => ({
            ...event,
            sourceEventTime: null,
            sourceSequence: index,
            contentPreview: event.content.slice(0, 200),
            invalidatedAt: null
          }))
        });
      }
      case "personal.ask.submit": {
        const askThreadId = request.input.askThreadId ?? randomUUID();
        const turn = {
          id: randomUUID(),
          askThreadId,
          query: request.input.query,
          answerMarkdown: null as string | null,
          status: "pending",
          errorMessage: null,
          createdAt: iso()
        };
        asks.set(askThreadId, [...(asks.get(askThreadId) ?? []), turn]);
        setTimeout(
          () =>
            Object.assign(turn, {
              status: "answered",
              answerMarkdown:
                "You decided on **exponential backoff, 5 tries**, in the webhook thread on Tuesday."
            }),
          replyMs
        );
        note(`ask:${request.input.query}`);
        return ok({ question: turn });
      }
      case "personal.ask.thread.load":
        return ok({ turns: asks.get(request.input.askThreadId) ?? [] });
      default:
        throw new Error(`unexpected ${request.operation}`);
    }
  };

  /* ---------- Scheduled Jobs ---------- */
  const job = (
    id: string,
    agentId: string,
    title: string,
    instruction: string,
    schedule: unknown
  ): Job => ({
    id,
    ownerUserId: FAKE_IDS.owner,
    projectId: null,
    agentId,
    conversationSessionId: randomUUID(),
    title,
    instruction,
    schedule,
    paused: false,
    pausedReason: null,
    runnerDeviceId: FAKE_IDS.device,
    version: 2,
    createdAt: iso(-40 * DAY),
    updatedAt: iso(-40 * DAY)
  });
  const jobs: Job[] = [
    job(
      FAKE_IDS.morningBrief,
      FAKE_IDS.chief,
      "Morning brief",
      "Summarise the Koed GitHub issues",
      { kind: "daily", at: "07:30", tz: "Europe/Oslo" }
    ),
    job(
      FAKE_IDS.releaseCheck,
      FAKE_IDS.quinn,
      "Release check",
      "Run the end-to-end tests on main and report",
      { kind: "weekdays", at: "09:00", tz: "Europe/Oslo" }
    ),
    job(
      FAKE_IDS.docsCheck,
      FAKE_IDS.nova,
      "Docs link check",
      "Find broken links in the docs",
      { kind: "weekly", at: "10:00", tz: "Europe/Oslo", dow: [1, 4] }
    )
  ];
  const runs = new Map<string, any[]>();
  const okRuns = (jobId: string, count: number, everyDays: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: randomUUID(),
      jobId,
      scheduledFor: iso(-(index + 1) * everyDays * DAY),
      trigger: "scheduled",
      attempt: 0,
      status: "ok",
      skipReason: null,
      startedAt: iso(-(index + 1) * everyDays * DAY),
      finishedAt: iso(-(index + 1) * everyDays * DAY + 600_000),
      executionId: null,
      error: null
    }));
  runs.set(FAKE_IDS.morningBrief, [
    {
      id: FAKE_IDS.missedRun,
      jobId: FAKE_IDS.morningBrief,
      scheduledFor: iso(-3_600_000),
      trigger: "scheduled",
      attempt: 0,
      status: "missed",
      skipReason: null,
      startedAt: null,
      finishedAt: null,
      executionId: null,
      error: null
    },
    ...okRuns(FAKE_IDS.morningBrief, 4, 1)
  ]);
  runs.set(FAKE_IDS.releaseCheck, okRuns(FAKE_IDS.releaseCheck, 7, 2));
  runs.set(FAKE_IDS.docsCheck, okRuns(FAKE_IDS.docsCheck, 22, 3));

  const requireJob = (id: string, expectedVersion?: number) => {
    const found = jobs.find((candidate) => candidate.id === id);
    if (!found) throw new Error("Scheduled Job not found");
    if (expectedVersion !== undefined && found.version !== expectedVersion)
      throw new Error("Scheduled Job changed (version)");
    return found;
  };

  const scheduledJobs = async (request: any): Promise<any> => {
    note(`jobs:${request.operation}`);
    switch (request.operation) {
      case "list":
        return {
          operation: "list",
          nextCursor: null,
          jobs: structuredClone(jobs)
        };
      case "get":
        return {
          operation: "get",
          job: structuredClone(requireJob(request.jobId))
        };
      case "runs":
        requireJob(request.jobId);
        return {
          operation: "runs",
          jobId: request.jobId,
          nextCursor: null,
          runs: structuredClone(runs.get(request.jobId) ?? [])
        };
      case "pause": {
        const found = requireJob(request.jobId, request.expectedVersion);
        found.paused = request.paused;
        found.version++;
        note(`paused:${found.title}:${request.paused}`);
        return { operation: "pause", job: structuredClone(found) };
      }
      case "runNow": {
        const found = requireJob(request.jobId, request.expectedVersion);
        const run = {
          ...okRuns(found.id, 1, 0)[0],
          trigger: "manual",
          status: "running",
          finishedAt: null
        };
        runs.set(found.id, [run, ...(runs.get(found.id) ?? [])]);
        note(`runNow:${found.title}`);
        return { operation: "runNow", run };
      }
      case "edit": {
        const found = requireJob(request.jobId, request.expectedVersion);
        if (request.schedule) found.schedule = request.schedule;
        if (request.title) found.title = request.title;
        found.version++;
        note(`edit:${found.title}:${JSON.stringify(request.schedule)}`);
        return { operation: "edit", job: structuredClone(found) };
      }
      case "create": {
        if (jobs.some((candidate) => candidate.id === request.value.requestId))
          throw new Error("Duplicate request");
        const created = job(
          request.value.requestId,
          request.value.agentId,
          request.value.title,
          request.value.instruction,
          request.value.schedule
        );
        created.createdAt = iso();
        jobs.push(created);
        note(`create:${created.title}`);
        return { operation: "create", job: structuredClone(created) };
      }
      case "retry":
      case "skip": {
        requireJob(request.jobId, request.expectedVersion);
        const run = (runs.get(request.jobId) ?? []).find(
          (candidate) => candidate.id === request.runId
        );
        if (!run) throw new Error("Run not found");
        run.status = request.operation === "skip" ? "skipped" : "scheduled";
        note(`${request.operation}:${request.runId}`);
        return { operation: request.operation, run: structuredClone(run) };
      }
      default:
        throw new Error(`unexpected ${request.operation}`);
    }
  };

  /* ---------- Koed actions (job proposals) ---------- */
  const managedTextActions = async (request: any): Promise<any> => {
    note(`action:${request.operation}`);
    if (request.operation === "list")
      return {
        operation: "list",
        executionId: request.executionId,
        actions: structuredClone(
          textActions.filter(
            (action) => action.executionId === request.executionId
          )
        )
      };
    const action = textActions.find(
      (candidate) => candidate.id === request.actionId
    );
    if (!action) throw new Error("Koed action not found");
    if (
      "expectedRevision" in request &&
      request.expectedRevision !== action.revision
    )
      throw new Error("Koed action changed (revision)");
    if (request.operation === "review") {
      if (action.state !== "awaiting_review")
        throw new Error("Not awaiting review");
      action.state = request.decision === "approve" ? "ready" : "declined";
    } else if (request.operation === "claim") {
      if (action.state !== "ready") throw new Error("Not ready");
      action.state = "claimed";
    } else if (request.operation === "complete") {
      if (action.state !== "claimed") throw new Error("Not claimed");
      action.state = "applied";
    }
    if (request.operation !== "get") action.revision++;
    return {
      operation: request.operation,
      executionId: action.executionId,
      action: structuredClone(action)
    };
  };

  const localAiClients = async (request: any): Promise<any> =>
    request.operation === "usage"
      ? {
          usage: [
            {
              instanceId: "claude.default",
              bucketName: "5-hour",
              window: "five_hour",
              usedPercent: 42,
              status: "ok",
              resetsAt: iso(7_200_000)
            }
          ]
        }
      : {
          operation: "list",
          readModel: {
            instances: [
              {
                instanceId: "claude.default",
                driverId: "claude",
                displayName: "Claude Code",
                enabled: true
              },
              {
                instanceId: "codex.default",
                driverId: "codex",
                displayName: "Codex",
                enabled: true
              }
            ],
            capabilitySnapshots: [
              {
                instanceId: "claude.default",
                stale: false,
                healthState: "healthy",
                authenticationState: "authenticated",
                models: [{ id: "opus", displayName: "Opus" }]
              },
              {
                instanceId: "codex.default",
                stale: false,
                healthState: "healthy",
                authenticationState: "authenticated",
                models: [{ id: "gpt-5.5", displayName: "GPT-5.5" }]
              }
            ],
            settings: [],
            defaults: {}
          }
        };

  const agents = async (request: any): Promise<any> => {
    if (request.operation === "list")
      return {
        operation: "list",
        agents: structuredClone(chiefExists ? [chief, ...team] : team)
      };
    note("agents:ensureChief");
    chiefExists = true;
    return { operation: "ensureChief", agent: structuredClone(chief) };
  };

  const deps: PhoneGatewayDeps = {
    macName: () => "Jacobo's MacBook",
    agents: agents as never,
    managedConversation: managedConversation as never,
    personalMemory: personalMemory as never,
    scheduledJobs: scheduledJobs as never,
    localAiClients: localAiClients as never,
    managedTextActions: managedTextActions as never,
    ensureIndependentProject: async () => ({ localProjectId: "lp_chats" })
  };

  return {
    deps,
    log,
    threads,
    executions,
    jobs,
    runs,
    textActions,
    /** The AI Client asks for another approval in a Chat (for live-update checks). */
    addApproval(command: string[], reason: string) {
      const execution = executions.get(FAKE_IDS.codexExecution)!;
      const id = `item-${++n}`;
      execution.items.push({
        ...approval(id, command, reason, execution.generation),
        createdAt: iso(),
        updatedAt: iso()
      });
      return id;
    }
  };
};

export type FakeKoed = ReturnType<typeof createFakeKoed>;
