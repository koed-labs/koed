#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CURATED_MEMORY_REVIEW_MAX_EVIDENCE,
  readLocalEdgeClientCredentialAuthorization
} from "@koed/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  answerWithMemoryWorker,
  type MemoryAnswerRetrievalClient,
  type MemoryAnswerResponseDetail,
  resolveMemoryAnswerWorkerConfig
} from "./answer-worker.js";
import { startAnswerBridgeWithRetry } from "./answer-bridge-lifecycle.js";
import {
  MemoryApiClient,
  backendToolCapabilitiesFrom,
  type McpServerConfig,
  defaultAnswerScope,
  defaultConfig,
  exposedTools,
  localMemoryAgentSettingFor,
  memoryAnswerToolDescription,
  memoryAccessCheck,
  memoryIntakeProposeToolDescription,
  memoryServerInstructions,
  workerOverridesFromLocalMemorySetting,
  resolveToolExposureConfig,
  unavailableBackendToolCapabilities
} from "./index.js";
import {
  resolveLcmSummaryWorkerConfig,
  summarizePendingLcmNodes
} from "./lcm-summary-worker.js";
import {
  resolvePersistedLcmSummaryWorkerConfig,
  resolveLcmSummaryServiceConfig,
  startLcmSummaryService
} from "./lcm-summary-service.js";
import { generatePendingSessionTitles } from "./session-title-worker.js";
import { startCuratedMemoryReviewService } from "./curated-memory-review-service.js";
import { resolveCuratedMemoryReviewConfig } from "./curated-memory-review-worker.js";
import { startCodexTranscriptWatcher } from "./codex-transcript-watcher.js";
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
import { logger } from "./logger.js";
import { resolveProjectTeamWorkspaceRoute } from "./project-team-workspace-links.js";

const parseArgs = (
  args: string[]
): {
  command?: string;
  configPath?: string;
  options: Record<string, string>;
} => {
  const parsed: {
    command?: string;
    configPath?: string;
    options: Record<string, string>;
  } = { options: {} };

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value) {
      continue;
    }
    if (value === "--config") {
      parsed.configPath = args[index + 1];
      index += 1;
      continue;
    }

    if (value.startsWith("--")) {
      const key = value.slice(2);
      const next = args[index + 1];
      if (next && !next.startsWith("--")) {
        parsed.options[key] = next;
        index += 1;
      }
      continue;
    }

    if (!parsed.command) {
      parsed.command = value;
    }
  }

  return parsed;
};

const expandHome = (path: string): string =>
  path.replace(/^~(?=$|\/)/, process.env.HOME ?? "~");

export const loadConfig = (configPath?: string): McpServerConfig => {
  const envConfig = defaultConfig();

  if (!configPath) {
    return envConfig;
  }

  const fileConfig = JSON.parse(
    fs.readFileSync(expandHome(configPath), "utf8")
  ) as Partial<
    McpServerConfig & {
      baseUrl: string;
      apiToken: string;
    }
  >;

  return {
    apiUrl: fileConfig.apiUrl ?? fileConfig.baseUrl ?? envConfig.apiUrl,
    apiToken: fileConfig.apiToken ?? envConfig.apiToken
  };
};

const jsonResponse = (payload: unknown) => ({
  structuredContent: payload as Record<string, unknown>,
  content: [
    {
      type: "text" as const,
      text: JSON.stringify(payload, null, 2)
    }
  ]
});

