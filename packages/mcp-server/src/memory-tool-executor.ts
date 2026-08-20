import os from "node:os";
import path from "node:path";
import { readLocalEdgeClientCredentialAuthorization } from "@koed/shared";
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
  type MemoryAnswerToolInput
} from "./memory-tool-schemas.js";
import { resolveProjectTeamWorkspaceRoute } from "./project-team-workspace-links.js";
import type {
  LocalRuntimeCallerContext,
  LocalRuntimeToolName
} from "./local-runtime-protocol.js";

type McpMemoryQuestion = { id: string };

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
  projectId && path.isAbsolute(projectId)
    ? projectId
    : path.resolve(caller.cwd);

class LocalEdgeTeamMemoryClient implements MemoryAnswerRetrievalClient {
  constructor(
    private readonly client: MemoryApiClient,
    private readonly upstreamBackendId: string,
    private readonly authorization: string
  ) {}

  async search(
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return await this.client.teamMemorySearch(
      this.upstreamBackendId,
      input,
      this.authorization
    );
  }

  async expand(
    nodeId: string,
    input: {
      searchDomain?: string;
      sessionId?: string;
      projectId?: string;
      teamWorkspaceId?: string;
      recentDays?: number;
      sourceAfter?: string;
      sourceBefore?: string;
      authorizationBoundary?: string;
    } = {}
  ): Promise<Record<string, unknown>> {
    return await this.client.teamMemoryExpand(
      this.upstreamBackendId,
      nodeId,
      {
        search_domain: input.searchDomain,
        session_id: input.sessionId,
        project_id: input.projectId,
        team_workspace_id: input.teamWorkspaceId,
        recent_days: input.recentDays,
        source_after: input.sourceAfter,
        source_before: input.sourceBefore,
        authorization_boundary: input.authorizationBoundary
      },
      this.authorization
    );
  }
}

export interface MemoryToolExecutorServices {
  lcmSummaryService?: LcmSummaryServiceHandle | null;
  curatedMemoryReviewService?: LocalCuratedMemoryReviewServiceHandle | null;
  answerWithMemoryWorker?: typeof answerWithMemoryWorker;
}

export interface TrustedMemoryAnswerExecutionOptions {
  conversationContext?: readonly MemoryAnswerConversationTurn[];
  origin: "desktop_ask" | "mcp_memory_answer";
  pendingQuestionId?: string;
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

