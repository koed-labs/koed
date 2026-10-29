import path from "node:path";
import { setTimeout as waitFor } from "node:timers/promises";
import { withCitationAliases } from "../integrations/pi/memory-answer-presentation.mjs";
import {
  answerWithMemoryWorker,
  directMemoryRecallAnswer,
  type MemoryAnswerConversationTurn,
  type MemoryAnswerRetrievalClient,
  type MemoryAnswerResponseDetail,
  resolveMemoryAnswerWorkerConfig
} from "./answer-worker.js";
import type { CuratedMemoryReviewServiceHandle as LocalCuratedMemoryReviewServiceHandle } from "./curated-memory-review-service.js";
import {
  MemoryApiClient,
  backendToolCapabilitiesFrom,
  defaultAnswerScope,
  memoryAccessCheck,
  workerOverridesFromLocalMemorySetting,
  type BackendToolCapabilities
} from "./index.js";
import type { LcmSummaryServiceHandle } from "./lcm-summary-service.js";
import type { MemoryAnswerTaskExecutionContext } from "./memory-answer-task-scheduler.js";
import { logger } from "./logger.js";
import { resolveLocalMemoryAgentConfig } from "./ai-client-assignment.js";
import {
  answerMarkdownFromAnswer,
  citationsFromAnswer,
  errorMessageFromAnswer,
  evidenceFromAnswer,
  persistedAnswerResponse,
  retrievalFromAnswer,
  stripAppServerEvents,
  toolAnswerResponse
} from "./memory-question-answer-persistence.js";
import {
  memoryAccessCheckInputSchema,
  memoryAnswerInputSchema,
  managedMemoryAnswerExecutionSchema,
  memoryExpandInputSchema,
  memoryIntakeProposeInputSchema,
  memorySearchInputSchema,
  memoryWorkspacesInputSchema,
  type MemoryAnswerToolInput
} from "./memory-tool-schemas.js";
import { resolveProjectTeamWorkspaceRoute } from "./project-team-workspace-links.js";
import { discoverTeamWorkspaces } from "./team-workspace-discovery.js";
import { presentManagedCombinedRecall } from "./managed-combined-recall.js";
import { readManagedProjectRecallContext } from "./managed-project-recall-context.js";
import type {
  LocalRuntimeCallerContext,
  LocalRuntimeToolName
} from "./local-runtime-protocol.js";

type McpMemoryQuestion = {
  id: string;
  answerMarkdown?: string | null;
  citations?: unknown[] | null;
  evidence?: unknown[] | null;
  localMemoryWorker?: Record<string, unknown> | null;
  response?: Record<string, unknown> | null;
  retrieval?: Record<string, unknown> | null;
};

const questionFromResponse = (response: Record<string, unknown>) => {
  const question = response.question;
  if (
    question &&
    typeof question === "object" &&
    typeof (question as { id?: unknown }).id === "string"
  ) {
    return question as McpMemoryQuestion;
  }
  throw new Error("Memory question response did not include question detail");
};

const normalizeProjectId = (
  projectId: string | undefined,
  caller: LocalRuntimeCallerContext
): string =>
  projectId && (path.isAbsolute(projectId) || path.win32.isAbsolute(projectId))
    ? projectId
    : path.resolve(caller.cwd);

export interface MemoryToolExecutorServices {
  lcmSummaryService?: LcmSummaryServiceHandle | null;
  curatedMemoryReviewService?: LocalCuratedMemoryReviewServiceHandle | null;
  answerWithMemoryWorker?: typeof answerWithMemoryWorker;
}

export interface TrustedMemoryAnswerExecutionOptions {
  conversationContext?: readonly MemoryAnswerConversationTurn[];
  idempotencyKey?: string;
  onQuestionRecorded?: (question: McpMemoryQuestion) => void;
  requireQuestionPersistence?: boolean;
  onProgress?: (status: string) => void;
  origin: "desktop_ask" | "mcp_memory_answer";
  pendingQuestionId?: string;
  taskContext?: MemoryAnswerTaskExecutionContext;
  onFinalQuestionPrepared?: (question: Record<string, unknown>) => void;
  /** Return the matching memories without a second AI Client run. */
  directRecall?: boolean;
}

export interface DesktopAskExecutionInput {
  askThreadId?: string;
  idempotencyKey: string;
  query: string;
}

