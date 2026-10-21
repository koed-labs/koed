import { randomUUID } from "node:crypto";
import {
  formatMemoryAnswerCompletion,
  withCitationAliases
} from "../integrations/pi/memory-answer-presentation.mjs";
import { splitMemoryAnswerDeliveryInput } from "../integrations/pi/memory-answer-delivery-policy.mjs";
import {
  memoryAnswerTaskInputSchema,
  memoryAnswerResultInputSchema,
  memoryAnswerResultToolDescription,
  memoryAnswerCancelToolDescription,
  pendingMemoryAnswerTask,
  collectMemoryAnswerTask,
  presentMemoryAnswerTask,
  validateMemoryAnswerTask
} from "./mcp-memory-answer-tasks.js";
export {
  memoryAnswerTaskInputSchema,
  memoryAnswerResultInputSchema,
  memoryAnswerResultToolDescription,
  memoryAnswerCancelToolDescription
} from "./mcp-memory-answer-tasks.js";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  McpServer,
  PROTOCOL_VERSION_META_KEY,
  type McpRequestContext
} from "@modelcontextprotocol/server";
import releaseManifest from "@koed/koed/package.json" with { type: "json" };
import { assertKoedReleaseVersion } from "@koed/koed/release-version";
import { z } from "zod";
import { registerWorkItemCompletionTool } from "./work-item-completion-tool.js";
import { registerWorkItemsFromDocTool } from "./work-items-from-doc-tool.js";
import { registerFlashcardSourcesTool } from "./flashcard-sources-tool.js";
import { registerReviewRequestMergeProposalTool } from "./review-request-merge-proposal-tool.js";
import { registerMemoryActionTools } from "./memory-action-tools.js";
import { registerKoedTextActionTools } from "./koed-text-action-tools.js";
import {
  allTools,
  exposedTools,
  MEMORY_ANSWER_RETRIEVAL_META,
  memoryAnswerToolDescription,
  memoryIntakeProposeToolDescription,
  memoryServerInstructions,
  resolveToolExposureConfig,
  unavailableBackendToolCapabilities,
  type BackendToolCapabilities
} from "./index.js";
import {
  LocalAiRuntimeClient,
  LocalAiRuntimeError
} from "./local-runtime-client.js";
import type {
  LocalRuntimeCallerContext,
  LocalRuntimeToolName,
  LocalRuntimeCapabilities
} from "./local-runtime-protocol.js";
import {
  memoryAccessCheckInputSchema,
  memoryAnswerAdapterInputSchema,
  memoryAnswerInputSchema,
  memoryExpandInputSchema,
  memoryIntakeProposeInputSchema,
  memorySearchInputSchema,
  memoryWorkspacesInputSchema
} from "./memory-tool-schemas.js";

export const KOED_MCP_PROTOCOL_VERSION = "2026-07-28" as const;

export const resolveKoedMcpServerVersion = (manifest: unknown): string => {
  const version =
    manifest && typeof manifest === "object"
      ? (manifest as { version?: unknown }).version
      : undefined;
  return assertKoedReleaseVersion(version, "Koed release metadata");
};

export const KOED_MCP_SERVER_VERSION =
  resolveKoedMcpServerVersion(releaseManifest);

export const KOED_MCP_UNAVAILABLE_MESSAGE =
  "The koed MCP cannot connect to the local server.";

const jsonResponse = (payload: Record<string, unknown>) => ({
  structuredContent: payload,
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }]
});

const toolErrorResponse = (message: string) => ({
  isError: true,
  content: [{ type: "text" as const, text: message }]
});

type RuntimeToolCapabilities = BackendToolCapabilities &
  Pick<
    LocalRuntimeCapabilities,
    "supportedTools" | "memoryAnswerTeamBackendAvailable"
  >;

const supportsRuntimeTool = (
  capabilities: RuntimeToolCapabilities,
  name: LocalRuntimeToolName
): boolean =>
  capabilities.supportedTools
    ? capabilities.supportedTools.includes(name)
    : name !== "memory_workspaces";

