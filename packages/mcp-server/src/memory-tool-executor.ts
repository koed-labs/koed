import {
  pinRepositoryRecallContext,
  resolveRequestedProjectRoot
} from "./repository-recall-context.js";
import path from "node:path";
import { pinPersonalRecallRequest } from "./personal-recall-request.js";
import {
  assertPersonalSelectionInput,
  authorizedPersonalSelectionSnapshot,
  snapshotPinnedPersonalSelection,
  personalFolderScopeId,
  repositoryScopeId,
  personalDesktopAskSubmitInputSchema,
  type PersonalSelectionSnapshot
} from "@koed/shared";
import {
  answerWithMemoryWorker,
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
  memoryExpandInputSchema,
  memoryIntakeProposeInputSchema,
  memorySearchInputSchema,
  memoryWorkspacesInputSchema,
  type MemoryAnswerToolInput
} from "./memory-tool-schemas.js";
import { resolveProjectTeamWorkspaceRoute } from "./project-team-workspace-links.js";
import { discoverTeamWorkspaces } from "./team-workspace-discovery.js";
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
  personalSelection?: PersonalSelectionSnapshot;
  pendingQuestionId?: string;
  taskContext?: MemoryAnswerTaskExecutionContext;
  onFinalQuestionPrepared?: (question: Record<string, unknown>) => void;
}

