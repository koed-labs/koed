#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { answerWithMemoryWorker } from "./answer-worker.js";
import {
  MemoryApiClient,
  type McpServerConfig,
  defaultAnswerScope,
  defaultConfig,
  exposedTools,
  memoryAccessCheck,
  resolveToolExposureConfig
} from "./index.js";
import {
  resolveLcmSummaryWorkerConfig,
  summarizePendingLcmNodes
} from "./lcm-summary-worker.js";
import {
  resolveLcmSummaryServiceConfig,
  startLcmSummaryService
} from "./lcm-summary-service.js";

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

const retrievalScopeSchema = z.enum(["personal", "personal+team"]);
const searchDomainSchema = z.enum(["global", "project", "session"]);
const uuidSchema = z.string().uuid();
const reasoningEffortSchema = z.enum(["low", "medium", "high", "xhigh"]);
const defaultWorkspaceId = (): string => process.cwd();
const normalizeToolWorkspaceId = (workspaceId?: string): string =>
  workspaceId && path.isAbsolute(workspaceId)
    ? workspaceId
    : defaultWorkspaceId();

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
    console.log(
      JSON.stringify(
        {
          ok: true,
          apiUrl: client.config.apiUrl,
          hasApiToken: Boolean(client.config.apiToken),
          tools: exposedTools(toolExposure),
          accessCheck: await memoryAccessCheck(client)
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

if (command === "lcm-summarize") {
  const delayMs = positiveIntOption("delay-ms");
  if (delayMs) {
    await sleep(delayMs);
  }
  const summaryConfig = resolveLcmSummaryWorkerConfig(process.env, {
    model: cliOptions.model,
    reasoningEffort: cliOptions["reasoning-effort"],
    timeoutMs: positiveIntOption("timeout-ms"),
    maxAttempts: positiveIntOption("max-attempts"),
    retryDelayMs: positiveIntOption("retry-delay-ms"),
    concurrency: positiveIntOption("concurrency")
  });
  console.log(
    JSON.stringify(
      await summarizePendingLcmNodes(client, {
        limit: positiveIntOption("limit"),
        config: summaryConfig
      }),
      null,
      2
    )
  );
  process.exit(0);
}

if (command) {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}

const server = new McpServer({
  name: "koed-mcp",
  version: "0.1.0"
});
const backgroundLcmSummaryService = startLcmSummaryService(client, {
  serviceConfig: resolveLcmSummaryServiceConfig(process.env),
  workerConfig: resolveLcmSummaryWorkerConfig(process.env)
});

server.registerTool(
  "memory_access_check",
  {
    title: "Memory access check",
    description:
      "Validate MEMORY_API_URL and MEMORY_API_TOKEN against /v1/access/check. Provider config is optional in codex_subscription mode. Reports local semantic embedding retrieval status and that automatic full-discussion capture must use Codex hooks/transcript ingestion where available; MCP alone is for explicit tools and retrieval.",
    inputSchema: {
      include_notes: z
        .boolean()
        .optional()
        .describe("Include integration guidance notes. Defaults to true.")
    }
  },
  async ({ include_notes = true }) =>
    jsonResponse(await memoryAccessCheck(client, include_notes))
);

server.registerTool(
  "memory_answer",
  {
    title: "Answer from memory",
    description:
      "Retrieve cited evidence from /v1/memory/answer using local semantic embeddings, then synthesize the final answer through the local MCP memory-answer worker when enabled. In codex_subscription mode the backend does not call OpenAI or another model provider; local synthesis uses the user's Codex CLI subscription and must cite whether each source is personal or team.",
    inputSchema: {
      query: z.string().min(1).describe("Question to answer from memory."),
      retrieval_scope: retrievalScopeSchema.optional(),
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
      limit: z.number().int().positive().max(50).default(10)
    }
  },
  async (input) => {
    const retrieval_scope =
      input.retrieval_scope ?? defaultAnswerScope(await client.accessCheck());
    const workspace_id =
      input.search_domain === "project"
        ? normalizeToolWorkspaceId(input.workspace_id)
        : input.workspace_id;
    const evidence = await client.answer({
      ...input,
      retrieval_scope,
      workspace_id
    });
    return jsonResponse(
      await answerWithMemoryWorker(evidence, {
        client,
        retrievalScope: retrieval_scope,
        searchDomain: input.search_domain,
        workspaceId: workspace_id,
        sessionId: input.session_id,
        limit: input.limit
      })
    );
  }
);

if (toolExposure.exposeLowLevelMemoryTools) {
  server.registerTool(
    "memory_search",
    {
      title: "Search memory",
      description:
        "Debug/diagnostic low-level search through /v1/memory/search using local semantic embeddings. Normal agents should call memory_answer so the local memory-answer worker can plan searches and expansions.",
      inputSchema: {
        query: z.string().min(1),
        retrieval_scope: retrievalScopeSchema.default("personal"),
        search_domain: searchDomainSchema.default("project"),
        workspace_id: z.string().min(1).optional(),
        session_id: uuidSchema.optional(),
        limit: z.number().int().positive().max(50).default(10)
      }
    },
    async (input) =>
      jsonResponse(
        await client.search({
          ...input,
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

server.registerTool(
  "memory_lcm_summarize_pending",
  {
    title: "Summarize pending LCM nodes locally",
    description:
      "Fetch pending LCM leaf/rollup nodes from the backend, run Codex summarisation locally under the user's subscription, and submit summaries back for embedding. This is intentionally outside the capture hot path and backend workers do not call LLMs for LCM summaries.",
    inputSchema: {
      limit: z.number().int().positive().max(50).default(10),
      model: z
        .string()
        .min(1)
        .default("gpt-5.4-mini")
        .describe("Local Codex model for LCM summarisation."),
      reasoning_effort: reasoningEffortSchema
        .default("medium")
        .describe("Local Codex reasoning effort for LCM summarisation."),
      timeout_ms: z.number().int().positive().optional(),
      max_attempts: z.number().int().positive().max(5).optional(),
      retry_delay_ms: z.number().int().nonnegative().optional(),
      concurrency: z.number().int().positive().max(4).default(1)
    }
  },
  async (input) =>
    jsonResponse(
      backgroundLcmSummaryService
        ? await backgroundLcmSummaryService.trigger("memory_tool", {
            limit: input.limit,
            workerConfig: resolveLcmSummaryWorkerConfig(process.env, {
              model: input.model,
              reasoningEffort: input.reasoning_effort,
              timeoutMs: input.timeout_ms,
              maxAttempts: input.max_attempts,
              retryDelayMs: input.retry_delay_ms,
              concurrency: input.concurrency
            })
          })
        : await summarizePendingLcmNodes(client, {
            limit: input.limit,
            config: resolveLcmSummaryWorkerConfig(process.env, {
              model: input.model,
              reasoningEffort: input.reasoning_effort,
              timeoutMs: input.timeout_ms,
              maxAttempts: input.max_attempts,
              retryDelayMs: input.retry_delay_ms,
              concurrency: input.concurrency
            })
          })
    )
);

const transport = new StdioServerTransport();
try {
  await server.connect(transport);
} finally {
  backgroundLcmSummaryService?.stop();
}
