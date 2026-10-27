/**
 * The phone gateway's operations. Each one calls the same owner-bound Desktop
 * handlers the renderer uses (Agents, Managed Conversations, Personal Memory,
 * Scheduled Jobs, Local AI Clients) and shapes the result for the phone.
 *
 * The phone talks to the Chief of Staff in one Chat (an Independent Managed
 * Conversation on the Chief's AI Client), remembered in the gateway store. It
 * can also continue any other Chat, answer pending approvals and questions,
 * stop or interrupt a turn, run or pause Scheduled Jobs, and ask memory.
 */
import { randomUUID } from "node:crypto";
import type { Agent } from "@koed/shared/agent-contract";
import { PERSONAL_DESKTOP_CONTRACT_VERSION } from "@koed/shared/personal-desktop";
import type {
  PersonalDesktopRequest,
  PersonalDesktopResult
} from "@koed/shared/personal-desktop";
import type { KoedTextActionProjection } from "@koed/shared/koed-text-action-contract";
import { nextScheduledJobOccurrence } from "@koed/shared/scheduled-job-calendar";
import { scheduledJobScheduleSchema } from "@koed/shared/scheduled-job-contract";
import type { AgentsRequest, AgentsResult } from "../ipc/agents-protocol.js";
import type {
  LocalAiClientCommand,
  LocalAiClientResponse
} from "../ipc/local-ai-client-protocol.js";
import type {
  ManagedConversationListEntry,
  ManagedConversationRequest,
  ManagedConversationResult,
  ManagedConversationRuntimeItem
} from "../ipc/managed-conversation-protocol.js";
import type {
  ManagedTextActionRequest,
  ManagedTextActionResult
} from "../ipc/managed-text-action-protocol.js";
import type {
  ScheduledJobsRequest,
  ScheduledJobsResult
} from "../ipc/scheduled-jobs-protocol.js";
import type {
  PhoneAgent,
  PhoneAskTurn,
  PhoneCollection,
  PhoneJobEditRequest,
  PhoneProposalRespondRequest,
  PhoneStanding,
  PhoneComputer,
  PhoneConversationRef,
  PhoneEvent,
  PhoneHome,
  PhoneJob,
  PhoneJobRun,
  PhoneNeed,
  PhoneQuestion,
  PhoneRespondRequest,
  PhoneRun,
  PhoneTimeline,
  PhoneUpcoming,
  PhoneWorking
} from "./contract.js";
import {
  assignEdition as giveEdition,
  collectionView,
  countPhoneAction,
  evaluateGamification,
  markEditionSeen,
  standings,
  wornLook,
  type GamificationEvent,
  type GamificationFacts,
  type GamificationStore
} from "./gamification.js";
import type { PhoneChiefConversation, PhoneGatewayStore } from "./store.js";

/** What the gateway needs from the Koed Server manager. */
export type PhoneGatewayDeps = {
  macName: () => string;
  agents: (request: AgentsRequest) => Promise<AgentsResult>;
  managedConversation: (
    request: ManagedConversationRequest
  ) => Promise<ManagedConversationResult>;
  personalMemory: (
    request: PersonalDesktopRequest
  ) => Promise<PersonalDesktopResult>;
  scheduledJobs: (
    request: ScheduledJobsRequest
  ) => Promise<ScheduledJobsResult>;
  localAiClients: (
    request: LocalAiClientCommand
  ) => Promise<LocalAiClientResponse>;
  ensureIndependentProject: () => Promise<{ localProjectId: string }>;
  /** Koed actions an AI Client asked for (here: scheduling and pausing jobs), reviewed by the person. */
  managedTextActions?: (
    request: ManagedTextActionRequest
  ) => Promise<ManagedTextActionResult>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
};

export class PhoneGatewayError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "PhoneGatewayError";
  }
}

const TERMINAL_STATES = new Set(["stopping", "stopped", "failed", "fenced"]);
const INSPECTABLE_STATES = new Set([
  "starting",
  "running",
  "reconciling",
  "quiesce_requested",
  "quiesced"
]);
const MAXIMUM_INSPECTED_EXECUTIONS = 16;
const START_WAIT_MS = 45_000;

const textOf = (value: unknown, max = 4_096): string | null =>
  typeof value === "string" && value.trim() ? value.slice(0, max) : null;

const recordOf = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * Risky actions need Face ID on the phone and are never allowed in bulk:
 * permission changes, and commands that publish, merge, delete or deploy.
 */
const RISKY_COMMAND =
  /\b(git\s+(push|merge|reset\s+--hard|rebase|branch\s+-D|clean\s+-[a-z]*f)|gh\s+pr\s+merge|rm\s+-[a-z]*r[a-z]*|sudo|deploy|kubectl\s+(apply|delete)|terraform\s+(apply|destroy)|(npm|pnpm|yarn)\s+publish|drop\s+(table|database)|truncate\s+table)\b/iu;

export const isRiskyApproval = (
  item: Pick<ManagedConversationRuntimeItem, "itemKind" | "payload">
): boolean => {
  if (item.itemKind === "permissions_approval") return true;
  if (item.itemKind !== "command_approval") return false;
  const command = Array.isArray(item.payload.command)
    ? item.payload.command.map(String).join(" ")
    : (textOf(item.payload.command) ?? "");
  return RISKY_COMMAND.test(command);
};

const approvalTitle = (item: ManagedConversationRuntimeItem): string => {
  if (item.itemKind === "user_input") {
    const first = Array.isArray(item.payload.questions)
      ? recordOf(item.payload.questions[0])
      : null;
    return (
      textOf(first?.header, 160) ??
      textOf(first?.question, 160) ??
      "A question from the AI Client"
    );
  }
  if (item.itemKind === "file_approval") return "Change files?";
  if (item.itemKind === "permissions_approval") return "Give more permissions?";
  return "Run a command?";
};

const questionsOf = (item: ManagedConversationRuntimeItem): PhoneQuestion[] =>
  (Array.isArray(item.payload.questions) ? item.payload.questions : [])
    .map(recordOf)
    .filter((value): value is Record<string, unknown> =>
      Boolean(value && textOf(value.id))
    )
    .slice(0, 8)
    .map((question) => ({
      id: textOf(question.id, 256)!,
      header: textOf(question.header, 240),
      question: textOf(question.question, 1_000),
      options: (Array.isArray(question.options) ? question.options : [])
        .map(recordOf)
        .filter((option): option is Record<string, unknown> =>
          Boolean(option && textOf(option.label))
        )
        .slice(0, 12)
        .map((option) => ({
          label: textOf(option.label, 240)!,
          description: textOf(option.description, 480)
        })),
      isOther: question.isOther === true,
      isSecret: question.isSecret === true
    }));