  async executeMemoryAnswer(
    input: MemoryAnswerToolInput,
    caller: LocalRuntimeCallerContext,
    execution: TrustedMemoryAnswerExecutionOptions,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    if (execution.origin === "desktop_ask" && !execution.pendingQuestionId) {
      throw new Error("Desktop Ask requires a durable pending question");
    }
    const requestedResponseDetail: MemoryAnswerResponseDetail =
      input.include_evidence ? "with_evidence" : input.response_detail;
    const {
      include_evidence,
      response_detail,
      retrieval_hints,
      ...answerInput
    } = input;
    void include_evidence;
    void response_detail;
    const retrievalScope = defaultAnswerScope(await this.client.accessCheck());
    const workerConfig = await resolveLocalMemoryAgentConfig({
      client: this.client,
      flowKey: "mcp_memory_answer",
      fallback: () => resolveMemoryAnswerWorkerConfig(this.environment),
      fromSetting: (setting) =>
        resolveMemoryAnswerWorkerConfig(
          this.environment,
          workerOverridesFromLocalMemorySetting(setting)
        )
    }).then((config) => ({ ...config, cwd: caller.cwd }));
    const projectId =
      input.search_domain === "project"
        ? normalizeProjectId(input.project_id, caller)
        : input.project_id;
    const teamWorkspaceRoute = resolveProjectTeamWorkspaceRoute({
      projectRoot: input.search_domain === "project" ? projectId : undefined,
      requestedTeamWorkspaceId: input.team_workspace_id,
      env: this.environment
    });
    const teamWorkspaceId = teamWorkspaceRoute.teamWorkspaceId;
    const upstreamBackendId = teamWorkspaceRoute.backendId;
    if (teamWorkspaceId && !upstreamBackendId) {
      return {
        markdown:
          "Team Workspace recall is configured for this request, but no upstream Team Backend id is available. Link this Project to a Team Workspace backend.",
        evidenceBundle: {
          query: answerInput.query,
          instructions:
            "Team Workspace recall was requested but no local-edge upstream backend id was available.",
          evidence: [],
          retrieval: {
            mode: "team_workspace_upstream_backend_unavailable",
            teamWorkspaceId
          }
        }
      };
    }
    const localEdgeClientCredential = upstreamBackendId
      ? readLocalEdgeClientCredentialAuthorization(
          path.resolve(
            this.environment.KOED_HOME?.trim() ||
              path.join(os.homedir(), ".koed")
          ),
          upstreamBackendId
        )
      : null;
    if (teamWorkspaceId && upstreamBackendId && !localEdgeClientCredential) {
      return {
        markdown:
          "Team Workspace recall is configured, but this local Koed runtime has no scoped local-edge client credential. Reconnect the Team Backend from Koed Desktop.",
        evidenceBundle: {
          query: answerInput.query,
          instructions:
            "Team Workspace recall was requested without a scoped local-edge client credential.",
          evidence: [],
          retrieval: {
            mode: "team_workspace_local_credential_unavailable",
            teamWorkspaceId,
            upstreamBackendId
          }
        }
      };
    }
    const retrievalClient =
      teamWorkspaceId && upstreamBackendId
        ? new LocalEdgeTeamMemoryClient(
            this.client,
            upstreamBackendId,
            localEdgeClientCredential!.authorization
          )
        : this.client;
    const evidence =
      teamWorkspaceId && upstreamBackendId
        ? await this.client.teamMemoryAnswer(
            upstreamBackendId,
            {
              ...answerInput,
              team_workspace_id: teamWorkspaceId,
              project_id: projectId,
              retrieval_stage: "score_scan"
            },
            localEdgeClientCredential!.authorization
          )
        : {
            markdown: "",
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
      client: retrievalClient,
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
      signal
    });
    if (signal?.aborted) throw new Error("Koed memory request was cancelled");
    let recordedQuestion: McpMemoryQuestion | null = null;
    const finalQuestionInput = answer.localMemoryWorker.usedFallback
      ? {
          idempotency_key: `memory-answer:${answer.localMemoryWorker.jobId}`,
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
          idempotency_key: `memory-answer:${answer.localMemoryWorker.jobId}`,
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
    if (execution.pendingQuestionId) {
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
          teamWorkspaceId && upstreamBackendId
            ? await this.client.createFinalTeamQuestion(
                upstreamBackendId,
                finalQuestionInput,
                localEdgeClientCredential!.authorization
              )
            : await this.client.createFinalQuestion(finalQuestionInput)
        );
      } catch (error) {
        logger.warn(
          { err: error, jobId: answer.localMemoryWorker.jobId },
          "koed memory_answer question history persistence skipped"
        );
      }
    }
    await this.recordTokenUsage(
      answer,
      input,
      projectId,
      recordedQuestion,
      upstreamBackendId
    );
    return toolAnswerResponse(answer, requestedResponseDetail);
  }

  private async recordTokenUsage(
    answer: Awaited<ReturnType<typeof answerWithMemoryWorker>>,
    input: MemoryAnswerToolInput,
    projectId: string | undefined,
    recordedQuestion: McpMemoryQuestion | null,
    upstreamBackendId: string | undefined
  ): Promise<void> {
    const upstreamQuestionId = upstreamBackendId
      ? recordedQuestion?.id
      : undefined;
    const localQuestionId = upstreamBackendId
      ? undefined
      : recordedQuestion?.id;
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
              upstreamQuestionId,
              upstreamBackendId,
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
