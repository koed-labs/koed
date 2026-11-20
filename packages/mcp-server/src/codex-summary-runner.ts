import { z } from "zod";
import {
  CodexAppServerClient,
  resolveCodexHome,
  type CodexAppServerRunConfig
} from "./codex-app-server-runner.js";

type CodexSummaryConfig = Pick<
  CodexAppServerRunConfig,
  | "appServerBinary"
  | "model"
  | "reasoningEffort"
  | "cwd"
  | "env"
  | "clientName"
  | "baseInstructions"
  | "developerInstructions"
  | "onProviderActivity"
> & { outputSchema: Record<string, unknown>; signal?: AbortSignal };

export class CodexSummaryClientError extends Error {
  constructor(
    readonly reason:
      | "authentication_required"
      | "profile_mismatch"
      | "telemetry_unverified"
  ) {
    super(reason);
  }
}

// Reuse the native profile for sign-in, not its capture integrations.
const summaryConfigOverrides = [
  "features.hooks=false",
  "features.plugin_hooks=false",
  "features.plugins=false",
  "features.apps=false",
  "notify=[]",
  'history.persistence="none"',
  "otel.log_user_prompt=false",
  'otel.exporter="none"',
  'otel.trace_exporter="none"',
  'otel.metrics_exporter="none"'
];

const disabledTelemetryConfigSchema = z.object({
  otel: z.object({
    log_user_prompt: z.literal(false),
    exporter: z.literal("none"),
    trace_exporter: z.literal("none"),
    metrics_exporter: z.literal("none")
  })
});

const effectiveConfigSchema = z.object({
  features: z.object({
    hooks: z.literal(false),
    plugin_hooks: z.literal(false),
    plugins: z.literal(false)
  }),
  history: z.object({ persistence: z.literal("none") }),
  notify: z.tuple([]),
  mcp_servers: z.record(z.string(), z.unknown()).nullish()
});

async function startSummaryThread(
  client: CodexAppServerClient,
  config: CodexSummaryConfig,
  home: string,
  signal: AbortSignal
) {
  const { codexHome } = await client.initialize(config.clientName);
  if (codexHome !== home) throw new CodexSummaryClientError("profile_mismatch");
  const account = await client.readAccount();
  if (!account.account && account.requiresOpenaiAuth !== false)
    throw new CodexSummaryClientError("authentication_required");
  const reportedConfig = await client
    .readEffectiveConfig(config.cwd)
    .catch(() => {
      throw new CodexSummaryClientError("telemetry_unverified");
    });
  // Managed policy can override launch flags. Require explicit effective values.
  if (!disabledTelemetryConfigSchema.safeParse(reportedConfig).success)
    throw new CodexSummaryClientError("telemetry_unverified");
  const effective = effectiveConfigSchema.safeParse(reportedConfig);
  if (!effective.success)
    throw new Error("Codex did not apply the requested non-capture settings");
  const servers = Object.keys(effective.data.mcp_servers ?? {});
  signal.throwIfAborted();
  return client.startThread(config, {
    verifyEphemeralReadOnly: true,
    additionalConfig: {
      // Codex merges TOML tables. An empty table does not disable inherited servers.
      mcp_servers: Object.fromEntries(
        servers.map((name) => [name, { enabled: false }])
      )
    }
  });
}

export async function runCodexSummary(
  prompt: string,
  config: CodexSummaryConfig,
  timeoutMs: number
) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = config.signal
    ? AbortSignal.any([deadline, config.signal])
    : deadline;
  signal.throwIfAborted();
  const home = resolveCodexHome(config.env);
  const client = new CodexAppServerClient(
    config.appServerBinary,
    config.cwd,
    { ...config.env, CODEX_HOME: home },
    undefined,
    {
      configOverrides: summaryConfigOverrides,
      transientEventHandler: (event) => {
        if (event.method === "item/agentMessage/delta")
          config.onProviderActivity?.("Codex provider activity");
      }
    }
  );
  const abort = () => client.close();
  signal.addEventListener("abort", abort, { once: true });
  try {
    const { id: threadId } = await startSummaryThread(
      client,
      config,
      home,
      signal
    );
    signal.throwIfAborted();
    const turnId = await client.startTurn(threadId, prompt, config);
    const result = await client.waitForTurn(threadId, turnId);
    signal.throwIfAborted();
    return {
      ...result,
      model: `codex-app-server:${config.model}:${config.reasoningEffort ?? "default"}`
    };
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    await client.closeAndWait();
  }
}
