import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  McpServer,
  PROTOCOL_VERSION_META_KEY,
  type McpRequestContext
} from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  allTools,
  exposedTools,
  memoryAnswerToolDescription,
  memoryIntakeProposeToolDescription,
  memoryServerInstructions,
  resolveToolExposureConfig,
  type BackendToolCapabilities
} from "./index.js";
import { LocalAiRuntimeClient } from "./local-runtime-client.js";
import type {
  LocalRuntimeCallerContext,
  LocalRuntimeToolName
} from "./local-runtime-protocol.js";
import {
  memoryAccessCheckInputSchema,
  memoryAnswerInputSchema,
  memoryExpandInputSchema,
  memoryIntakeProposeInputSchema,
  memorySearchInputSchema
} from "./memory-tool-schemas.js";

export const KOED_MCP_PROTOCOL_VERSION = "2026-07-28" as const;

const jsonResponse = (payload: Record<string, unknown>) => ({
  structuredContent: payload,
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }]
});

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
  const runtimeCapabilities: BackendToolCapabilities = await runtimeClient
    .capabilities()
    .then((capabilities) => ({
      curatedMemoryIntakeAvailable:
        capabilities.curatedMemoryIntakeAvailable === true
    }));
  const activeTools = exposedTools(
    resolveToolExposureConfig(environment),
    runtimeCapabilities
  );
  const server = new McpServer(
    { name: "koed-mcp", title: "Koed Memory", version: "0.2.0" },
    {
      instructions: memoryServerInstructions,
      supportedProtocolVersions: [KOED_MCP_PROTOCOL_VERSION],
      cacheHints: {
        "server/discover": { ttlMs: 30_000, cacheScope: "private" },
        "tools/list": { ttlMs: 30_000, cacheScope: "private" }
      }
    }
  );

  for (const name of activeTools) {
    if (!allTools.includes(name)) continue;
    const toolName = name as LocalRuntimeToolName;
    server.registerTool(
      toolName,
      {
        title: toolTitle(toolName),
        description: toolDescription(toolName),
        inputSchema: toolSchema(toolName) as z.ZodObject
      },
      async (input, context) =>
        jsonResponse(
          await runtimeClient.callTool(
            toolName,
            input as Record<string, unknown>,
            callerContextResolver({
              defaultContext: defaultCallerContext(context),
              requestContext: _requestContext
            }),
            context.mcpReq.signal
          )
        )
    );
  }

  return server;
};