type DesktopAskQuestion = McpMemoryQuestion & {
  answerMarkdown?: string | null;
  answeredAt?: string | null;
  askThreadId: string;
  askTurnIndex: number;
  createdAt: string;
  errorMessage?: string | null;
  query: string;
  status: "pending" | "answered" | "error";
  updatedAt: string;
};

const desktopAskQuestionFromResponse = (
  response: Record<string, unknown>
): DesktopAskQuestion => {
  const question = questionFromResponse(
    response
  ) as Partial<DesktopAskQuestion>;
  if (
    typeof question.askThreadId !== "string" ||
    typeof question.askTurnIndex !== "number" ||
    typeof question.query !== "string" ||
    !["pending", "answered", "error"].includes(question.status ?? "") ||
    typeof question.createdAt !== "string" ||
    typeof question.updatedAt !== "string"
  ) {
    throw new Error("Desktop Ask response did not include a valid Ask turn");
  }
  return question as DesktopAskQuestion;
};

const displaySafeDesktopAskQuestion = (question: DesktopAskQuestion) => ({
  id: question.id,
  askThreadId: question.askThreadId,
  askTurnIndex: question.askTurnIndex,
  query: question.query,
  answerMarkdown: question.answerMarkdown ?? null,
  errorMessage: question.errorMessage ?? null,
  status: question.status,
  createdAt: question.createdAt,
  updatedAt: question.updatedAt,
  answeredAt: question.answeredAt ?? null
});

export const boundedDesktopAskConversationContext = (
  value: unknown
): MemoryAnswerConversationTurn[] => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const questions = (value as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) return [];
  const completed = questions
    .filter((turn): turn is Record<string, unknown> =>
      Boolean(
        turn &&
        typeof turn === "object" &&
        !Array.isArray(turn) &&
        (turn as { status?: unknown }).status === "answered" &&
        typeof (turn as { query?: unknown }).query === "string" &&
        typeof (turn as { answerMarkdown?: unknown }).answerMarkdown ===
          "string"
      )
    )
    .map((turn) => ({
      question: turn.query as string,
      answer: turn.answerMarkdown as string
    }))
    .slice(-20);
  let byteLength = completed.reduce(
    (total, turn) =>
      total +
      Buffer.byteLength(turn.question, "utf8") +
      Buffer.byteLength(turn.answer, "utf8"),
    0
  );
  while (completed.length > 0 && byteLength > 64 * 1024) {
    const removed = completed.shift()!;
    byteLength -=
      Buffer.byteLength(removed.question, "utf8") +
      Buffer.byteLength(removed.answer, "utf8");
  }
  return completed;
};

export class MemoryToolExecutor {
  constructor(
    readonly client: MemoryApiClient,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly services: MemoryToolExecutorServices = {}
  ) {}

  async capabilities(): Promise<BackendToolCapabilities> {
    return backendToolCapabilitiesFrom(await this.client.capabilities());
  }

  private personalMemoryAnswerEligible(
    rawInput: Record<string, unknown>,
    caller: LocalRuntimeCallerContext
  ): boolean {
    const input = managedMemoryAnswerExecutionSchema.parse(rawInput);
    const projectId =
      input.search_domain === "project"
        ? normalizeProjectId(input.project_id, caller)
        : input.project_id;
    if (input.personal_project_and_me || input.managed_project_recall)
      return true;
    return !resolveProjectTeamWorkspaceRoute({
      projectRoot: input.search_domain === "project" ? projectId : undefined,
      requestedTeamWorkspaceId: input.team_workspace_id,
      env: this.environment
    }).teamWorkspaceId;
  }

  async executeDesktopAsk(
    input: DesktopAskExecutionInput,
    caller: LocalRuntimeCallerContext,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const pending = desktopAskQuestionFromResponse(
      await this.client.createPendingDesktopAsk({
        ask_thread_id: input.askThreadId,
        idempotency_key: input.idempotencyKey,
        query: input.query
      })
    );
    if (pending.status !== "pending") {
      return { question: displaySafeDesktopAskQuestion(pending) };
    }
    const conversationContext = input.askThreadId
      ? boundedDesktopAskConversationContext(
          await this.client.getDesktopAskThread(pending.askThreadId)
        )
      : [];
    try {
      await this.executeMemoryAnswer(
        {
          include_evidence: false,
          limit: 10,
          query: pending.query,
          response_detail: "answer_only",
          retrieval_hints: {},
          search_domain: "global"
        },
        caller,
        {
          origin: "desktop_ask",
          conversationContext,
          pendingQuestionId: pending.id
        },
        signal
      );
    } catch (error) {
      await this.client.completePendingDesktopAsk(pending.id, {
        status: "error",
        error_message: signal?.aborted
          ? "This Ask was interrupted before it completed. Try again."
          : "Koed could not answer this question. Try again.",
        attempt_count: 1
      });
      if (signal?.aborted) throw error;
    }
    const completed = desktopAskQuestionFromResponse(
      await this.client.getQuestion(pending.id)
    );
    return { question: displaySafeDesktopAskQuestion(completed) };
  }