const backendToolCapabilities = async (
  runtimeClient: KoedMcpRuntimeClient
): Promise<RuntimeToolCapabilities> =>
  runtimeClient.capabilities().then((capabilities) => ({
    supportedTools: capabilities.supportedTools,
    memoryAnswerTeamBackendAvailable:
      capabilities.memoryAnswerTeamBackendAvailable === true,
    curatedMemoryIntakeAvailable:
      capabilities.curatedMemoryIntakeAvailable === true
  }));

const defaultCallerContext = (
  context: Parameters<NonNullable<Parameters<McpServer["registerTool"]>[2]>>[1]
): LocalRuntimeCallerContext => {
  const envelope = (context.mcpReq.envelope ?? {}) as Record<string, unknown>;
  const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  return {
    cwd: process.cwd(),
    ...(typeof envelope[PROTOCOL_VERSION_META_KEY] === "string"
      ? { protocolVersion: envelope[PROTOCOL_VERSION_META_KEY] as string }
      : {}),
    ...(asRecord(envelope[CLIENT_INFO_META_KEY])
      ? { clientInfo: asRecord(envelope[CLIENT_INFO_META_KEY])! }
      : {}),
    ...(asRecord(envelope[CLIENT_CAPABILITIES_META_KEY])
      ? {
          clientCapabilities: asRecord(envelope[CLIENT_CAPABILITIES_META_KEY])!
        }
      : {})
  };
};

const toolDescription = (name: LocalRuntimeToolName): string => {
  switch (name) {
    case "memory_answer":
      return memoryAnswerToolDescription;
    case "memory_workspaces":
      return "Discover authorized Team Workspaces using the existing Koed enrollment shared with Desktop or headless koed-server. Call before Team recall when Workspace/backend IDs are unknown. Returns IDs and names, never credentials. Select the relevant Workspace and pass its team_workspace_id and team_backend_id to memory_answer. Discovery does not change the Personal Memory default.";
    case "memory_intake_propose":
      return memoryIntakeProposeToolDescription;
    case "memory_access_check":
      return "Diagnose the local Koed memory integration. Normal recall should use memory_answer.";
    case "memory_search":
      return "Diagnostic low-level memory search. Normal recall should use memory_answer.";
    case "memory_expand":
      return "Diagnostic low-level memory-node expansion. Normal recall should use memory_answer.";
  }
};

const toolTitle = (name: LocalRuntimeToolName): string => {
  switch (name) {
    case "memory_answer":
      return "Answer from memory";
    case "memory_workspaces":
      return "Discover Team Workspaces";
    case "memory_intake_propose":
      return "Propose Curated Memory";
    case "memory_access_check":
      return "Memory access check";
    case "memory_search":
      return "Search memory";
    case "memory_expand":
      return "Expand memory node";
  }
};

const toolSchema = (name: LocalRuntimeToolName) => {
  switch (name) {
    case "memory_answer":
      return memoryAnswerAdapterInputSchema;
    case "memory_workspaces":
      return memoryWorkspacesInputSchema;
    case "memory_intake_propose":
      return memoryIntakeProposeInputSchema;
    case "memory_access_check":
      return memoryAccessCheckInputSchema;
    case "memory_search":
      return memorySearchInputSchema;
    case "memory_expand":
      return memoryExpandInputSchema;
  }
};

export type KoedMcpRuntimeClient = Pick<
  LocalAiRuntimeClient,
  | "capabilities"
  | "callTool"
  | "startMemoryAnswerTask"
  | "getMemoryAnswerTask"
  | "cancelMemoryAnswerTask"
> & {
  /** Bounds `memory_answer_result(wait=true)` observation for this runtime. */
  readonly memoryAnswerObservation?: {
    maxObservationMs?: number;
    pollMs?: number;
  };
};

// Static collection outcomes that are safe to show and must not read as denial.
const passThroughCollectionErrors = new Set([
  "Memory Answer task has expired.",
  "Memory Answer observation lifecycle ended. Collect the existing task again if needed."
]);