export const needFromRuntimeItem = (
  executionId: string,
  item: ManagedConversationRuntimeItem,
  conversation: PhoneConversationRef | null
): PhoneNeed | null => {
  if (
    item.state !== "pending" ||
    item.answered ||
    item.itemKind === "transient_output"
  )
    return null;
  const isQuestion = item.itemKind === "user_input";
  if (!isQuestion && item.presentation.renderer !== "approval") return null;
  return {
    kind: isQuestion ? "question" : "approval",
    id: `runtime:${executionId}:${item.id}`,
    executionId,
    itemId: item.id,
    executionGeneration: item.executionGeneration,
    itemKind: item.itemKind,
    title: approvalTitle(item),
    command: Array.isArray(item.payload.command)
      ? item.payload.command.map(String).join(" ").slice(0, 4_096)
      : textOf(item.payload.command),
    cwd: textOf(item.payload.cwd, 1_024),
    reason: textOf(item.payload.reason, 2_000),
    questions: isQuestion ? questionsOf(item) : [],
    supportsSessionApproval: item.payload.supportsSessionApproval === true,
    risky: isRiskyApproval(item),
    conversation,
    at: item.createdAt
  };
};

const agentFor = (
  agent: Agent,
  instanceNames: ReadonlyMap<string, string>,
  standing: PhoneStanding | null = null
): PhoneAgent => {
  const own = (agent.look ?? {}) as Record<string, unknown>;
  const editionId = standing?.editionId ?? null;
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    look: wornLook(own, editionId),
    aiClientInstanceId: agent.aiClientInstanceId,
    aiClientName: instanceNames.get(agent.aiClientInstanceId) ?? null,
    defaultModel: agent.defaultModel,
    isChiefOfStaff: agent.isChiefOfStaff,
    createdAt: agent.createdAt,
    standing: standing ? { ...standing, ownLook: editionId ? own : null } : null
  };
};

const JOB_ACTIONS = new Set(["koed_job_create", "koed_job_pause"]);

/** A job an AI Client asked Koed to schedule (or pause), waiting for the person. */
export const proposalFromTextAction = (
  action: KoedTextActionProjection,
  conversation: PhoneConversationRef | null
): PhoneNeed | null => {
  if (!JOB_ACTIONS.has(action.name)) return null;
  const waiting =
    action.reviewKind === "ask_first" &&
    (action.state === "awaiting_review" || action.state === "ready");
  if (!waiting) return null;
  const args = action.arguments;
  const snapshot = action.snapshot;
  const title = textOf(args.title, 160) ?? "A scheduled job";
  if (action.name === "koed_job_create") {
    const schedule = scheduledJobScheduleSchema.safeParse(args.schedule);
    return {
      kind: "job_proposal",
      id: `action:${action.executionId}:${action.id}`,
      executionId: action.executionId,
      actionId: action.id,
      action: "create",
      title,
      instruction: textOf(args.instruction, 2_000),
      schedule: schedule.success ? schedule.data : null,
      jobId: null,
      agentId: textOf(snapshot.agentId, 64),
      conversation,
      at: action.createdAt
    };
  }
  return {
    kind: "job_proposal",
    id: `action:${action.executionId}:${action.id}`,
    executionId: action.executionId,
    actionId: action.id,
    action: args.paused === false ? "resume" : "pause",
    title,
    instruction: null,
    schedule: null,
    jobId: textOf(snapshot.jobId, 64),
    agentId: null,
    conversation,
    at: action.createdAt
  };
};

const eventRole = (
  actor: string | null,
  eventType: string
): PhoneEvent["role"] => {
  if (actor === "user") return "user";
  if (actor === "assistant" || actor === "agent" || actor === "subagent")
    return "assistant";
  if (actor === "tool" || eventType.includes("tool")) return "tool";
  return "other";
};

type PendingMessage = {
  clientMessageId: string;
  text: string;
  at: string;
  failed: string | null;
};

export type PhoneGatewayService = ReturnType<typeof createPhoneGatewayService>;