  async execute(
    name: LocalRuntimeToolName,
    rawInput: Record<string, unknown>,
    caller: LocalRuntimeCallerContext,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    if (signal?.aborted) throw new Error("Koed memory request was cancelled");
    switch (name) {
      case "memory_workspaces": {
        const input = memoryWorkspacesInputSchema.parse(rawInput);
        const discovery = await discoverTeamWorkspaces(
          this.client,
          this.environment,
          input.team_backend_id,
          signal
        );
        return {
          ...discovery,
          instructions:
            "Select the relevant Team Workspace and pass team_workspace_id and team_backend_id to memory_answer. Use search_domain=global for all shared memory in that Workspace; project and session also filter shared source context. Multiple relevant Workspaces require separate recall requests. An unavailable backend is not evidence that its Team Memory is empty."
        };
      }
      case "memory_access_check": {
        const input = memoryAccessCheckInputSchema.parse(rawInput);
        return (await memoryAccessCheck(this.client, input.include_notes, {
          lcmSummaryService: this.services.lcmSummaryService ?? undefined,
          curatedMemoryReviewService:
            this.services.curatedMemoryReviewService ?? undefined
        })) as unknown as Record<string, unknown>;
      }
      case "memory_answer":
        return await this.executeMemoryAnswer(
          memoryAnswerInputSchema.parse(rawInput),
          caller,
          { origin: "mcp_memory_answer" },
          signal
        );
      case "memory_intake_propose": {
        const input = memoryIntakeProposeInputSchema.parse(rawInput);
        const result = await this.client.proposeCuratedMemory({
          ...input,
          source_project_id: normalizeProjectId(
            input.source_project_id,
            caller
          ),
          created_by_model: "codex",
          created_by_prompt_version: "memory-intake-propose-mcp-v1"
        });
        this.services.curatedMemoryReviewService?.nudge("proposal_created");
        return result;
      }
      case "memory_search": {
        const input = memorySearchInputSchema.parse(rawInput);
        return await this.client.search({
          ...input,
          retrieval_scope: "personal",
          project_id:
            input.search_domain === "project"
              ? normalizeProjectId(input.project_id, caller)
              : input.project_id
        });
      }
      case "memory_expand": {
        const input = memoryExpandInputSchema.parse(rawInput);
        return await this.client.expand(input.nodeId);
      }
    }
  }