// The runtime rejected the request before accepting a task, so the caller may
// safely correct or retry it. Timeouts and 5xx responses stay ambiguous.
const isDefinitiveSubmissionRejection = (error: unknown): boolean =>
  error instanceof LocalAiRuntimeError &&
  error.statusCode >= 400 &&
  error.statusCode < 500 &&
  error.statusCode !== 408;

export interface CreateKoedMcpServerOptions {
  runtimeClient?: KoedMcpRuntimeClient;
  environment?: NodeJS.ProcessEnv;
  callerContextResolver?: McpCallerContextResolver;
}

export interface McpCallerContextResolverInput {
  defaultContext: LocalRuntimeCallerContext;
  requestContext: McpRequestContext;
}

export type McpCallerContextResolver = (
  input: McpCallerContextResolverInput
) => LocalRuntimeCallerContext;

export const createKoedMcpServer = async (
  _requestContext: McpRequestContext,
  {
    runtimeClient = new LocalAiRuntimeClient(),
    environment = process.env,
    callerContextResolver = ({ defaultContext }) => defaultContext
  }: CreateKoedMcpServerOptions = {}
): Promise<McpServer> => {
  const invocationNamespace = randomUUID();
  let runtimeCapabilities: RuntimeToolCapabilities;
  let runtimeAvailable = true;
  let capabilitiesNeedRefresh = false;
  try {
    runtimeCapabilities = await backendToolCapabilities(runtimeClient);
  } catch {
    runtimeCapabilities = unavailableBackendToolCapabilities;
    runtimeAvailable = false;
    capabilitiesNeedRefresh = true;
  }
  const toolExposure = resolveToolExposureConfig(environment);
  const registeredTools = new Set<LocalRuntimeToolName>();
  const server = new McpServer(
    {
      name: "koed-mcp",
      title: "Koed Memory",
      version: KOED_MCP_SERVER_VERSION
    },
    {
      instructions: memoryServerInstructions,
      supportedProtocolVersions:
        _requestContext.era === "legacy" && _requestContext.requestInfo
          ? [KOED_MCP_PROTOCOL_VERSION, "2025-11-25"]
          : [KOED_MCP_PROTOCOL_VERSION],
      cacheHints: {
        "server/discover": { ttlMs: 30_000, cacheScope: "private" },
        "tools/list": { ttlMs: 30_000, cacheScope: "private" }
      }
    }
  );

  const markRuntimeAvailable = async (): Promise<void> => {
    runtimeAvailable = true;
    if (!capabilitiesNeedRefresh) return;
    try {
      runtimeCapabilities = await backendToolCapabilities(runtimeClient);
      registerExposedTools(runtimeCapabilities);
      capabilitiesNeedRefresh = false;
    } catch {
      // A successful tool call can still return while capability refresh
      // waits for the Local AI Runtime to finish starting.
    }
  };

  const registerTool = (toolName: LocalRuntimeToolName): void => {
    if (registeredTools.has(toolName)) return;
    server.registerTool(
      toolName,
      {
        title: toolTitle(toolName),
        description: toolDescription(toolName),
        ...(toolName === "memory_answer"
          ? { annotations: { readOnlyHint: true, destructiveHint: false } }
          : {}),
        inputSchema: toolSchema(toolName) as z.ZodObject
      },
      async (input, context) => {
        try {
          const caller = callerContextResolver({
            defaultContext: defaultCallerContext(context),
            requestContext: _requestContext
          });
          // Runtime processes can outlive adapter upgrades or be replaced while
          // this MCP connection remains open. Recheck new contract features.
          if (
            toolName === "memory_workspaces" ||
            (toolName === "memory_answer" &&
              (input as Record<string, unknown>).team_backend_id !== undefined)
          ) {
            runtimeCapabilities = await backendToolCapabilities(runtimeClient);
            if (
              !supportsRuntimeTool(runtimeCapabilities, toolName) ||
              (toolName === "memory_answer" &&
                !runtimeCapabilities.memoryAnswerTeamBackendAvailable)
            ) {
              return toolErrorResponse(
                "The running Koed Local AI Runtime does not support this Team recall feature. Restart the runtime through koed-server or Koed Desktop and reconnect MCP."
              );
            }
          }
          const invocationKey = `${context.sessionId ?? invocationNamespace}:${String(context.mcpReq.id)}`;
          const answerInput = input as Record<string, unknown>;
          const delivery = splitMemoryAnswerDeliveryInput(answerInput);
          if (
            toolName === "memory_answer" &&
            delivery.requestedMode === "non_blocking"
          ) {
            try {
              const task = await runtimeClient.startMemoryAnswerTask(
                memoryAnswerInputSchema.parse(delivery.executionInput),
                caller,
                invocationKey,
                context.mcpReq.signal
              );
              validateMemoryAnswerTask(task);
              await markRuntimeAvailable();
              return jsonResponse({ ...pendingMemoryAnswerTask(task) });
            } catch (error) {
              if (isDefinitiveSubmissionRejection(error)) throw error;
              return toolErrorResponse(
                "Memory Answer acceptance could not be confirmed; a task may already exist. Do not automatically resubmit. Check Koed availability and authorization."
              );
            }
          }
          const response = await runtimeClient.callTool(
            toolName,
            toolName === "memory_answer"
              ? memoryAnswerInputSchema.parse(delivery.executionInput)
              : (input as Record<string, unknown>),
            caller,
            context.mcpReq.signal,
            invocationKey
          );
          await markRuntimeAvailable();
          if (toolName === "memory_answer" && response.status !== "pending") {
            const citedResponse = withCitationAliases(response);
            const answerInput = input as Record<string, unknown>;
            const detailed =
              answerInput.include_evidence === true ||
              answerInput.response_detail === "with_citations" ||
              answerInput.response_detail === "with_evidence";
            const retrieval = response.retrieval;
            return {
              content: [
                {
                  type: "text" as const,
                  text: formatMemoryAnswerCompletion(
                    citedResponse,
                    "completed",
                    {
                      includeDetails: detailed
                    }
                  )
                }
              ],
              ...(detailed ? { structuredContent: citedResponse } : {}),
              // Clients do not show _meta to the model. Observers such as the
              // benchmark bridge still need retrieval counts for compact recall.
              ...(retrieval && typeof retrieval === "object"
                ? { _meta: { [MEMORY_ANSWER_RETRIEVAL_META]: retrieval } }
                : {})
            };
          }
          return jsonResponse(response);
        } catch (error) {
          if (
            error instanceof LocalAiRuntimeError &&
            error.statusCode === 429
          ) {
            return {
              isError: true,
              ...jsonResponse({
                error: error.message,
                statusCode: 429,
                ...(error.retryAfterMs !== undefined
                  ? { retryAfterMs: error.retryAfterMs }
                  : {}),
                ...(error.rateLimitSource
                  ? { rateLimitSource: error.rateLimitSource }
                  : {})
              })
            };
          }
          if (!runtimeAvailable) {
            return toolErrorResponse(KOED_MCP_UNAVAILABLE_MESSAGE);
          }
          throw error;
        }
      }
    );
    registeredTools.add(toolName);
  };

  let taskToolsRegistered = false;
  const registerMemoryAnswerTaskTools = (): void => {
    if (taskToolsRegistered) return;
    for (const name of [
      "memory_answer_result",
      "memory_answer_cancel"
    ] as const) {
      server.registerTool(
        name,
        {
          title:
            name === "memory_answer_result"
              ? "Collect Memory Answer"
              : "Cancel Memory Answer",
          description:
            name === "memory_answer_result"
              ? memoryAnswerResultToolDescription
              : memoryAnswerCancelToolDescription,
          annotations: {
            readOnlyHint: name === "memory_answer_result",
            destructiveHint: name === "memory_answer_cancel"
          },
          inputSchema:
            name === "memory_answer_result"
              ? memoryAnswerResultInputSchema
              : memoryAnswerTaskInputSchema
        },
        async (input, context) => {
          try {
            const collection =
              name === "memory_answer_result"
                ? memoryAnswerResultInputSchema.parse(input)
                : memoryAnswerTaskInputSchema.parse(input);
            const taskId = collection.task_id;
            // The runtime authenticates this fresh read, including current Team
            // membership. No connection-local cache authorizes disclosure.
            let task =
              name === "memory_answer_result"
                ? await collectMemoryAnswerTask(
                    {
                      get: (id, signal) =>
                        runtimeClient.getMemoryAnswerTask(id, signal)
                    },
                    taskId,
                    {
                      ...runtimeClient.memoryAnswerObservation,
                      signal: context.mcpReq.signal,
                      wait: "wait" in collection && collection.wait === true
                    }
                  )
                : await runtimeClient.getMemoryAnswerTask(
                    taskId,
                    context.mcpReq.signal
                  );
            validateMemoryAnswerTask(task, taskId);
            if (name === "memory_answer_cancel") {
              task = await runtimeClient.cancelMemoryAnswerTask(
                taskId,
                context.mcpReq.signal
              );
              validateMemoryAnswerTask(task, taskId);
              return jsonResponse({
                status:
                  task.status === "cancel_requested"
                    ? "cancel_requested"
                    : task.status === "accepted" || task.status === "running"
                      ? "pending"
                      : task.status === "completed" ||
                          task.status === "cancelled"
                        ? task.status
                        : "failed",
                task_id: task.id,
                expires_at: task.expiresAt
              });
            }
            const presentation = presentMemoryAnswerTask(task);
            if (
              presentation.status === "completed" &&
              "text" in presentation &&
              typeof presentation.text === "string"
            ) {
              return {
                content: [{ type: "text" as const, text: presentation.text }]
              };
            }
            return jsonResponse({ ...presentation });
          } catch (error) {
            return toolErrorResponse(
              error instanceof Error &&
                passThroughCollectionErrors.has(error.message)
                ? error.message
                : "Memory Answer task is unavailable or access is denied."
            );
          }
        }
      );
    }
    taskToolsRegistered = true;
  };

  const registerExposedTools = (
    capabilities: RuntimeToolCapabilities
  ): void => {
    for (const name of exposedTools(toolExposure, capabilities)) {
      if (
        environment.KOED_MANAGED_CATCH_UP_READ_ONLY === "1" &&
        name !== "memory_answer"
      )
        continue;
      if (!allTools.includes(name)) continue;
      if (!supportsRuntimeTool(capabilities, name)) continue;
      registerTool(name as LocalRuntimeToolName);
      if (name === "memory_answer") registerMemoryAnswerTaskTools();
    }
  };

  registerExposedTools(runtimeCapabilities);
  // This complete branch is the managed catch-up tool boundary. Keep all
  // future Koed registrations below it so unknown tools are denied by default.
  if (environment.KOED_MANAGED_CATCH_UP_READ_ONLY === "1") {
    if (
      environment.KOED_MANAGED_DOC_EXECUTION_ID &&
      environment.KOED_MANAGED_DOC_EXECUTION_GENERATION &&
      environment.KOED_MANAGED_DOC_API_URL
    )
      registerWorkItemsFromDocTool(server, environment);
    return server;
  }
  if (environment.KOED_MANAGED_MEMORY_ACTIONS === "1")
    registerMemoryActionTools(server);
  if (environment.KOED_MANAGED_WORK_ITEM_COMPLETION === "1")
    registerWorkItemCompletionTool(server);
  if (
    environment.KOED_MANAGED_DOC_EXECUTION_ID &&
    environment.KOED_MANAGED_DOC_EXECUTION_GENERATION &&
    environment.KOED_MANAGED_DOC_API_URL
  ) {
    registerWorkItemsFromDocTool(server, environment);
    registerFlashcardSourcesTool(server, environment);
  }
  if (environment.KOED_MANAGED_MERGE_PROPOSAL === "1")
    registerReviewRequestMergeProposalTool(server);
  if (environment.KOED_MANAGED_TEXT_ACTIONS === "1")
    registerKoedTextActionTools(server);

  return server;
};
