/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { KoedPiConfig } from "./config.js";
import type { KoedApiClient } from "./koed-client.js";
import {
  PI_LCM_SUMMARY_DEFAULTS,
  type PiLcmSummaryServiceHandle
} from "./lcm-summary.js";
import type { CaptureRuntimeState } from "./capture.js";

const retrievalScopeSchema = Type.Union([
  Type.Literal("personal"),
  Type.Literal("personal+team")
]);

const searchDomainSchema = Type.Union([
  Type.Literal("project"),
  Type.Literal("session"),
  Type.Literal("global")
]);

const answerParams = Type.Object({
  query: Type.String({ minLength: 1, description: "Question to answer from memory." }),
  retrieval_scope: Type.Optional(retrievalScopeSchema),
  search_domain: Type.Optional(searchDomainSchema),
  session_id: Type.Optional(Type.String({ minLength: 1 })),
  workspace_id: Type.Optional(Type.String({ minLength: 1 })),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 }))
});

const defaultSessionId = (
  runtimeState: CaptureRuntimeState | undefined,
  searchDomain: string
): string | undefined =>
  searchDomain === "session" ? runtimeState?.backendSessionId : undefined;

const resolveSessionId = (
  runtimeState: CaptureRuntimeState | undefined,
  searchDomain: string,
  requestedSessionId?: string
): string | undefined => {
  const sessionId = requestedSessionId ?? defaultSessionId(runtimeState, searchDomain);
  if (searchDomain === "session" && !sessionId) {
    throw new Error(
      "Koed Pi integration does not have a backend session id yet for session-scoped lookup. Ask another question first or pass session_id explicitly."
    );
  }
  return sessionId;
};