export interface DesktopAskExecutionInput {
  namedProjectId?: string;
  folderSelection?: import("@koed/shared").PersonalFolderReference;
  repositorySelection?: import("@koed/shared").PersonalGitContext;
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
    const input = memoryAnswerInputSchema.parse(rawInput);
    const projectId =
      input.search_domain === "project"
        ? resolveRequestedProjectRoot(input, caller, this.environment)
        : input.project_id;
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
    input = personalDesktopAskSubmitInputSchema.parse(input);
    const targeted = Boolean(
      input.namedProjectId || input.folderSelection || input.repositorySelection
    );
    const pending = desktopAskQuestionFromResponse(
      await this.client.createPendingDesktopAsk({
        ask_thread_id: input.askThreadId,
        named_project_id: input.namedProjectId,
        folder_selection: input.folderSelection,
        repository_selection: input.repositorySelection,
        idempotency_key: input.idempotencyKey,
        query: input.query
      })
    );
    if (pending.status !== "pending") {
      return { question: displaySafeDesktopAskQuestion(pending) };
    }
    const conversationContext =
      !targeted && input.askThreadId
        ? boundedDesktopAskConversationContext(
            await this.client.getDesktopAskThread(pending.askThreadId)
          )
        : [];
    try {
      const ownerUserId = targeted
        ? (await this.client.accessCheck()).user.id
        : undefined;
      const personalSelection: PersonalSelectionSnapshot | undefined =
        targeted && ownerUserId
          ? {
              version: 1,
              ownerUserId,
              target: input.repositorySelection
                ? { kind: "repository", repository: input.repositorySelection }
                : input.folderSelection
                  ? { kind: "folder", folder: input.folderSelection }
                  : {
                      kind: "project",
                      project: { ownerUserId, projectId: input.namedProjectId! }
                    },
              callerRepositoryContext: null
            }
          : undefined;
      await this.executeMemoryAnswer(
        {
          include_evidence: false,
          limit: 10,
          query: pending.query,
          response_detail: "answer_only",
          retrieval_hints: {},
          search_domain: targeted ? "project" : "global",
          ...(targeted
            ? {
                project_id: input.repositorySelection
                  ? repositoryScopeId(input.repositorySelection)
                  : input.folderSelection
                    ? personalFolderScopeId(input.folderSelection)
                    : input.namedProjectId,
                repository_context: input.repositorySelection ?? null
              }
            : {})
        },
        caller,
        {
          origin: "desktop_ask",
          personalSelection,
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
      case "memory_answer": {
        const pinned = await pinPersonalRecallRequest(rawInput, this.client);
        return await this.executeMemoryAnswer(
          pinned.input,
          caller,
          { origin: "mcp_memory_answer", personalSelection: pinned.selection },
          signal
        );
      }
      case "memory_intake_propose": {
        const input = memoryIntakeProposeInputSchema.parse(rawInput);
        const sourceProject =
          input.source_session_id && !input.source_project_id
            ? undefined
            : (
                await pinRepositoryRecallContext(
                  {
                    search_domain: "project",
                    project_id: input.source_project_id
                  },
                  caller,
                  this.environment,
                  this.client.resolveProjectRouting?.bind(this.client)
                )
              ).project_id;
        const result = await this.client.proposeCuratedMemory({
          ...input,
          source_project_id: sourceProject,
          created_by_model: "codex",
          created_by_prompt_version: "memory-intake-propose-mcp-v1"
        });
        this.services.curatedMemoryReviewService?.nudge("proposal_created");
        return result;
      }
      case "memory_search": {
        const input = memorySearchInputSchema.parse(rawInput);
        const pinned = await pinRepositoryRecallContext(
          input,
          caller,
          this.environment,
          this.client.resolveProjectRouting?.bind(this.client)
        );
        const { repository_context: _context, ...search } = input;
        void _context;
        return await this.client.search({
          ...search,
          retrieval_scope: "personal",
          project_id: pinned.project_id,
          repository_context: pinned.repository_context
        });
      }
      case "memory_expand": {
        const input = memoryExpandInputSchema.parse(rawInput);
        const pinned = await pinRepositoryRecallContext(
          input,
          caller,
          this.environment,
          this.client.resolveProjectRouting?.bind(this.client)
        );
        return await this.client.expand(input.nodeId, {
          searchDomain: input.search_domain,
          projectId: pinned.project_id,
          sessionId: input.session_id,
          recentDays: input.recent_days,
          sourceAfter: input.source_after,
          sourceBefore: input.source_before
        });
      }
    }
  }

  async executeMemoryAnswerTask(
    input: MemoryAnswerToolInput,
    caller: LocalRuntimeCallerContext,
    taskId: string,
    signal?: AbortSignal,
    onProgress?: (status: string) => void,
    context?: MemoryAnswerTaskExecutionContext
  ): Promise<{
    finalQuestion: Record<string, unknown>;
    result: Record<string, unknown>;
  }> {
    const nonRepositorySelection =
      context?.personalSelection?.version === 1 &&
      (context.personalSelection.target.kind === "project" ||
        context.personalSelection.target.kind === "folder");
    input = memoryAnswerInputSchema.parse(
      nonRepositorySelection
        ? { ...input, repository_context: undefined }
        : input
    );
    if (nonRepositorySelection) input = { ...input, repository_context: null };
    const authority = context?.getExecutionAuthority() ?? {
      scope: "personal" as const
    };
    if (
      authority.scope === "personal" &&
      !nonRepositorySelection &&
      !this.personalMemoryAnswerEligible(input, caller)
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
      input.team_workspace_id &&
      input.team_workspace_id !== authority.teamWorkspaceId
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
      input,
      caller,
      {
        origin: "mcp_memory_answer",
        idempotencyKey: `memory-answer-task:${taskId}`,
        taskContext: context,
        onProgress,
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
    input: MemoryAnswerToolInput,
    caller: LocalRuntimeCallerContext,
    execution: TrustedMemoryAnswerExecutionOptions,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    if (execution.origin === "desktop_ask" && !execution.pendingQuestionId) {
      throw new Error("Desktop Ask requires a durable pending question");
    }
    const taskAuthority = execution.taskContext?.getExecutionAuthority();
    const acceptedSelection =
      execution.taskContext?.personalSelection ?? execution.personalSelection;
    const nonRepositorySelection =
      acceptedSelection?.version === 1 &&
      (acceptedSelection.target.kind === "project" ||
        acceptedSelection.target.kind === "folder");
    const desktopSelection =
      execution.origin === "desktop_ask" && acceptedSelection?.version === 1;
    if (
      taskAuthority?.scope !== "team" &&
      (input.team_workspace_id ||
        input.team_backend_id ||
        (!taskAuthority &&
          !nonRepositorySelection &&
          !desktopSelection &&
          resolveProjectTeamWorkspaceRoute({
            projectRoot:
              input.search_domain === "project"
                ? resolveRequestedProjectRoot(input, caller, this.environment)
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
    if (
      !nonRepositorySelection &&
      !desktopSelection &&
      !input.team_workspace_id &&
      taskAuthority?.scope !== "team" &&
      (input.search_domain === "project" || input.search_domain === "global")
    ) {
      if (
        execution.taskContext &&
        (input.repository_context === undefined ||
          (input.search_domain === "project" && !input.repository_context))
      )
        throw Object.assign(
          new Error(
            "Accepted memory task is missing pinned repository context"
          ),
          {
            memoryAnswerTaskErrorCode: "personal_selection_incompatible",
            retryable: false
          }
        );
      input = await pinRepositoryRecallContext(
        input,
        caller,
        this.environment,
        this.client.resolveProjectRouting?.bind(this.client)
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
    const access = await this.client.accessCheck();
    const retrievalScope = defaultAnswerScope(access);
    const personalSelection =
      taskAuthority?.scope === "team"
        ? undefined
        : acceptedSelection
          ? authorizedPersonalSelectionSnapshot(
              acceptedSelection,
              access.user.id
            )
          : snapshotPinnedPersonalSelection(access.user.id, input);
    if (personalSelection)
      assertPersonalSelectionInput(personalSelection, input);
    const workerConfig = await resolveLocalMemoryAgentConfig({
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
        nonRepositorySelection ||
        desktopSelection ||
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
    const projectId =
      input.search_domain === "project" && taskAuthority?.scope === "team"
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
        const result = await retrievalClient.search(
          authority
            ? {
                ...searchInput,
                team_workspace_id: authority.teamWorkspaceId,
                authorization_boundary: authority.authorizationBoundary
              }
            : { ...searchInput, personal_selection: personalSelection }
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
            : { ...expandInput, personalSelection }
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
    const answer = await (
      this.services.answerWithMemoryWorker ?? answerWithMemoryWorker
    )(evidence, {
      config: workerConfig,
      client: progressAwareRetrievalClient,
      retrievalScope,
      searchDomain: input.search_domain,
      repositoryContext:
        retrievalScope === "personal" ? input.repository_context : undefined,
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
    });
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
    return toolAnswerResponse(answer, requestedResponseDetail);
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
