import { randomUUID } from "node:crypto";
import { formatMemoryAnswerCompletion } from "../integrations/pi/memory-answer-presentation.mjs";
import {
  CODEX_DELIVERY_NONCE,
  CodexDetachedMemoryIneligible,
  CodexMemoryDelivery,
  CodexMemoryReceiptStore,
  canonicalCodexMemoryInput
} from "./codex-memory-delivery.js";
import { resolveKoedHome } from "./local-runtime-protocol.js";
import { logger } from "./logger.js";
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
  runtimeClient: LocalAiRuntimeClient
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
      return memoryAnswerInputSchema;
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

export interface CreateKoedMcpServerOptions {
  runtimeClient?: LocalAiRuntimeClient;
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
  const deferredEnabled = environment.KOED_CODEX_STOP_DELIVERY === "1";
  // An unusable receipt store must not stop the MCP Server: recall falls back
  // to blocking, and the tool schema still accepts (and strips) the nonce.
  let receiptStore: CodexMemoryReceiptStore | undefined;
  if (deferredEnabled) {
    try {
      receiptStore = new CodexMemoryReceiptStore(resolveKoedHome(environment));
    } catch (error) {
      logger.warn(
        { err: error },
        "Codex deferred recall is unavailable; using blocking recall"
      );
    }
  }
  const deferred = receiptStore
    ? new CodexMemoryDelivery(
        receiptStore,
        {
          start: async (input, caller, key, signal) => {
            try {
              return await runtimeClient.startMemoryAnswerTask(
                input,
                caller,
                key,
                signal
              );
            } catch (error) {
              if (
                error instanceof LocalAiRuntimeError &&
                error.statusCode === 409 &&
                error.code === "memory_answer_team_ineligible"
              )
                throw new CodexDetachedMemoryIneligible();
              throw error;
            }
          },
          get: (id, signal) => runtimeClient.getMemoryAnswerTask(id, signal),
          cancel: (id, signal) =>
            runtimeClient.cancelMemoryAnswerTask(id, signal)
        },
        undefined,
        environment.KOED_CODEX_MEMORY_TOOL ?? "mcp__koed__memory_answer"
      )
    : undefined;
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
      supportedProtocolVersions: [KOED_MCP_PROTOCOL_VERSION],
      cacheHints: {
        "server/discover": { ttlMs: 30_000, cacheScope: "private" },
        "tools/list": { ttlMs: 30_000, cacheScope: "private" }
      }
    }
  );

  const registerTool = (toolName: LocalRuntimeToolName): void => {
    if (registeredTools.has(toolName)) return;
    server.registerTool(
      toolName,
      {
        title: toolTitle(toolName),
        description: toolDescription(toolName),
        inputSchema: (toolName === "memory_answer" && deferredEnabled
          ? memoryAnswerInputSchema.safeExtend({
              [CODEX_DELIVERY_NONCE]: z
                .string()
                .regex(/^[a-f0-9]{64}$/)
                .optional()
            })
          : toolSchema(toolName)) as z.ZodObject
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
          let response: Record<string, unknown> | undefined;
          if (toolName === "memory_answer" && deferred) {
            response = await deferred.accept(
              input as Record<string, unknown>,
              caller,
              context.mcpReq.signal,
              context.mcpReq._meta
            );
          }
          response ??= await runtimeClient.callTool(
            toolName,
            toolName === "memory_answer"
              ? canonicalCodexMemoryInput(input as Record<string, unknown>)
              : (input as Record<string, unknown>),
            caller,
            context.mcpReq.signal,
            `${context.sessionId ?? invocationNamespace}:${String(context.mcpReq.id)}`
          );
          runtimeAvailable = true;
          if (capabilitiesNeedRefresh) {
            try {
              runtimeCapabilities =
                await backendToolCapabilities(runtimeClient);
              registerExposedTools(runtimeCapabilities);
              capabilitiesNeedRefresh = false;
            } catch {
              // A successful tool call can still return while capability refresh
              // waits for the Local AI Runtime to finish starting.
            }
          }
          if (toolName === "memory_answer" && response.status !== "pending") {
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
                  text: formatMemoryAnswerCompletion(response, "completed", {
                    includeDetails: detailed
                  })
                }
              ],
              ...(detailed ? { structuredContent: response } : {}),
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

  const registerExposedTools = (
    capabilities: RuntimeToolCapabilities
  ): void => {
    for (const name of exposedTools(toolExposure, capabilities)) {
      if (!allTools.includes(name)) continue;
      if (!supportsRuntimeTool(capabilities, name)) continue;
      registerTool(name as LocalRuntimeToolName);
    }
  };

  registerExposedTools(runtimeCapabilities);

  return server;
};