export const createKoedTools = (deps: {
  client: KoedApiClient;
  config: KoedPiConfig;
  getRuntimeState(): CaptureRuntimeState | undefined;
  getLcmSummaryService(): PiLcmSummaryServiceHandle | null;
}) => {
  const { client, config, getRuntimeState, getLcmSummaryService } = deps;

  const memoryAccessCheck = defineTool({
    name: "memory_access_check",
    label: "Memory Access Check",
    description: "Check Koed memory API access and Pi extension configuration.",
    promptSnippet: "Check whether Koed memory integration works.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      const access = await client.accessCheck(signal);
      const payload = {
        ...access,
        server: "@koed/pi-extension",
        configuredApiUrl: config.apiUrl,
        hasApiToken: Boolean(config.apiToken),
        defaultAutomaticCaptureScope: "personal",
        defaultAnswerScope: config.defaultRetrievalScope,
        automaticDiscussionCapture: "via_pi_extension_events",
        localLcmSummaryService: {
          enabled: config.lcmSummaryEnabled,
          initialDelayMs: PI_LCM_SUMMARY_DEFAULTS.initialDelayMs,
          pushDelayMs: PI_LCM_SUMMARY_DEFAULTS.pushDelayMs,
          intervalMs: PI_LCM_SUMMARY_DEFAULTS.intervalMs,
          batchLimit: PI_LCM_SUMMARY_DEFAULTS.batchLimit,
          providerOrder: [...PI_LCM_SUMMARY_DEFAULTS.providerOrder],
          piModelFamilies: [...PI_LCM_SUMMARY_DEFAULTS.piModelFamilies]
        },
        exposedTools: [
          "memory_access_check",
          "memory_answer",
          ...(config.exposeLowLevelTools
            ? [
                "memory_search",
                "memory_expand",
                "memory_lcm_status",
                "memory_lcm_summarize_pending"
              ]
            : [])
        ],
        notes: [
          "Pi integration captures finalized user and assistant messages as personal memory.",
          "Tool-result capture is optional and disabled by default.",
          "Pi integration talks to Koed HTTP APIs directly and does not require MCP.",
          "Local Pi LCM summarisation is background work in the extension and uses compact Pi models discovered through `pi --list-models`."
        ]
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        details: payload
      };
    }
  });

  const memoryAnswer = defineTool({
    name: "memory_answer",
    label: "Answer From Memory",
    description: "Retrieve Koed memory evidence for current Pi workspace.",
    promptSnippet: "Retrieve relevant Koed memory evidence before answering from project memory.",
    promptGuidelines: [
      "Use memory_answer when user asks about prior work, earlier sessions, past decisions, or project memory.",
      "Default memory_answer to project-scoped lookup for current workspace unless user clearly asks about one session or all projects."
    ],
    parameters: answerParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const searchDomain = params.search_domain ?? "project";
      const runtimeState = getRuntimeState();
      const result = await client.answer(
        {
          query: params.query,
          retrieval_scope: params.retrieval_scope ?? config.defaultRetrievalScope,
          search_domain: searchDomain,
          session_id: resolveSessionId(
            runtimeState,
            searchDomain,
            params.session_id
          ),
          workspace_id:
            searchDomain === "project"
              ? params.workspace_id ?? ctx.cwd
              : params.workspace_id,
          limit: params.limit ?? 10
        },
        signal
      );
      const markdown =
        typeof result.markdown === "string"
          ? result.markdown
          : "Koed evidence bundle returned.";
      const evidenceHits = Array.isArray(result.evidence) ? result.evidence.length : 0;
      return {
        content: [
          { type: "text", text: markdown },
          { type: "text", text: `\nEvidence hits: ${evidenceHits}` }
        ],
        details: result
      };
    }
  });

  const tools = [memoryAccessCheck, memoryAnswer];

  if (config.exposeLowLevelTools) {
    tools.push(
      defineTool({
        name: "memory_search",
        label: "Search Memory",
        description: "Low-level Koed memory search.",
        parameters: answerParams,
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
          const searchDomain = params.search_domain ?? "project";
          const runtimeState = getRuntimeState();
          const result = await client.search(
            {
              query: params.query,
              retrieval_scope: params.retrieval_scope ?? config.defaultRetrievalScope,
              search_domain: searchDomain,
              session_id: resolveSessionId(
                runtimeState,
                searchDomain,
                params.session_id
              ),
              workspace_id:
                searchDomain === "project"
                  ? params.workspace_id ?? ctx.cwd
                  : params.workspace_id,
              limit: params.limit ?? 10
            },
            signal
          );
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            details: result
          };
        }
      }),
      defineTool({
        name: "memory_expand",
        label: "Expand Memory Node",
        description: "Low-level Koed memory node expansion.",
        parameters: Type.Object({
          nodeId: Type.String({ minLength: 1, description: "Memory node UUID to expand." })
        }),
        async execute(_toolCallId, params, signal) {
          const result = await client.expand(params.nodeId, signal);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            details: result
          };
        }
      }),
      defineTool({
        name: "memory_lcm_status",
        label: "LCM Status",
        description: "Inspect Pi local LCM summary service status.",
        parameters: Type.Object({}),
        execute() {
          const service = getLcmSummaryService();
          const result = service
            ? {
                enabled: true,
                ...service.snapshot()
              }
            : {
                enabled: false,
                reason: config.lcmSummaryEnabled
                  ? "service_unavailable"
                  : "disabled_in_config"
              };
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            details: result
          };
        }
      }),
      defineTool({
        name: "memory_lcm_summarize_pending",
        label: "Summarize Pending LCM",
        description: "Force one immediate Pi local LCM summary pass for debugging.",
        parameters: Type.Object({
          limit: Type.Optional(
            Type.Number({ minimum: 1, maximum: 50, description: "Maximum nodes to process." })
          )
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          const service = getLcmSummaryService();
          if (!service) {
            throw new Error(
              config.lcmSummaryEnabled
                ? "Pi LCM summary service is unavailable"
                : "Pi LCM summary service is disabled in config"
            );
          }
          const result = await service.trigger(ctx.cwd, params.limit ?? 1);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            details: result
          };
        }
      })
    );
  }

  return tools;
};
