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
      "Validate MEMORY_API_URL and MEMORY_API_TOKEN against /v1/access/check. Backend LLM provider configuration is unsupported in this build. Reports local semantic embedding retrieval status and that automatic full-discussion capture must use Codex hooks/transcript ingestion where available; MCP alone is for explicit tools and retrieval.",
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
        lcmSummaryService: backgroundLcmSummaryService
      })
    )
);

server.registerTool(
  "memory_answer",
  {
    title: "Answer from memory",
    description:
      "Retrieve memory through local semantic embeddings, then synthesize the final answer through the local MCP memory-answer worker when enabled. Defaults to response_detail=answer_only so normal agent recall receives compact markdown plus localMemoryWorker status metadata. Use response_detail=with_citations when citation/source metadata is needed, and response_detail=with_evidence only for debugging, UI inspection, or retrieval-quality investigation. The backend does not call OpenAI or another model provider; local synthesis uses the user's Codex CLI subscription.",
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
    const { include_evidence, response_detail, ...answerInput } = input;
    const retrieval_scope = defaultAnswerScope(await client.accessCheck());
    const workspace_id =
      input.search_domain === "project"
        ? normalizeToolWorkspaceId(input.workspace_id)
        : input.workspace_id;
    const evidence = await client.answer({
      ...answerInput,
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
        limit: input.limit,
        responseDetail: include_evidence ? "with_evidence" : response_detail
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
try {
  await server.connect(transport);
} finally {
  backgroundLcmSummaryService?.stop();
}