  async executeMemoryAnswerTask(
    input: Record<string, unknown>,
    caller: LocalRuntimeCallerContext,
    taskId: string,
    signal?: AbortSignal,
    onProgress?: (status: string) => void,
    context?: MemoryAnswerTaskExecutionContext
  ): Promise<{
    finalQuestion: Record<string, unknown>;
    result: Record<string, unknown>;
  }> {
    const parsedInput = managedMemoryAnswerExecutionSchema.parse(input);
    if (parsedInput.managed_project_recall) {
      const selection = parsedInput.managed_project_recall;
      const koedHome = this.environment.KOED_HOME;
      if (
        !koedHome ||
        !context ||
        context.getExecutionAuthority().scope !== "personal"
      )
        throw new Error("Managed Project recall owner context is unavailable");
      const selector = {
        executionId: selection.execution_id,
        generation: selection.execution_generation,
        koedHome,
        apiUrl: new URL(this.client.config.apiUrl)
      };
      const linked = await readManagedProjectRecallContext(selector);
      const {
        managed_project_recall: _managed,
        project_id: _requestedProject,
        session_id: _requestedSession,
        team_workspace_id: _requestedWorkspace,
        team_backend_id: _requestedBackend,
        personal_project_and_me: _requestedUnion,
        ...sharedInput
      } = parsedInput;
      void _managed;
      void _requestedProject;
      void _requestedSession;
      void _requestedWorkspace;
      void _requestedBackend;
      void _requestedUnion;
      const personalInput = {
        ...sharedInput,
        search_domain: "project" as const,
        project_id: linked.personalProjectId,
        personal_project_and_me: true,
        response_detail: "with_citations" as const
      };
      const personal = await this.executeMemoryAnswerTask(
        personalInput,
        caller,
        taskId,
        signal,
        onProgress,
        context
      );
      if (signal?.aborted) throw signal.reason;
      if (
        (
          personal.result.localMemoryWorker as
            | { usedFallback?: boolean }
            | undefined
        )?.usedFallback
      )
        throw new Error("Managed Personal Project recall is unavailable");
      if (!linked.linked) {
        const after = await readManagedProjectRecallContext(selector);
        if (JSON.stringify(after) !== JSON.stringify(linked))
          throw new Error(
            "Managed Project recall link changed during retrieval"
          );
        return {
          ...personal,
          result: {
            ...personal.result,
            managed_project_version: linked.projectVersion
          }
        };
      }
      if (
        JSON.stringify(await readManagedProjectRecallContext(selector)) !==
        JSON.stringify(linked)
      )
        throw new Error("Managed Project recall link changed during retrieval");
      let team: Record<string, unknown> | null;
      let childId: string | null = null;
      try {
        if (!context.startCombinedTeamChild || !context.getCombinedTeamChild)
          throw new Error("Team child task coordinator unavailable");
        const {
          project_id: _project,
          personal_project_and_me: _union,
          ...shared
        } = personalInput;
        void _project;
        void _union;
        const child = await context.startCombinedTeamChild(
          {
            ...shared,
            search_domain: "global",
            team_workspace_id: linked.teamWorkspaceId,
            team_backend_id: linked.teamBackendId,
            response_detail: "with_citations"
          },
          caller,
          `managed-combined:${taskId}:team`
        );
        childId = child.id;
        await context.runCombinedTeamChild?.(child.id, signal);
        let current = await context.getCombinedTeamChild(child.id);
        while (!["completed", "failed", "cancelled"].includes(current.status)) {
          await waitFor(1000, undefined, { signal });
          const next = await context.getCombinedTeamChild(child.id);
          if (
            next.version > current.version &&
            (next.status !== current.status ||
              next.lastProgressAt !== current.lastProgressAt)
          )
            onProgress?.("linked Team memory advanced");
          current = next;
        }
        if (current.status !== "completed" || !current.result)
          throw new Error("Linked Team Memory Answer is unavailable");
        team = withCitationAliases(current.result);
        if (
          (team.localMemoryWorker as { usedFallback?: boolean } | undefined)
            ?.usedFallback
        )
          throw new Error("Linked Team recall is unavailable");
        if (team.team_backend_id !== linked.teamBackendId)
          throw new Error("Linked Team backend changed");
      } catch (error) {
        if (signal?.aborted) {
          if (childId && context.isUserCancellation?.())
            await context
              .cancelCombinedTeamChild?.(childId)
              .catch(() => undefined);
          throw error;
        }
        team = null;
      }
      const after = await readManagedProjectRecallContext(selector);
      if (JSON.stringify(after) !== JSON.stringify(linked))
        throw new Error("Managed Project recall link changed during retrieval");
      return {
        finalQuestion: personal.finalQuestion,
        result: presentManagedCombinedRecall(
          withCitationAliases(personal.result),
          team,
          linked
        )
      };
    }
    const authority = context?.getExecutionAuthority() ?? {
      scope: "personal" as const
    };
    if (
      authority.scope === "personal" &&
      !this.personalMemoryAnswerEligible(parsedInput, caller)
    ) {
      throw Object.assign(
        new Error(
          "Memory Answer task is no longer eligible for Personal execution"
        ),
        {
          memoryAnswerTaskErrorCode: "personal_route_changed",
          retryable: false
        }
      );
    }
    if (
      authority.scope === "team" &&
      parsedInput.team_workspace_id &&
      parsedInput.team_workspace_id !== authority.teamWorkspaceId
    ) {
      throw Object.assign(
        new Error(
          "Memory Answer task Team Workspace does not match its authority"
        ),
        { memoryAnswerTaskErrorCode: "team_scope_changed", retryable: false }
      );
    }
    let finalQuestion: Record<string, unknown> | undefined;
    const result = await this.executeMemoryAnswer(
      parsedInput,
      caller,
      {
        origin: "mcp_memory_answer",
        idempotencyKey: `memory-answer-task:${taskId}`,
        taskContext: context,
        onProgress,
        directRecall: parsedInput.direct_recall === true,
        onFinalQuestionPrepared: (question) => {
          finalQuestion = question;
        }
      },
      signal
    );
    if (!finalQuestion) {
      throw new Error("Memory Answer task did not prepare a final question");
    }
    return { finalQuestion, result };
  }