type McpMemoryQuestion = {
  id: string;
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

const searchDomainSchema = z.enum(["global", "project", "session"]);
const memoryAnswerResponseDetailSchema = z.enum([
  "answer_only",
  "with_citations",
  "with_evidence"
]);
const uuidSchema = z.string().uuid();
const defaultWorkspaceId = (): string => process.cwd();
const normalizeToolWorkspaceId = (workspaceId?: string): string =>
  workspaceId && path.isAbsolute(workspaceId)
    ? workspaceId
    : defaultWorkspaceId();

class LocalEdgeTeamMemoryClient implements MemoryAnswerRetrievalClient {
  constructor(
    private readonly client: MemoryApiClient,
    private readonly upstreamBackendId: string,
    private readonly authorization: string
  ) {}

  async search(
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return await this.client.upstreamOperation(
      {
        upstreamBackendId: this.upstreamBackendId,
        operationFamily: "team_workspace_read",
        method: "POST",
        path: "/v1/memory/search",
        body: input
      },
      this.authorization
    );
  }

  async expand(
    nodeId: string,
    input: {
      searchDomain?: string;
      sessionId?: string;
      workspaceId?: string;
      teamWorkspaceId?: string;
      recentDays?: number;
      sourceAfter?: string;
      sourceBefore?: string;
    } = {}
  ): Promise<Record<string, unknown>> {
    const params = new URLSearchParams();
    if (input.searchDomain) params.set("search_domain", input.searchDomain);
    if (input.sessionId) params.set("session_id", input.sessionId);
    if (input.workspaceId) params.set("workspace_id", input.workspaceId);
    if (input.teamWorkspaceId) {
      params.set("team_workspace_id", input.teamWorkspaceId);
    }
    if (input.recentDays !== undefined) {
      params.set("recent_days", String(input.recentDays));
    }
    if (input.sourceAfter) params.set("source_after", input.sourceAfter);
    if (input.sourceBefore) params.set("source_before", input.sourceBefore);
    const query = params.toString();
    return await this.client.upstreamOperation(
      {
        upstreamBackendId: this.upstreamBackendId,
        operationFamily: "team_workspace_read",
        method: "GET",
        path: `/v1/memory/nodes/${encodeURIComponent(nodeId)}/expand${
          query ? `?${query}` : ""
        }`
      },
      this.authorization
    );
  }
}

const {
  command,
  configPath,
  options: cliOptions
} = parseArgs(process.argv.slice(2));
const config = loadConfig(configPath);
const client = new MemoryApiClient(config);
const toolExposure = resolveToolExposureConfig();

const positiveIntOption = (name: string): number | undefined => {
  const value = cliOptions[name];
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

if (command === "doctor") {
  try {
    const accessCheck = await memoryAccessCheck(client);
    console.log(
      JSON.stringify(
        {
          ok: true,
          apiUrl: client.config.apiUrl,
          hasApiToken: Boolean(client.config.apiToken),
          tools: accessCheck.exposedTools,
          accessCheck
        },
        null,
        2
      )
    );
    process.exit(0);
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          apiUrl: client.config.apiUrl,
          hasApiToken: Boolean(client.config.apiToken),
          error: error instanceof Error ? error.message : String(error)
        },
        null,
        2
      )
    );
    process.exit(1);
  }
}