export const createPhoneGatewayService = (
  deps: PhoneGatewayDeps,
  store: PhoneGatewayStore,
  game: GamificationStore | null = null
) => {
  const now = deps.now ?? (() => new Date());
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  /** Messages accepted from the phone but not yet visible in the captured transcript. */
  const pending = new Map<string, PendingMessage[]>();
  const conversationKey = (projectId: string, threadId: string) =>
    `${projectId}\u0000${threadId}`;

  /* ---------- reads shared by several operations ---------- */

  type PersonalData<Operation extends PersonalDesktopRequest["operation"]> =
    Extract<PersonalDesktopResult, { operation: Operation; ok: true }> extends {
      data: infer Data;
    }
      ? Data
      : never;
  type PersonalInput<Operation extends PersonalDesktopRequest["operation"]> =
    Extract<PersonalDesktopRequest, { operation: Operation }> extends {
      input: infer Input;
    }
      ? Input
      : never;

  const personal = async <
    Operation extends PersonalDesktopRequest["operation"]
  >(
    operation: Operation,
    input: PersonalInput<Operation>
  ): Promise<PersonalData<Operation>> => {
    const result: PersonalDesktopResult = await deps.personalMemory({
      contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
      operation,
      input
    } as PersonalDesktopRequest);
    if (result.operation !== operation)
      throw new PhoneGatewayError(502, "Koed answered a different request.");
    if (!result.ok)
      throw new PhoneGatewayError(503, "Koed's memory isn't ready right now.");
    return (result as unknown as { data: PersonalData<Operation> }).data;
  };

  const conversation = async <
    Operation extends ManagedConversationRequest["operation"]
  >(
    request: Extract<ManagedConversationRequest, { operation: Operation }>
  ): Promise<Extract<ManagedConversationResult, { operation: Operation }>> => {
    const result = await deps.managedConversation(request);
    if (result.operation !== request.operation)
      throw new PhoneGatewayError(502, "Koed answered a different request.");
    return result as Extract<
      ManagedConversationResult,
      { operation: Operation }
    >;
  };

  let threadsCache: {
    at: number;
    value: Map<
      string,
      PhoneConversationRef & { latestAt: string; aiClient: string | null }
    >;
  } | null = null;
  /** Every captured Chat by session, with the thread it lives in (cached for 15 s). */
  /** Events Koed's memory holds across your Chats (from the last projects read). */
  let remembered: number | null = null;
  const threads = async (fresh = false) => {
    if (!fresh && threadsCache && now().getTime() - threadsCache.at < 15_000)
      return threadsCache.value;
    const data = await personal("personal.projects.list", {});
    remembered = data.projects.reduce(
      (sum, project) => sum + (project.eventCount ?? 0),
      0
    );
    const value = new Map<
      string,
      PhoneConversationRef & { latestAt: string; aiClient: string | null }
    >();
    for (const project of data.projects) {
      for (const thread of project.threads) {
        if (thread.threadKind === "subagent" || thread.conversationTrashedAt)
          continue;
        const ref = {
          projectId: project.id,
          threadId: thread.id,
          sessionId: thread.sessionId,
          title: thread.name || "Conversation",
          latestAt: thread.latestAt,
          aiClient: thread.sourceAiClient
        };
        value.set(thread.sessionId ?? `thread:${project.id}:${thread.id}`, ref);
        value.set(`thread:${project.id}:${thread.id}`, ref);
      }
    }
    threadsCache = { at: now().getTime(), value };
    return value;
  };

  const refForExecution = (
    entry: ManagedConversationListEntry,
    refs: Awaited<ReturnType<typeof threads>>
  ): PhoneConversationRef | null => {
    const found =
      (entry.sessionId && refs.get(entry.sessionId)) ||
      (entry.threadId &&
        refs.get(`thread:${entry.projectId}:${entry.threadId}`));
    if (found)
      return {
        projectId: found.projectId,
        threadId: found.threadId,
        sessionId: found.sessionId,
        title: found.title,
        aiClient: found.aiClient
      };
    return entry.threadId
      ? {
          projectId: entry.projectId,
          threadId: entry.threadId,
          sessionId: entry.sessionId,
          title: "Conversation",
          aiClient: null
        }
      : null;
  };

  const instanceNames = async (): Promise<Map<string, string>> => {
    try {
      const list = await deps.localAiClients({ operation: "list" });
      return new Map(
        list.readModel.instances.map((instance) => [
          instance.instanceId,
          instance.displayName
        ])
      );
    } catch {
      return new Map();
    }
  };

  const listAgents = async (): Promise<Agent[]> => {
    const listed = await deps.agents({ operation: "list" });
    if (listed.operation !== "list")
      throw new PhoneGatewayError(502, "Koed answered a different request.");
    if (listed.agents.some((agent) => agent.isChiefOfStaff))
      return listed.agents;
    // First use: the Desktop's own idempotent Chief creation, with the owner's saved binding.
    try {
      const ensured = await deps.agents({ operation: "ensureChief" });
      if (ensured.operation === "ensureChief")
        return [ensured.agent, ...listed.agents];
    } catch {
      /* no AI Client ready yet: the phone shows that state */
    }
    return listed.agents;
  };

  const runtimeOf = (executionId: string) =>
    conversation({ operation: "runtime", executionId });

  const busyOf = (
    runtime: Extract<ManagedConversationResult, { operation: "runtime" }>
  ) =>
    Boolean(
      runtime.latestCommand &&
      ["queued", "dispatching", "running"].includes(runtime.latestCommand.state)
    ) ||
    runtime.items.some(
      (item) =>
        item.state === "pending" &&
        !item.answered &&
        item.itemKind !== "transient_output"
    );

  /* ---------- jobs (cached for 30 s; they change rarely) ---------- */

  let jobsCache: {
    at: number;
    jobs: PhoneJob[];
    missed: PhoneNeed[];
    /** When each finished run finished, by the job's Agent (for ranks). */
    finished: Map<string, string[]>;
  } | null = null;

  const jobOf = (
    job: Extract<ScheduledJobsResult, { operation: "get" }>["job"]
  ): PhoneJob => {
    let nextRunAt: string | null = null;
    if (!job.paused) {
      try {
        nextRunAt = nextScheduledJobOccurrence(
          job.schedule,
          now()
        ).toISOString();
      } catch {
        nextRunAt = null;
      }
    }
    return {
      id: job.id,
      title: job.title,
      instruction: job.instruction,
      agentId: job.agentId,
      schedule: job.schedule,
      paused: job.paused,
      pausedReason: job.pausedReason,
      version: job.version,
      nextRunAt,
      conversationSessionId: job.conversationSessionId
    };
  };

  const runOf = (
    run: Extract<ScheduledJobsResult, { operation: "runs" }>["runs"][number]
  ): PhoneJobRun => ({
    id: run.id,
    jobId: run.jobId,
    scheduledFor: run.scheduledFor,
    trigger: run.trigger,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    error: run.error,
    skipReason: run.skipReason
  });

  const jobsAndMissed = async (fresh = false) => {
    if (!fresh && jobsCache && now().getTime() - jobsCache.at < 30_000)
      return jobsCache;
    const listed = await deps.scheduledJobs({ operation: "list" });
    if (listed.operation !== "list")
      throw new PhoneGatewayError(502, "Koed answered a different request.");
    const jobs = listed.jobs.map(jobOf);
    const missed: PhoneNeed[] = [];
    const finished = new Map<string, string[]>();
    // A missed run is something to decide (run it now, or skip it); look at the recent runs of each job.
    for (const job of listed.jobs.slice(0, 50)) {
      try {
        const runs = await deps.scheduledJobs({
          operation: "runs",
          jobId: job.id
        });
        if (runs.operation !== "runs") continue;
        for (const run of runs.runs) {
          if (run.status !== "ok") continue;
          const list = finished.get(job.agentId) ?? [];
          list.push(run.finishedAt ?? run.startedAt ?? run.scheduledFor);
          finished.set(job.agentId, list);
        }
        for (const run of runs.runs.slice(0, 5)) {
          if (run.status !== "missed") continue;
          missed.push({
            kind: "missed",
            id: `missed:${run.id}`,
            jobId: job.id,
            runId: run.id,
            jobTitle: job.title,
            agentId: job.agentId,
            scheduledFor: run.scheduledFor,
            at: run.scheduledFor
          });
        }
      } catch {
        /* one job's history failing doesn't hide the others */
      }
    }
    jobsCache = { at: now().getTime(), jobs, missed, finished };
    return jobsCache;
  };

  /* ---------- the phone's conversation with the Chief of Staff ---------- */

  const readChief = async () => (await store.read()).chiefConversation;

  const startChiefConversation = async (
    chief: Agent
  ): Promise<PhoneChiefConversation> => {
    const project = await deps.ensureIndependentProject();
    const { options } = await conversation({ operation: "launch_options" });
    const instance = options.instances.find(
      (candidate) => candidate.instanceId === chief.aiClientInstanceId
    );
    if (!instance)
      throw new PhoneGatewayError(
        409,
        "Your Chief of Staff's AI Client isn't set up on this Mac."
      );
    if (!instance.ready)
      throw new PhoneGatewayError(
        409,
        `${instance.displayName} isn't ready on this Mac. Open Koed there to check it.`
      );
    const wanted = chief.defaultModel;
    const model =
      (wanted &&
        instance.models.find((candidate) =>
          [candidate.id, candidate.fullId, candidate.model].includes(wanted)
        )) ||
      instance.models.find((candidate) => candidate.isDefault) ||
      instance.models[0];
    if (!model)
      throw new PhoneGatewayError(
        409,
        `${instance.displayName} has no model available.`
      );
    const permissionSupported = (mode: string) =>
      instance.capabilities.permissionModes.some(
        (entry) => entry.mode === mode && entry.support === "supported"
      );
    const permissionMode = permissionSupported(chief.defaultPermissionMode)
      ? chief.defaultPermissionMode
      : instance.capabilities.defaultPermissionMode;
    const started = await conversation({
      operation: "start",
      projectId: project.localProjectId,
      contextKind: "independent",
      aiClientDriverId: instance.driverId,
      aiClientInstanceId: instance.instanceId,
      model: model.id,
      reasoningEffort:
        model.defaultReasoningEffort ??
        model.supportedReasoningEfforts[0] ??
        null,
      permissionMode,
      runnerKind: "local_device",
      idempotencyKey: `koed-phone-chief:${randomUUID()}`
    });
    let identity =
      started.status === "ready" ? started.conversation : undefined;
    const deadline = now().getTime() + START_WAIT_MS;
    while (!identity && now().getTime() < deadline) {
      await sleep(750);
      const inspected = await conversation({
        operation: "inspect",
        executionId: started.executionId
      });
      if (inspected.status === "failed")
        throw new PhoneGatewayError(
          502,
          inspected.message ?? "The AI Client couldn't start a conversation."
        );
      if (inspected.status === "ready" && inspected.conversation)
        identity = inspected.conversation;
    }
    if (!identity)
      throw new PhoneGatewayError(
        504,
        "The AI Client is taking long to start. Try again in a moment."
      );
    const value: PhoneChiefConversation = {
      projectId: identity.projectId,
      threadId: identity.threadId,
      sessionId: identity.capturedSessionId,
      executionId: identity.executionId ?? started.executionId,
      title: "Chief of Staff",
      agentId: chief.id
    };
    await store.update((state) => ({ ...state, chiefConversation: value }));
    return value;
  };

  /** A writable execution for a captured Chat: the live one, or a resumed one. */
  const writableExecution = async (ref: {
    projectId: string;
    threadId: string;
    sessionId: string | null;
    executionId?: string | null;
  }) => {
    if (ref.executionId) {
      const inspected = await conversation({
        operation: "inspect",
        executionId: ref.executionId
      }).catch(() => null);
      if (inspected?.status === "ready" && inspected.conversation?.executionId)
        return inspected.conversation;
    }
    if (!ref.sessionId) return null;
    const resumed = await conversation({
      operation: "resume",
      projectId: ref.projectId,
      capturedSessionId: ref.sessionId,
      threadId: ref.threadId
    });
    if (resumed.status === "read_only")
      throw new PhoneGatewayError(
        409,
        resumed.message ?? "This conversation can only be read, not continued."
      );
    return resumed.conversation.executionId ? resumed.conversation : null;
  };

  const deliver = async (
    identity: {
      executionId: string | null;
      capturedSessionId: string;
      threadId: string;
    },
    text: string,
    clientMessageId: string
  ) => {
    if (!identity.executionId)
      throw new PhoneGatewayError(
        409,
        "This conversation isn't ready to continue yet."
      );
    const sent = await conversation({
      operation: "send",
      executionId: identity.executionId,
      capturedSessionId: identity.capturedSessionId,
      threadId: identity.threadId,
      idempotencyKey: `koed-phone:${clientMessageId}`,
      clientUserMessageId: clientMessageId,
      prompt: text,
      fileMentionCommandIds: [],
      terminalContextReferences: []
    });
    if (sent.status === "rejected")
      throw new PhoneGatewayError(
        409,
        sent.message ?? "The AI Client didn't accept the message."
      );
  };

  const remember = (key: string, message: PendingMessage) => {
    const list = pending.get(key) ?? [];
    if (
      !list.some((entry) => entry.clientMessageId === message.clientMessageId)
    )
      list.push(message);
    pending.set(key, list.slice(-20));
  };

  const markFailed = (key: string, clientMessageId: string, reason: string) => {
    const entry = pending
      .get(key)
      ?.find((candidate) => candidate.clientMessageId === clientMessageId);
    if (entry) entry.failed = reason;
  };

  /* ---------- jobs an AI Client proposed (Koed actions waiting for the person) ---------- */

  const applying = new Set<string>();

  /** Pending job actions in one execution. Approved-by-policy ones in the Chief's Chat are applied here. */
  const jobActionsOf = async (
    executionId: string,
    chiefExecutionId: string | null
  ): Promise<KoedTextActionProjection[]> => {
    if (!deps.managedTextActions) return [];
    try {
      const listed = await deps.managedTextActions({
        operation: "list",
        executionId
      });
      if (listed.operation !== "list") return [];
      const actions = listed.actions.filter((action) =>
        JOB_ACTIONS.has(action.name)
      );
      // Full access: Koed needs no review. Nobody may have this Chat open on the
      // Mac, so the gateway applies the job itself, exactly once (claim fences it).
      if (executionId === chiefExecutionId)
        for (const action of actions)
          if (action.state === "ready" && action.reviewKind === "none")
            void applyJobAction(action).catch(() => undefined);
      return actions;
    } catch {
      return [];
    }
  };

  const textActions = () => {
    if (!deps.managedTextActions)
      throw new PhoneGatewayError(
        503,
        "This version of Koed can't take job proposals from the phone."
      );
    return deps.managedTextActions;
  };

  const applyJobAction = async (action: KoedTextActionProjection) => {
    if (applying.has(action.id)) return;
    applying.add(action.id);
    const api = textActions();
    try {
      const claimed = await api({
        operation: "claim",
        executionId: action.executionId,
        actionId: action.id,
        expectedRevision: action.revision
      });
      if (claimed.operation !== "claim")
        throw new PhoneGatewayError(502, "Koed answered a different request.");
      const job = claimed.action;
      const args = job.arguments;
      const snapshot = job.snapshot;
      try {
        if (job.name === "koed_job_create") {
          if (
            typeof snapshot.agentId !== "string" ||
            typeof snapshot.conversationSessionId !== "string"
          )
            throw new PhoneGatewayError(
              409,
              "This job proposal is incomplete."
            );
          await deps.scheduledJobs({
            operation: "create",
            value: {
              requestId: job.id,
              textActionId: job.id,
              agentId: snapshot.agentId,
              conversationSessionId: snapshot.conversationSessionId,
              projectId:
                typeof snapshot.projectId === "string"
                  ? snapshot.projectId
                  : null,
              title: String(args.title),
              instruction: String(args.instruction),
              schedule: scheduledJobScheduleSchema.parse(args.schedule)
            }
          });
        } else {
          if (
            typeof snapshot.jobId !== "string" ||
            typeof snapshot.jobVersion !== "number" ||
            typeof args.paused !== "boolean"
          )
            throw new PhoneGatewayError(409, "This job change is incomplete.");
          await deps.scheduledJobs({
            operation: "pause",
            jobId: snapshot.jobId,
            expectedVersion: snapshot.jobVersion,
            paused: args.paused,
            textActionId: job.id
          });
        }
      } finally {
        // Both job actions leave a durable receipt: completing reads it and never repeats the effect.
        await api({
          operation: "complete",
          executionId: job.executionId,
          actionId: job.id,
          expectedRevision: job.revision
        }).catch(() => undefined);
        jobsCache = null;
      }
    } finally {
      applying.delete(action.id);
    }
  };

  const resolveProposal = async (request: PhoneProposalRespondRequest) => {
    const api = textActions();
    const got = await api({
      operation: "get",
      executionId: request.executionId,
      actionId: request.actionId
    });
    if (got.operation !== "get" || !JOB_ACTIONS.has(got.action.name))
      throw new PhoneGatewayError(404, "That proposal isn't here any more.");
    let action = got.action;
    if (action.state === "applied" || action.state === "declined")
      return { accepted: true as const, state: action.state };
    if (action.state === "awaiting_review") {
      if (action.reviewKind !== "ask_first")
        throw new PhoneGatewayError(
          409,
          "Review this one in Koed on your Mac."
        );
      const reviewed = await api({
        operation: "review",
        executionId: action.executionId,
        actionId: action.id,
        expectedRevision: action.revision,
        decision: request.decision
      });
      if (reviewed.operation !== "review")
        throw new PhoneGatewayError(502, "Koed answered a different request.");
      action = reviewed.action;
      if (request.decision === "decline")
        return { accepted: true as const, state: action.state };
    } else if (request.decision === "decline") {
      throw new PhoneGatewayError(409, "That was already approved.");
    }
    if (action.state !== "ready")
      throw new PhoneGatewayError(409, "That proposal changed. Look again.");
    await applyJobAction(action);
    progressed();
    return { accepted: true as const, state: "applied" as const };
  };

  /* ---------- ranks, milestones and editions ---------- */

  const factsFor = async (agents?: Agent[]): Promise<GamificationFacts> => {
    const [team, jobsInfo] = await Promise.all([
      agents ? Promise.resolve(agents) : listAgents(),
      jobsAndMissed().catch(() => null)
    ]);
    if (remembered === null) await threads().catch(() => undefined);
    return {
      now: now(),
      agents: team.map((agent) => ({
        id: agent.id,
        name: agent.name,
        isChiefOfStaff: agent.isChiefOfStaff,
        createdAt: agent.createdAt
      })),
      finishedRuns: jobsInfo?.finished ?? new Map(),
      scheduledJobs: jobsInfo?.jobs.length ?? 0,
      remembered
    };
  };

  const standingsOf = async (
    agents: Agent[]
  ): Promise<Map<string, PhoneStanding>> => {
    if (!game) return new Map();
    return standings(await factsFor(agents), await game.read());
  };

  /** Record what was newly earned; returns it so the gateway can tell the phone. */
  const evaluate = async (): Promise<GamificationEvent[]> => {
    if (!game) return [];
    const facts = await factsFor();
    const current = await game.read();
    // Most checks change nothing: don't rewrite the secret store for them.
    if (
      JSON.stringify(evaluateGamification(facts, current).state) ===
      JSON.stringify(current)
    )
      return [];
    let events: GamificationEvent[] = [];
    await game.update((state) => {
      const result = evaluateGamification(facts, state);
      events = result.events;
      return result.state;
    });
    return events;
  };

  let onProgress: (() => void) | null = null;
  const progressed = () => onProgress?.();

  const count = (action: "unblock" | "ask" | "chief_reply") =>
    game
      ? game
          .update((state) => countPhoneAction(state, action, now()))
          .then(progressed, () => undefined)
      : Promise.resolve();

  const collection = async (): Promise<PhoneCollection> => {
    if (!game)
      throw new PhoneGatewayError(503, "Ranks and editions aren't on yet.");
    await evaluate().catch(() => []);
    return collectionView(await factsFor(), await game.read());
  };

  const assignEdition = async (editionId: string, agentId: string | null) => {
    if (!game)
      throw new PhoneGatewayError(503, "Ranks and editions aren't on yet.");
    if (agentId && !(await listAgents()).some((agent) => agent.id === agentId))
      throw new PhoneGatewayError(404, "That agent isn't here any more.");
    try {
      await game.update((state) => giveEdition(state, editionId, agentId));
    } catch (error) {
      if (error instanceof Error && /isn't earned/u.test(error.message))
        throw new PhoneGatewayError(409, error.message);
      throw error;
    }
    return { accepted: true as const };
  };

  const markSeen = async (editionId: string) => {
    if (game) await game.update((state) => markEditionSeen(state, editionId));
    return { accepted: true as const };
  };

  /* ---------- operations ---------- */

  const home = async (): Promise<PhoneHome> => {
    const [agents, names, list, refs, chiefRef] = await Promise.all([
      listAgents(),
      instanceNames(),
      conversation({ operation: "list" }),
      threads().catch(() => new Map() as Awaited<ReturnType<typeof threads>>),
      readChief()
    ]);
    const inspectable = list.executions
      .filter((entry) => INSPECTABLE_STATES.has(entry.state))
      .slice(-MAXIMUM_INSPECTED_EXECUTIONS);
    const runtimes = await Promise.all(
      inspectable.map(async (entry) => ({
        entry,
        runtime: await runtimeOf(entry.executionId).catch(() => null)
      }))
    );
    const working: PhoneWorking[] = [];
    const needs: PhoneNeed[] = [];
    const proposals = await Promise.all(
      inspectable.map((entry) =>
        jobActionsOf(entry.executionId, chiefRef?.executionId ?? null)
      )
    );
    for (const [index, { entry, runtime }] of runtimes.entries()) {
      const ref = refForExecution(entry, refs);
      if (runtime) {
        for (const item of runtime.items) {
          const need = needFromRuntimeItem(entry.executionId, item, ref);
          if (need) needs.push(need);
        }
      }
      for (const action of proposals[index] ?? []) {
        const need = proposalFromTextAction(action, ref);
        if (need) needs.push(need);
      }
      working.push({
        executionId: entry.executionId,
        state: entry.state,
        busy: runtime ? busyOf(runtime) : false,
        conversation: ref,
        updatedAt: runtime?.latestCommand?.updatedAt ?? null
      });
    }
    let upcoming: PhoneUpcoming[] = [];
    try {
      const { jobs, missed } = await jobsAndMissed();
      needs.push(...missed);
      upcoming = jobs
        .filter((job) => job.nextRunAt)
        .map((job) => ({
          jobId: job.id,
          title: job.title,
          agentId: job.agentId,
          at: job.nextRunAt!
        }))
        .sort((left, right) => left.at.localeCompare(right.at))
        .slice(0, 8);
    } catch {
      /* Scheduled Jobs unavailable: the rest of home still works */
    }
    needs.sort((left, right) => left.at.localeCompare(right.at));
    const chief = agents.find((agent) => agent.isChiefOfStaff) ?? null;
    const standing = await standingsOf(agents).catch(() => new Map());
    return {
      mac: { name: deps.macName() },
      chief: chief
        ? agentFor(chief, names, standing.get(chief.id) ?? null)
        : null,
      agents: agents
        .filter((agent) => !agent.isChiefOfStaff)
        .map((agent) => agentFor(agent, names, standing.get(agent.id) ?? null)),
      chiefConversation: chiefRef
        ? {
            projectId: chiefRef.projectId,
            threadId: chiefRef.threadId,
            sessionId: chiefRef.sessionId,
            title: chiefRef.title,
            aiClient: null
          }
        : null,
      working: working.filter((entry) => entry.busy),
      upcoming,
      needs,
      complete: list.complete
    };
  };

  const timelineFor = async (
    ref: {
      projectId: string;
      threadId: string;
      sessionId: string | null;
      title: string;
    } | null,
    executionId?: string | null
  ): Promise<PhoneTimeline> => {
    if (!ref)
      return {
        conversation: null,
        execution: null,
        events: [],
        streaming: null
      };
    const data = await personal("personal.events.load_page", {
      projectId: ref.projectId,
      threadId: ref.threadId,
      limit: 50
    }).catch((error: unknown) => {
      // A Chat that was just started has no captured events yet.
      if (error instanceof PhoneGatewayError) return { events: [] };
      throw error;
    });
    const events: PhoneEvent[] = data.events
      .filter(
        (event) =>
          !event.invalidatedAt &&
          !event.transcriptDisplay &&
          !event.activityDisplay &&
          event.eventType !== "approval_activity"
      )
      .map((event) => ({
        id: event.id,
        role: eventRole(event.actor, event.eventType),
        text: (event.content ?? event.contentPreview).slice(0, 64_000),
        at: event.timestamp,
        providerTurnId: event.metadata.providerTurnId ?? null,
        toolName: event.metadata.toolName ?? event.toolDisplay?.label ?? null
      }))
      .filter((event) => event.text.trim().length > 0 || event.role === "tool");
    const key = conversationKey(ref.projectId, ref.threadId);
    const waiting = (pending.get(key) ?? []).filter(
      (message) =>
        !events.some(
          (event) =>
            event.role === "user" && event.text.trim() === message.text.trim()
        )
    );
    pending.set(key, waiting);
    for (const message of waiting) {
      events.push({
        id: `pending:${message.clientMessageId}`,
        role: "user",
        text: message.text,
        at: message.at,
        providerTurnId: null,
        toolName: message.failed ? `not-sent:${message.failed}` : "pending"
      });
    }
    let execution: PhoneTimeline["execution"] = null;
    let streaming: string | null = null;
    const listed = await conversation({ operation: "list" }).catch(() => null);
    const entry =
      (executionId &&
        listed?.executions.find(
          (candidate) =>
            candidate.executionId === executionId &&
            !TERMINAL_STATES.has(candidate.state)
        )) ||
      listed?.executions.find(
        (candidate) =>
          !TERMINAL_STATES.has(candidate.state) &&
          (candidate.sessionId === ref.sessionId ||
            candidate.threadId === ref.threadId)
      );
    if (entry) {
      const runtime = await runtimeOf(entry.executionId).catch(() => null);
      const busy = runtime ? busyOf(runtime) : false;
      execution = { executionId: entry.executionId, state: entry.state, busy };
      if (runtime && busy) {
        const live = [...runtime.items]
          .reverse()
          .find(
            (item) =>
              item.itemKind === "transient_output" &&
              typeof item.payload.text === "string"
          );
        streaming = live ? String(live.payload.text).slice(-16_000) : null;
      }
    }
    return {
      conversation: {
        projectId: ref.projectId,
        threadId: ref.threadId,
        sessionId: ref.sessionId,
        title: ref.title,
        aiClient: (ref as { aiClient?: string | null }).aiClient ?? null
      },
      execution,
      events,
      streaming
    };
  };

  const chiefTimeline = async (): Promise<PhoneTimeline> => {
    const chief = await readChief();
    return timelineFor(chief, chief?.executionId);
  };

  /** Accept a message for the Chief of Staff and deliver it in the background (it may need to start a Chat first). */
  const sendToChief = async (
    text: string,
    clientMessageId: string
  ): Promise<{ accepted: true; conversation: PhoneConversationRef | null }> => {
    const agents = await listAgents();
    const chief = agents.find((agent) => agent.isChiefOfStaff);
    if (!chief)
      throw new PhoneGatewayError(
        409,
        "There's no Chief of Staff yet. Finish setting up Koed on your Mac."
      );
    let current = await readChief();
    if (current && current.agentId !== chief.id) current = null;
    const deliverInBackground = async () => {
      let ref = current;
      let identity = ref
        ? await writableExecution(ref).catch(() => null)
        : null;
      if (!identity) {
        ref = await startChiefConversation(chief);
        identity = {
          executionId: ref.executionId,
          projectId: ref.projectId,
          capturedSessionId: ref.sessionId ?? ref.executionId,
          threadId: ref.threadId
        };
      } else if (
        ref &&
        identity.executionId &&
        identity.executionId !== ref.executionId
      ) {
        const executionId = identity.executionId;
        await store.update((state) =>
          state.chiefConversation
            ? {
                ...state,
                chiefConversation: { ...state.chiefConversation, executionId }
              }
            : state
        );
      }
      remember(conversationKey(identity.projectId, identity.threadId), {
        clientMessageId,
        text,
        at: now().toISOString(),
        failed: null
      });
      await deliver(identity, text, clientMessageId);
      return identity;
    };
    if (current)
      remember(conversationKey(current.projectId, current.threadId), {
        clientMessageId,
        text,
        at: now().toISOString(),
        failed: null
      });
    void deliverInBackground().catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : "Couldn't send.";
      if (current)
        markFailed(
          conversationKey(current.projectId, current.threadId),
          clientMessageId,
          reason
        );
      onDeliveryFailure?.(reason);
    });
    return {
      accepted: true,
      conversation: current
        ? {
            projectId: current.projectId,
            threadId: current.threadId,
            sessionId: current.sessionId,
            title: current.title,
            aiClient: null
          }
        : null
    };
  };

  let onDeliveryFailure: ((reason: string) => void) | null = null;

  const newChiefConversation = async () => {
    await store.update((state) => ({ ...state, chiefConversation: null }));
  };

  const recentConversations = async (): Promise<
    Array<PhoneConversationRef & { latestAt: string; aiClient: string | null }>
  > => {
    const refs = await threads(true);
    const unique = new Map<
      string,
      PhoneConversationRef & { latestAt: string; aiClient: string | null }
    >();
    for (const ref of refs.values())
      unique.set(`${ref.projectId}:${ref.threadId}`, ref);
    return [...unique.values()]
      .sort((left, right) => right.latestAt.localeCompare(left.latestAt))
      .slice(0, 40);
  };

  const findThread = async (projectId: string, threadId: string) => {
    const refs = await threads();
    const ref =
      refs.get(`thread:${projectId}:${threadId}`) ??
      (await threads(true)).get(`thread:${projectId}:${threadId}`);
    if (!ref)
      throw new PhoneGatewayError(404, "That conversation isn't on this Mac.");
    return ref;
  };

  const conversationTimeline = async (projectId: string, threadId: string) =>
    timelineFor(await findThread(projectId, threadId));

  const sendToConversation = async (
    projectId: string,
    threadId: string,
    text: string,
    clientMessageId: string
  ) => {
    const ref = await findThread(projectId, threadId);
    const identity = await writableExecution({ ...ref, executionId: null });
    if (!identity)
      throw new PhoneGatewayError(
        409,
        "This conversation can't be continued from the phone."
      );
    remember(conversationKey(projectId, threadId), {
      clientMessageId,
      text,
      at: now().toISOString(),
      failed: null
    });
    try {
      await deliver(identity, text, clientMessageId);
    } catch (error) {
      markFailed(
        conversationKey(projectId, threadId),
        clientMessageId,
        error instanceof Error ? error.message : "Couldn't send."
      );
      throw error;
    }
    return { accepted: true as const };
  };

  const run = async (executionId: string): Promise<PhoneRun> => {
    const [runtime, listed, refs] = await Promise.all([
      runtimeOf(executionId),
      conversation({ operation: "list" }),
      threads().catch(() => new Map() as Awaited<ReturnType<typeof threads>>)
    ]);
    const entry = listed.executions.find(
      (candidate) => candidate.executionId === executionId
    );
    const ref = entry ? refForExecution(entry, refs) : null;
    const steps = runtime.items
      .filter(
        (item) =>
          item.itemKind === "transient_output" ||
          item.presentation.renderer === "tool_call" ||
          item.presentation.renderer === "tool_result"
      )
      .slice(-60)
      .map((item) => ({
        id: item.id,
        kind: item.presentation.renderer,
        title:
          textOf(item.payload.toolName, 120) ??
          textOf(item.payload.text, 160)?.split("\n")[0] ??
          "Working",
        detail: textOf(item.payload.text, 2_000),
        at: item.updatedAt
      }));
    return {
      executionId,
      state: runtime.executionState,
      busy: busyOf(runtime),
      executionGeneration: runtime.executionGeneration,
      conversation: ref,
      steps,
      needs: runtime.items
        .map((item) => needFromRuntimeItem(executionId, item, ref))
        .filter((need): need is PhoneNeed => Boolean(need)),
      updatedAt: runtime.latestCommand?.updatedAt ?? null
    };
  };

  const respond = async (request: PhoneRespondRequest) => {
    await conversation({
      operation: "runtime_respond",
      executionId: request.executionId,
      itemId: request.itemId,
      itemKind: request.itemKind,
      executionGeneration: request.executionGeneration,
      ...(request.decision ? { decision: request.decision } : {}),
      ...(request.answers ? { answers: request.answers } : {})
    });
    if (request.decision !== "decline" && request.decision !== "cancel")
      await count("unblock");
    return { accepted: true as const };
  };

  const control = async (executionId: string, action: "interrupt" | "stop") => {
    const runtime = await runtimeOf(executionId);
    await conversation({
      operation: action,
      executionId,
      executionGeneration: runtime.executionGeneration,
      idempotencyKey: `koed-phone-${action}:${randomUUID()}`
    });
    return { accepted: true as const };
  };

  const jobs = async () => (await jobsAndMissed(true)).jobs;

  const job = async (jobId: string) => {
    const [got, runs] = await Promise.all([
      deps.scheduledJobs({ operation: "get", jobId }),
      deps.scheduledJobs({ operation: "runs", jobId })
    ]);
    if (got.operation !== "get" || runs.operation !== "runs")
      throw new PhoneGatewayError(502, "Koed answered a different request.");
    return { job: jobOf(got.job), runs: runs.runs.slice(0, 20).map(runOf) };
  };

  const currentJob = async (jobId: string) => {
    const got = await deps.scheduledJobs({ operation: "get", jobId });
    if (got.operation !== "get")
      throw new PhoneGatewayError(502, "Koed answered a different request.");
    return got.job;
  };

  const pauseJob = async (jobId: string, paused: boolean) => {
    const current = await currentJob(jobId);
    await deps.scheduledJobs({
      operation: "pause",
      jobId,
      expectedVersion: current.version,
      paused
    });
    jobsCache = null;
    return { accepted: true as const };
  };

  const editJob = async (jobId: string, edit: PhoneJobEditRequest) => {
    const current = await currentJob(jobId);
    await deps.scheduledJobs({
      operation: "edit",
      jobId,
      expectedVersion: current.version,
      ...(edit.title !== undefined ? { title: edit.title } : {}),
      ...(edit.instruction !== undefined
        ? { instruction: edit.instruction }
        : {}),
      ...(edit.schedule !== undefined ? { schedule: edit.schedule } : {})
    });
    jobsCache = null;
    return { accepted: true as const };
  };

  const runJobNow = async (jobId: string) => {
    const current = await currentJob(jobId);
    await deps.scheduledJobs({
      operation: "runNow",
      jobId,
      expectedVersion: current.version,
      requestId: randomUUID()
    });
    jobsCache = null;
    return { accepted: true as const };
  };

  const resolveRun = async (
    jobId: string,
    runId: string,
    action: "skip" | "retry"
  ) => {
    const current = await currentJob(jobId);
    await deps.scheduledJobs({
      operation: action,
      jobId,
      runId,
      expectedVersion: current.version
    });
    jobsCache = null;
    return { accepted: true as const };
  };

  const ask = async (
    query: string,
    clientRequestId: string,
    askThreadId?: string
  ): Promise<PhoneAskTurn> => {
    const data = await personal("personal.ask.submit", {
      idempotencyKey: `koed-phone:${clientRequestId}`,
      query,
      ...(askThreadId ? { askThreadId } : {})
    });
    await count("ask");
    const turn = data.question;
    return {
      id: turn.id,
      askThreadId: turn.askThreadId,
      query: turn.query,
      answerMarkdown: turn.answerMarkdown,
      status: turn.status,
      errorMessage: turn.errorMessage,
      createdAt: turn.createdAt
    };
  };

  const askThread = async (askThreadId: string): Promise<PhoneAskTurn[]> => {
    const data = await personal("personal.ask.thread.load", { askThreadId });
    return data.turns.map((turn) => ({
      id: turn.id,
      askThreadId: turn.askThreadId,
      query: turn.query,
      answerMarkdown: turn.answerMarkdown,
      status: turn.status,
      errorMessage: turn.errorMessage,
      createdAt: turn.createdAt
    }));
  };

  const computer = async (): Promise<PhoneComputer> => {
    const [list, usage] = await Promise.all([
      deps.localAiClients({ operation: "list" }),
      deps
        .localAiClients({ operation: "usage", action: "read" })
        .catch(() => null)
    ]);
    return {
      name: deps.macName(),
      online: true,
      aiClients: list.readModel.instances
        .filter((instance) => instance.enabled)
        .map((instance) => {
          const snapshot = list.readModel.capabilitySnapshots.find(
            (candidate) => candidate.instanceId === instance.instanceId
          );
          return {
            instanceId: instance.instanceId,
            name: instance.displayName,
            driverId: instance.driverId,
            ready: Boolean(
              snapshot &&
              !snapshot.stale &&
              snapshot.healthState === "healthy" &&
              snapshot.authenticationState === "authenticated"
            ),
            models: (snapshot?.models ?? [])
              .slice(0, 12)
              .map((model) => model.displayName ?? model.id),
            usage: (usage?.usage ?? [])
              .filter((entry) => entry.instanceId === instance.instanceId)
              .slice(0, 4)
              .map((entry) => ({
                window: entry.bucketName ?? entry.window,
                usedPercent: entry.usedPercent,
                status: entry.status,
                resetsAt: entry.resetsAt
              }))
          };
        })
    };
  };

  return {
    home,
    chiefTimeline,
    sendToChief,
    newChiefConversation,
    recentConversations,
    conversationTimeline,
    sendToConversation,
    run,
    respond,
    control,
    jobs,
    job,
    pauseJob,
    editJob,
    runJobNow,
    resolveProposal,
    collection,
    assignEdition,
    markSeen,
    evaluateGamification: evaluate,
    /** Called when something the phone did may have earned a rank, milestone or edition. */
    onProgress(listener: () => void) {
      onProgress = listener;
    },
    /** The Chief of Staff finished a reply in the phone's conversation. */
    countChiefReply: () => count("chief_reply"),
    resolveRun,
    ask,
    askThread,
    computer,
    /** Called when a message accepted from the phone couldn't be delivered. */
    onDeliveryFailure(listener: (reason: string) => void) {
      onDeliveryFailure = listener;
    },
    /** Drop cached reads (after a change event). */
    invalidate() {
      threadsCache = null;
      jobsCache = null;
    }
  };
};