  async executeMemoryAnswer(
    input: MemoryAnswerToolInput & { personal_project_and_me?: boolean },
    caller: LocalRuntimeCallerContext,
    execution: TrustedMemoryAnswerExecutionOptions,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    if (execution.origin === "desktop_ask" && !execution.pendingQuestionId) {
      throw new Error("Desktop Ask requires a durable pending question");
    }
    const taskAuthority = execution.taskContext?.getExecutionAuthority();
    if (
      taskAuthority?.scope !== "team" &&
      (input.team_workspace_id ||
        input.team_backend_id ||
        (!taskAuthority &&
          !input.personal_project_and_me &&
          resolveProjectTeamWorkspaceRoute({
            projectRoot:
              input.search_domain === "project"
                ? normalizeProjectId(input.project_id, caller)
                : undefined,
            env: this.environment
          }).teamWorkspaceId))
    ) {
      throw Object.assign(
        new Error("Team Memory Answer requires an authorized durable task"),
        {
          statusCode: 403,
          memoryAnswerTaskErrorCode: "team_task_authority_required",
          retryable: false
        }
      );
    }
    const requestedResponseDetail: MemoryAnswerResponseDetail =
      input.include_evidence ? "with_evidence" : input.response_detail;
    const {
      include_evidence,
      response_detail,
      retrieval_hints,
      team_backend_id,
      ...answerInput
    } = input;
    void include_evidence;
    void response_detail;
    void team_backend_id;
    const retrievalScope = defaultAnswerScope(await this.client.accessCheck());
    const workerConfig = execution.directRecall
      ? undefined
      : await resolveLocalMemoryAgentConfig({
          client: this.client,
          flowKey: "mcp_memory_answer",
          fallback: () => resolveMemoryAnswerWorkerConfig(this.environment),
          fromSetting: (setting) =>
            resolveMemoryAnswerWorkerConfig(
              this.environment,
              workerOverridesFromLocalMemorySetting(setting)
            )
        }).then((config) => ({
          ...config,
          cwd:
            execution.taskContext ||
            this.environment.KOED_HEADLESS_FUTURE_CAPTURE_ONLY === "1"
              ? config.cwd
              : caller.cwd
        }));
    if (
      taskAuthority?.scope === "team" &&
      input.search_domain === "project" &&
      (!input.project_id ||
        (!path.isAbsolute(input.project_id) &&
          !path.win32.isAbsolute(input.project_id)))
    ) {
      throw Object.assign(
        new Error(
          "Team Memory Answer task requires an explicit source Project"
        ),
        { memoryAnswerTaskErrorCode: "invalid_project_scope", retryable: false }
      );
    }
    const projectId = input.personal_project_and_me
      ? input.project_id
      : input.search_domain === "project"
        ? normalizeProjectId(input.project_id, caller)
        : input.project_id;
    const teamWorkspaceId =
      taskAuthority?.scope === "team"
        ? taskAuthority.teamWorkspaceId
        : undefined;
    const retrievalClient = execution.taskContext?.taskBackend ?? this.client;
    const currentTeamAuthority = () => {
      const authority = execution.taskContext?.getExecutionAuthority();
      if (!taskAuthority || taskAuthority.scope !== "team") return undefined;
      if (
        !authority ||
        authority.scope !== "team" ||
        authority.teamWorkspaceId !== taskAuthority.teamWorkspaceId
      ) {
        throw Object.assign(new Error("Memory Answer task authority changed"), {
          memoryAnswerTaskErrorCode: "team_scope_changed",
          retryable: false
        });
      }
      return authority;
    };
    const progressAwareRetrievalClient: MemoryAnswerRetrievalClient = {
      search: async (searchInput) => {
        const authority = currentTeamAuthority();
        if (
          input.personal_project_and_me &&
          (authority ||
            searchInput.search_domain !== "project" ||
            searchInput.project_id !== projectId)
        )
          throw new Error("Managed Personal Project recall boundary changed");
        const result = await retrievalClient.search(
          authority
            ? {
                ...searchInput,
                team_workspace_id: authority.teamWorkspaceId,
                authorization_boundary: authority.authorizationBoundary
              }
            : {
                ...searchInput,
                ...(input.personal_project_and_me
                  ? { personal_project_and_me: true }
                  : {})
              }
        );
        execution.onProgress?.("retrieval search completed");
        return result;
      },
      expand: async (nodeId, expandInput) => {
        const authority = currentTeamAuthority();
        const result = await retrievalClient.expand(
          nodeId,
          authority
            ? {
                ...expandInput,
                teamWorkspaceId: authority.teamWorkspaceId,
                authorizationBoundary: authority.authorizationBoundary
              }
            : expandInput
        );
        execution.onProgress?.("memory expansion completed");
        return result;
      }
    };
    execution.onProgress?.("answer synthesis started");
    const evidence = {
      markdown: "",
      ...(taskAuthority?.scope === "team"
        ? { authorizationBoundary: taskAuthority.authorizationBoundary }
        : {}),
      evidenceBundle: {
        query: answerInput.query,
        instructions:
          "Use Koed memory RAG tools to gather and judge evidence before answering.",
        evidence: [],
        retrieval: { mode: "app_server_dynamic_tools" }
      }
    };
    const answer = !workerConfig
      ? await directMemoryRecallAnswer(evidence, {
          client: progressAwareRetrievalClient,
          retrievalScope,
          searchDomain: input.search_domain,
          projectId,
          teamWorkspaceId,
          sessionId: input.session_id,
          recentDays: input.recent_days,
          sourceAfter: input.source_after,
          sourceBefore: input.source_before,
          limit: input.limit,
          retrievalHints: retrieval_hints,
          signal
        })
      : await (this.services.answerWithMemoryWorker ?? answerWithMemoryWorker)(
          evidence,
          {
            config: workerConfig,
            client: progressAwareRetrievalClient,
            retrievalScope,
            searchDomain: input.search_domain,
            projectId,
            teamWorkspaceId,
            sessionId: input.session_id,
            recentDays: input.recent_days,
            sourceAfter: input.source_after,
            sourceBefore: input.source_before,
            limit: input.limit,
            responseDetail: "internal",
            retrievalHints: retrieval_hints,
            conversationContext: execution.conversationContext,
            signal,
            onProgress: execution.onProgress
          }
        );
    execution.onProgress?.("answer synthesis completed");
    if (signal?.aborted) throw new Error("Koed memory request was cancelled");
    let recordedQuestion: McpMemoryQuestion | null = null;
    const finalQuestionInput = answer.localMemoryWorker.usedFallback
      ? {
          idempotency_key:
            execution.idempotencyKey ??
            `memory-answer:${answer.localMemoryWorker.jobId}`,
          query: answerInput.query,
          origin: execution.origin,
          retrieval_scope: retrievalScope,
          search_domain: input.search_domain,
          project_id: projectId,
          team_workspace_id: teamWorkspaceId,
          session_id: input.session_id,
          status: "error",
          error_message: errorMessageFromAnswer(answer),
          attempt_count: 1,
          response: persistedAnswerResponse(answer),
          retrieval: retrievalFromAnswer(answer),
          local_memory_worker: stripAppServerEvents(answer.localMemoryWorker)
        }
      : {
          idempotency_key:
            execution.idempotencyKey ??
            `memory-answer:${answer.localMemoryWorker.jobId}`,
          query: answerInput.query,
          origin: execution.origin,
          retrieval_scope: retrievalScope,
          search_domain: input.search_domain,
          project_id: projectId,
          team_workspace_id: teamWorkspaceId,
          session_id: input.session_id,
          status: "answered",
          answer_markdown: answerMarkdownFromAnswer(answer),
          attempt_count: 1,
          response: persistedAnswerResponse(answer),
          evidence: evidenceFromAnswer(answer),
          citations: citationsFromAnswer(answer),
          retrieval: retrievalFromAnswer(answer),
          local_memory_worker: stripAppServerEvents(answer.localMemoryWorker)
        };
    if (execution.onFinalQuestionPrepared) {
      execution.onFinalQuestionPrepared(finalQuestionInput);
    } else if (execution.pendingQuestionId) {
      recordedQuestion = questionFromResponse(
        await this.client.completePendingDesktopAsk(
          execution.pendingQuestionId,
          finalQuestionInput.status === "answered"
            ? {
                status: "answered",
                answer_markdown: finalQuestionInput.answer_markdown,
                attempt_count: finalQuestionInput.attempt_count,
                response: finalQuestionInput.response,
                evidence: finalQuestionInput.evidence,
                citations: finalQuestionInput.citations,
                retrieval: finalQuestionInput.retrieval,
                local_memory_worker: finalQuestionInput.local_memory_worker
              }
            : {
                status: "error",
                error_message: finalQuestionInput.error_message,
                attempt_count: finalQuestionInput.attempt_count,
                response: finalQuestionInput.response,
                retrieval: finalQuestionInput.retrieval,
                local_memory_worker: finalQuestionInput.local_memory_worker
              }
        )
      );
    } else {
      try {
        recordedQuestion = questionFromResponse(
          await this.client.createFinalQuestion(finalQuestionInput)
        );
      } catch (error) {
        if (execution.requireQuestionPersistence) {
          throw error;
        }
        logger.warn(
          { err: error, jobId: answer.localMemoryWorker.jobId },
          "koed memory_answer question history persistence skipped"
        );
      }
    }
    await this.recordTokenUsage(answer, input, projectId, recordedQuestion);
    if (recordedQuestion) {
      execution.onQuestionRecorded?.(recordedQuestion);
    }
    return {
      ...toolAnswerResponse(answer, requestedResponseDetail),
      ...(recordedQuestion ? { question_id: recordedQuestion.id } : {}),
      ...(input.team_backend_id
        ? { team_backend_id: input.team_backend_id }
        : {})
    };
  }

