import os from "node:os";
import path from "node:path";
import { readLocalEdgeClientCredentialAuthorization } from "@koed/shared";
import {
  answerWithMemoryWorker,
  type MemoryAnswerRetrievalClient,
  type MemoryAnswerResponseDetail,
  resolveMemoryAnswerWorkerConfig
} from "./answer-worker.js";
import type { CuratedMemoryReviewServiceHandle as LocalCuratedMemoryReviewServiceHandle } from "./curated-memory-review-service.js";
import {
  MemoryApiClient,
  backendToolCapabilitiesFrom,
  defaultAnswerScope,
  localMemoryAgentSettingFor,
  memoryAccessCheck,
  workerOverridesFromLocalMemorySetting,
  type BackendToolCapabilities
} from "./index.js";
import type { LcmSummaryServiceHandle } from "./lcm-summary-service.js";
import { logger } from "./logger.js";
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
        source_before: input.sourceBefore
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

export class MemoryToolExecutor {
  constructor(
    readonly client: MemoryApiClient,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly services: MemoryToolExecutorServices = {}
  ) {}

  async capabilities(): Promise<BackendToolCapabilities> {
    return backendToolCapabilitiesFrom(await this.client.capabilities());
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
        return await this.memoryAnswer(
          memoryAnswerInputSchema.parse(rawInput),
          caller,
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

  private async memoryAnswer(
    input: MemoryAnswerToolInput,
    caller: LocalRuntimeCallerContext,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const requestedResponseDetail: MemoryAnswerResponseDetail =
      input.include_evidence ? "with_evidence" : input.response_detail;
    const { include_evidence, response_detail, ...answerInput } = input;
    void include_evidence;
    void response_detail;
    const retrievalScope = defaultAnswerScope(await this.client.accessCheck());
    const localAgentSettings = await this.client
      .listLocalMemoryAgentSettings()
      .then((response) => response.settings)
      .catch(() => []);
    const workerConfig = {
      ...resolveMemoryAnswerWorkerConfig(
        this.environment,
        workerOverridesFromLocalMemorySetting(
          localMemoryAgentSettingFor(localAgentSettings, "mcp_memory_answer")
        )
      ),
      cwd: caller.cwd
    };
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
    const evidence = {
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
      responseDetail: "with_evidence",
      signal
    });
    if (signal?.aborted) throw new Error("Koed memory request was cancelled");
    let recordedQuestion: McpMemoryQuestion | null = null;
    try {
      recordedQuestion = questionFromResponse(
        await this.client.createFinalQuestion(
          answer.localMemoryWorker.usedFallback
            ? {
                idempotency_key: `memory-answer:${answer.localMemoryWorker.jobId}`,
                query: answerInput.query,
                origin: "mcp_memory_answer",
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
                local_memory_worker: stripAppServerEvents(
                  answer.localMemoryWorker
                )
              }
            : {
                idempotency_key: `memory-answer:${answer.localMemoryWorker.jobId}`,
                query: answerInput.query,
                origin: "mcp_memory_answer",
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
                local_memory_worker: stripAppServerEvents(
                  answer.localMemoryWorker
                )
              }
        )
      );
    } catch (error) {
      logger.warn(
        { err: error, jobId: answer.localMemoryWorker.jobId },
        "koed memory_answer question history persistence skipped"
      );
    }
    await this.recordTokenUsage(answer, input, projectId, recordedQuestion);
    return toolAnswerResponse(answer, requestedResponseDetail);
  }

  private async recordTokenUsage(
    answer: Awaited<ReturnType<typeof answerWithMemoryWorker>>,
    input: MemoryAnswerToolInput,
    projectId: string | undefined,
    recordedQuestion: McpMemoryQuestion | null
  ): Promise<void> {
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
            questionId: recordedQuestion?.id,
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
              questionId: recordedQuestion?.id,
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