if (command === "watch-codex-transcripts") {
  const watcher = startCodexTranscriptWatcher(client);
  const stop = async () => {
    await watcher.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  logger.info("Codex Transcript Watcher started");
  await new Promise(() => undefined);
}

if (command === "process-local-memory") {
  const delayMs = positiveIntOption("delay-ms");
  if (delayMs) {
    await sleep(delayMs);
  }
  const serviceConfig = resolveLcmSummaryServiceConfig(process.env);
  const summaryConfig = await resolvePersistedLcmSummaryWorkerConfig(
    client,
    process.env,
    {
      model: cliOptions.model,
      reasoningEffort: cliOptions["reasoning-effort"],
      timeoutMs: positiveIntOption("timeout-ms"),
      maxAttempts: positiveIntOption("max-attempts"),
      retryDelayMs: positiveIntOption("retry-delay-ms"),
      concurrency: positiveIntOption("concurrency")
    }
  );
  const sessionTitles = await generatePendingSessionTitles(client, {
    limit: positiveIntOption("title-limit") ?? serviceConfig.titleBatchLimit,
    minUserEvents:
      positiveIntOption("title-min-user-events") ??
      serviceConfig.titleMinUserEvents,
    config: summaryConfig
  });
  const lcmSummaries = await summarizePendingLcmNodes(client, {
    limit: positiveIntOption("limit"),
    config: summaryConfig
  });
  console.log(
    JSON.stringify(
      {
        sessionTitles,
        lcmSummaries
      },
      null,
      2
    )
  );
  process.exit(0);
}

if (command) {
  logger.error({ command }, "unknown koed MCP command");
  process.exit(1);
}

const backendToolCapabilities = await client
  .capabilities()
  .then(backendToolCapabilitiesFrom)
  .catch((error) => {
    logger.warn(
      { err: error, apiUrl: client.config.apiUrl },
      "backend capabilities unavailable; capability-gated MCP tools disabled"
    );
    return unavailableBackendToolCapabilities;
  });
const activeTools = exposedTools(toolExposure, backendToolCapabilities);

const server = new McpServer(
  {
    name: "koed-mcp",
    title: "Koed Memory",
    version: "0.1.0"
  },
  {
    instructions: memoryServerInstructions
  }
);
const backgroundLcmSummaryService = startLcmSummaryService(client, {
  serviceConfig: resolveLcmSummaryServiceConfig(process.env),
  workerConfig: resolveLcmSummaryWorkerConfig(process.env)
});
const backgroundCuratedMemoryReviewService = startCuratedMemoryReviewService(
  client,
  { workerConfig: resolveCuratedMemoryReviewConfig(process.env) }
);
const answerBridgeHandle = startAnswerBridgeWithRetry();
logger.info(
  {
    apiUrl: client.config.apiUrl,
    tools: activeTools,
    bridgeEnabled:
      process.env.MEMORY_ANSWER_BRIDGE_ENABLED?.trim().toLowerCase() !== "false"
  },
  "koed MCP server starting"
);

if (toolExposure.exposeDiagnosticMemoryTools) {
  server.registerTool(
    "memory_access_check",
    {
      title: "Memory access check",
      description:
        "Diagnostic tool for validating MEMORY_API_URL and MEMORY_API_TOKEN against /v1/access/check. Normal agents should call memory_answer for recall; use the CLI doctor command for setup checks without expanding the default MCP schema.",
      inputSchema: {
        include_notes: z
          .boolean()
          .optional()
          .describe("Include integration guidance notes. Defaults to true.")
      }
    },
    async ({ include_notes = true }) =>
      jsonResponse(
        await memoryAccessCheck(client, include_notes, {
          lcmSummaryService: backgroundLcmSummaryService,
          curatedMemoryReviewService: backgroundCuratedMemoryReviewService
        })
      )
  );
}

server.registerTool(
  "memory_answer",
  {
    title: "Answer from memory",
    description: memoryAnswerToolDescription,
    inputSchema: {
      query: z.string().min(1).describe("Question to answer from memory."),
      response_detail: memoryAnswerResponseDetailSchema
        .default("answer_only")
        .describe(
          "Response detail level. answer_only returns compact markdown and localMemoryWorker status metadata. with_citations adds citation/source metadata without evidence. with_evidence returns the full evidence bundle for debugging or UI inspection."
        ),
      search_domain: searchDomainSchema
        .default("project")
        .describe(
          "Search boundary. Use project for the current workspace/project, session for one conversation thread, or global across all visible memory."
        ),
      workspace_id: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Project/workspace identifier for project search. Defaults to this Codex process cwd."
        ),
      session_id: uuidSchema
        .optional()
        .describe("Backend session UUID for session search."),
      team_workspace_id: uuidSchema
        .optional()
        .describe(
          "Optional Team Workspace UUID for Team-shared Memory recall. Requires backend session or scoped device authorization; API Token-only MCP setups fail closed."
        ),
      recent_days: z
        .number()
        .int()
        .positive()
        .max(36500)
        .optional()
        .describe(
          "Optional recency window in days over source memory-event timestamps. For example, 30 searches only memory whose underlying source events are within the last 30 days. Leave blank for full-history recall."
        ),
      source_after: z
        .string()
        .datetime()
        .optional()
        .describe(
          "Optional ISO timestamp lower bound over source memory-event timestamps. Do not combine with recent_days."
        ),
      source_before: z
        .string()
        .datetime()
        .optional()
        .describe(
          "Optional ISO timestamp upper bound over source memory-event timestamps. Do not combine with recent_days."
        ),
      limit: z.number().int().positive().max(50).default(10),
      include_evidence: z
        .boolean()
        .default(false)
        .describe(
          "Return the full evidence bundle for debugging. Defaults to false for compact agent context."
        )
    }
  },
  async (input) => {
    const requestedResponseDetail: MemoryAnswerResponseDetail =
      input.include_evidence ? "with_evidence" : input.response_detail;
    logger.info(
      {
        searchDomain: input.search_domain,
        responseDetail: requestedResponseDetail,
        hasWorkspaceId: Boolean(input.workspace_id),
        hasTeamWorkspaceId: Boolean(input.team_workspace_id),
        hasSessionId: Boolean(input.session_id),
        hasRecentDays: input.recent_days !== undefined,
        hasSourceAfter: input.source_after !== undefined,
        hasSourceBefore: input.source_before !== undefined,
        limit: input.limit,
        queryLength: input.query.length
      },
      "memory_answer tool call started"
    );
    const { include_evidence, response_detail, ...answerInput } = input;
    void include_evidence;
    void response_detail;
    const retrieval_scope = defaultAnswerScope(await client.accessCheck());
    const localAgentSettings = await client
      .listLocalMemoryAgentSettings()
      .then((response) => response.settings)
      .catch(() => []);
    const workerConfig = resolveMemoryAnswerWorkerConfig(
      process.env,
      workerOverridesFromLocalMemorySetting(
        localMemoryAgentSettingFor(localAgentSettings, "mcp_memory_answer")
      )
    );
    const workspace_id =
      input.search_domain === "project"
        ? normalizeToolWorkspaceId(input.workspace_id)
        : input.workspace_id;
    const teamWorkspaceRoute = resolveProjectTeamWorkspaceRoute({
      projectRoot: input.search_domain === "project" ? workspace_id : undefined,
      requestedTeamWorkspaceId: input.team_workspace_id,
      env: process.env
    });
    const team_workspace_id = teamWorkspaceRoute.teamWorkspaceId;
    const upstream_backend_id = teamWorkspaceRoute.backendId;
    if (team_workspace_id && !upstream_backend_id) {
      return jsonResponse({
        markdown:
          "Team Workspace recall is configured for this request, but no upstream Team Backend id is available. Link this Project to a Team Workspace backend or set KOED_TEAM_UPSTREAM_BACKEND_ID for explicit Team Workspace calls.",
        evidenceBundle: {
          query: answerInput.query,
          instructions:
            "Team Workspace recall was requested but no local-edge upstream backend id was available.",
          evidence: [],
          retrieval: {
            mode: "team_workspace_upstream_backend_unavailable",
            teamWorkspaceId: team_workspace_id,
            followUpIssue: "KOE-311"
          }
        }
      });
    }
    const localEdgeClientCredential = upstream_backend_id
      ? readLocalEdgeClientCredentialAuthorization(
          path.resolve(
            process.env.KOED_HOME?.trim() || path.join(os.homedir(), ".koed")
          ),
          upstream_backend_id
        )
      : null;
    if (
      team_workspace_id &&
      upstream_backend_id &&
      !localEdgeClientCredential
    ) {
      return jsonResponse({
        markdown:
          "Team Workspace recall is configured, but this MCP installation has no scoped local-edge client credential. Reconnect the Team Backend from Koed Desktop.",
        evidenceBundle: {
          query: answerInput.query,
          instructions:
            "Team Workspace recall was requested without a scoped local-edge client credential.",
          evidence: [],
          retrieval: {
            mode: "team_workspace_local_credential_unavailable",
            teamWorkspaceId: team_workspace_id,
            upstreamBackendId: upstream_backend_id
          }
        }
      });
    }
    const retrievalClient =
      team_workspace_id && upstream_backend_id
        ? new LocalEdgeTeamMemoryClient(
            client,
            upstream_backend_id,
            localEdgeClientCredential!.authorization
          )
        : client;
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
    const answer = await answerWithMemoryWorker(evidence, {
      config: workerConfig,
      client: retrievalClient,
      retrievalScope: retrieval_scope,
      searchDomain: input.search_domain,
      workspaceId: workspace_id,
      teamWorkspaceId: team_workspace_id,
      sessionId: input.session_id,
      recentDays: input.recent_days,
      sourceAfter: input.source_after,
      sourceBefore: input.source_before,
      limit: input.limit,
      responseDetail: "with_evidence"
    });
    let recordedQuestion: McpMemoryQuestion | null = null;
    try {
      recordedQuestion = questionFromResponse(
        await client.createFinalQuestion(
          answer.localMemoryWorker.usedFallback
            ? {
                query: answerInput.query,
                origin: "mcp_memory_answer",
                retrieval_scope,
                search_domain: input.search_domain,
                workspace_id,
                team_workspace_id,
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
                query: answerInput.query,
                origin: "mcp_memory_answer",
                retrieval_scope,
                search_domain: input.search_domain,
                workspace_id,
                team_workspace_id,
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
        {
          err: error,
          jobId: answer.localMemoryWorker.jobId
        },
        "koed memory_answer question history persistence skipped"
      );
    }
    logger.info(
      {
        jobId: answer.localMemoryWorker.jobId,
        questionId: recordedQuestion?.id,
        memoryStatus: answer.localMemoryWorker.memoryStatus,
        usedFallback: answer.localMemoryWorker.usedFallback,
        skippedReason: answer.localMemoryWorker.skippedReason,
        markdownLength: answer.markdown?.length ?? 0
      },
      "memory_answer tool call completed"
    );
    const executions =
      answer.localMemoryWorker.appServerExecutions &&
      answer.localMemoryWorker.appServerExecutions.length > 0
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
          if (!lastUsage) {
            return;
          }
          await client.recordTokenUsage({
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
              workspaceId: workspace_id,
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
        {
          err: error,
          jobId: answer.localMemoryWorker.jobId
        },
        "koed memory_answer token telemetry skipped"
      );
    }
    return jsonResponse(toolAnswerResponse(answer, requestedResponseDetail));
  }
);

if (backendToolCapabilities.curatedMemoryIntakeAvailable) {
  server.registerTool(
    "memory_intake_propose",
    {
      title: "Propose Curated Memory",
      description: memoryIntakeProposeToolDescription,
      inputSchema: {
        proposed_claim: z
          .string()
          .min(1)
          .max(4000)
          .describe(
            "A concise candidate fact, preference, decision, plan, or correction. A separate local review agent verifies and rewrites it from the supplied evidence."
          ),
        proposed_topic: z
          .string()
          .min(1)
          .max(500)
          .optional()
          .describe("Optional semantic place/topic for the fact."),
        rationale: z
          .string()
          .max(4000)
          .optional()
          .describe("Why this looks durable and useful to remember."),
        tags: z.array(z.string().min(1).max(80)).max(20).default([]),
        sensitivity_hint: z
          .enum(["normal", "sensitive", "review_required"])
          .default("normal"),
        expires_at: z
          .string()
          .datetime({ offset: true })
          .optional()
          .describe(
            "Optional ISO 8601 timestamp after which this Curated Memory must not be recalled."
          ),
        evidence_conversation_item_ids: z
          .array(uuidSchema)
          .max(CURATED_MEMORY_REVIEW_MAX_EVIDENCE)
          .default([])
          .describe("Conversation item UUIDs that directly support the claim."),
        evidence_memory_event_ids: z
          .array(uuidSchema)
          .max(CURATED_MEMORY_REVIEW_MAX_EVIDENCE)
          .default([])
          .describe(
            "Optional Memory Event UUIDs that directly support the claim."
          ),
        evidence_exact_quote: z
          .string()
          .min(1)
          .max(16_000)
          .optional()
          .describe(
            "The exact supporting User statement. Required when evidence IDs and source_session_id are unavailable; ambiguous matches fail closed."
          ),
        operation: z
          .enum(["store", "merge", "supersede", "conflict"])
          .default("store")
          .describe(
            "Optional operation hint for the local reviewer: store, merge duplicate evidence, supersede a correction, or record a conflict. The reviewer makes the final decision."
          ),
        target_assertion_id: uuidSchema
          .optional()
          .describe(
            "Optional current Curated Memory assertion ID that may be relevant to a duplicate, correction, or conflict."
          ),
        source_workspace_id: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Workspace path used to resolve the current user-authored evidence server-side. Defaults to the current Codex workspace."
          ),
        source_session_id: uuidSchema
          .optional()
          .describe(
            "Optional backend session UUID for narrower evidence resolution."
          )
      }
    },
    async (input) => {
      if (
        input.evidence_conversation_item_ids.length +
          input.evidence_memory_event_ids.length >
        CURATED_MEMORY_REVIEW_MAX_EVIDENCE
      ) {
        throw new Error(
          `At most ${CURATED_MEMORY_REVIEW_MAX_EVIDENCE} total evidence sources are allowed`
        );
      }
      logger.info(
        {
          evidenceConversationItems:
            input.evidence_conversation_item_ids.length,
          evidenceMemoryEvents: input.evidence_memory_event_ids.length,
          hasTopic: Boolean(input.proposed_topic),
          tagCount: input.tags.length,
          operation: input.operation,
          hasTargetAssertion: Boolean(input.target_assertion_id)
        },
        "memory_intake_propose tool call started"
      );
      const result = await client.proposeCuratedMemory({
        ...input,
        source_workspace_id: normalizeToolWorkspaceId(
          input.source_workspace_id
        ),
        created_by_model: "codex",
        created_by_prompt_version: "memory-intake-propose-mcp-v1"
      });
      logger.info(
        {
          proposalId:
            typeof result.proposal === "object" &&
            result.proposal !== null &&
            "id" in result.proposal
              ? result.proposal.id
              : undefined
        },
        "memory_intake_propose tool call completed"
      );
      backgroundCuratedMemoryReviewService.nudge("proposal_created");
      return jsonResponse(result);
    }
  );
}

if (toolExposure.exposeLowLevelMemoryTools) {
  server.registerTool(
    "memory_search",
    {
      title: "Search memory",
      description:
        "Debug/diagnostic low-level search through /v1/memory/search using local semantic embeddings. Normal agents should call memory_answer so the local memory-answer worker can plan searches and expansions.",
      inputSchema: {
        query: z.string().min(1),
        search_domain: searchDomainSchema.default("project"),
        workspace_id: z.string().min(1).optional(),
        session_id: uuidSchema.optional(),
        recent_days: z.number().int().positive().max(36500).optional(),
        source_after: z.string().datetime().optional(),
        source_before: z.string().datetime().optional(),
        limit: z.number().int().positive().max(50).default(10)
      }
    },
    async (input) =>
      jsonResponse(
        await client.search({
          ...input,
          retrieval_scope: "personal",
          workspace_id:
            input.search_domain === "project"
              ? normalizeToolWorkspaceId(input.workspace_id)
              : input.workspace_id
        })
      )
  );

  server.registerTool(
    "memory_expand",
    {
      title: "Expand memory node",
      description:
        "Debug/diagnostic low-level expansion through /v1/memory/nodes/{nodeId}/expand. Normal agents should call memory_answer so the local memory-answer worker controls expansion decisions.",
      inputSchema: {
        nodeId: uuidSchema.describe("Memory node UUID to expand.")
      }
    },
    async ({ nodeId }) => jsonResponse(await client.expand(nodeId))
  );
}

const transport = new StdioServerTransport();
let cleanedUp = false;
const cleanup = () => {
  if (cleanedUp) {
    return;
  }
  cleanedUp = true;
  logger.info("koed MCP server shutting down");
  answerBridgeHandle.close();
  backgroundLcmSummaryService?.stop();
  backgroundCuratedMemoryReviewService.stop();
};

process.once("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.once("SIGTERM", () => {
  cleanup();
  process.exit(143);
});
process.once("exit", cleanup);

await server.connect(transport);
logger.info("koed MCP server connected");