  private async recordTokenUsage(
    answer: Awaited<ReturnType<typeof answerWithMemoryWorker>>,
    input: MemoryAnswerToolInput,
    projectId: string | undefined,
    recordedQuestion: McpMemoryQuestion | null
  ): Promise<void> {
    const localQuestionId = recordedQuestion?.id;
    const executions = answer.localMemoryWorker.appServerExecutions?.length
      ? answer.localMemoryWorker.appServerExecutions
      : [
          {
            model: answer.localMemoryWorker.model ?? "codex-app-server",
            tokenUsage: answer.localMemoryWorker.tokenUsage,
            threadId: answer.localMemoryWorker.appServerThreadId,
            turnId: answer.localMemoryWorker.appServerTurnId
          }
        ];
    try {
      await Promise.all(
        executions.map(async (execution, executionIndex) => {
          const lastUsage = execution.tokenUsage?.last;
          if (!lastUsage) return;
          await this.client.recordTokenUsage({
            workflowType: "mcp_memory_answer",
            workflowId: answer.localMemoryWorker.jobId,
            questionId: localQuestionId,
            answerJobId: answer.localMemoryWorker.jobId,
            sessionId: input.session_id,
            sourceRuntime: "codex",
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            usageSource: "app_server",
            usageAccuracy: "provider_reported",
            usageKind: "turn_delta",
            connectorClient: "codex",
            model: execution.model,
            modelContextWindow:
              execution.tokenUsage?.modelContextWindow ?? null,
            inputTokens: lastUsage.inputTokens ?? null,
            cachedInputTokens: lastUsage.cachedInputTokens ?? null,
            outputTokens: lastUsage.outputTokens ?? null,
            reasoningOutputTokens: lastUsage.reasoningOutputTokens ?? null,
            totalTokens: lastUsage.totalTokens ?? null,
            usageScope: "last",
            metadata: {
              appServerThreadId:
                execution.primaryThreadId ?? execution.threadId,
              appServerTurnId: execution.turnId,
              questionId: localQuestionId,
              answerJobId: answer.localMemoryWorker.jobId,
              primaryAppServerThreadId: execution.primaryThreadId,
              executionThreadId: execution.threadId,
              executionTurnId: execution.turnId,
              searchDomain: input.search_domain,
              projectId,
              attemptIndex: execution.attemptIndex,
              executionStatus: execution.status ?? "succeeded",
              replacementThreadReason: execution.replacementThreadReason,
              errorMessage: execution.errorMessage,
              executionIndex
            },
            idempotencyKey: `mcp-memory-answer:${answer.localMemoryWorker.jobId}:${executionIndex}:${execution.attemptIndex ?? 1}:last`
          });
        })
      );
    } catch (error) {
      logger.warn(
        { err: error, jobId: answer.localMemoryWorker.jobId },
        "koed memory_answer token telemetry skipped"
      );
    }
  }
}
