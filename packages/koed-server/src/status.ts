import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadRepoEnv, resolveApiUrl, resolveExplorerUrl } from "./env-file.js";
import {
  ensureKoedHome,
  resolveKoedServerPaths,
  type KoedServerPaths
} from "./paths.js";
import type {
  KoedServerComponentState,
  KoedServerComponentStatus,
  KoedServerDoctorCheck,
  KoedServerDoctorResult,
  KoedServerRuntimeState,
  KoedServerStatus
} from "./types.js";

const needsAttention = (
  message: string,
  action?: string,
  details?: Record<string, unknown>
): KoedServerComponentStatus => ({
  state: "needs_attention",
  message,
  ...(action ? { action } : {}),
  ...(details ? { details } : {})
});

const healthy = (
  message?: string,
  details?: Record<string, unknown>
): KoedServerComponentStatus => ({
  state: "healthy",
  ...(message ? { message } : {}),
  ...(details ? { details } : {})
});

const notConfigured = (
  message: string,
  action?: string,
  details?: Record<string, unknown>
): KoedServerComponentStatus => ({
  state: "not_configured",
  message,
  ...(action ? { action } : {}),
  ...(details ? { details } : {})
});

const starting = (
  message: string,
  details?: Record<string, unknown>
): KoedServerComponentStatus => ({
  state: "starting",
  message,
  ...(details ? { details } : {})
});

const readJsonFile = <T>(path: string): T | null => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
};

const checkPid = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const fetchJson = async <T>(
  url: string
): Promise<{ ok: boolean; status: number; body: T | null; error?: string }> => {
  try {
    const response = await fetch(url);
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      body: text ? (JSON.parse(text) as T) : null
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
};

interface ApiReadyPayload {
  status?: string;
  checks?: Array<{ service?: string; status?: string }>;
}

const statusFromApiReady = async (apiUrl: string) => {
  const readyUrl = new URL("/ready", apiUrl).toString();
  const response = await fetchJson<ApiReadyPayload>(readyUrl);
  if (!response.ok || !response.body) {
    return {
      api: needsAttention(
        `API is not ready at ${readyUrl}${response.error ? ` (${response.error})` : response.status ? ` (HTTP ${response.status})` : ""}`,
        "Run koed-server start and check Docker Desktop is running."
      ),
      database: starting(
        "Waiting for API readiness to confirm database state."
      ),
      redis: starting("Waiting for API readiness to confirm Redis state."),
      embeddingService: starting(
        "Waiting for API readiness to confirm Embedding Service state."
      )
    };
  }

  const checks = response.body.checks ?? [];
  const serviceStatus = (service: string): string | undefined =>
    checks.find((check) => check.service === service)?.status;
  const component = (
    service: string,
    label: string
  ): KoedServerComponentStatus => {
    const value = serviceStatus(service);
    if (value === "ok") {
      return healthy();
    }
    if (value === "degraded") {
      return needsAttention(
        `${label} is degraded.`,
        "Run koed-server doctor --json for details."
      );
    }
    if (value === "error") {
      return needsAttention(
        `${label} is unavailable.`,
        "Run koed-server start or inspect Koed logs."
      );
    }
    return starting(`${label} status is not available yet.`);
  };

  return {
    api: healthy(undefined, { readyUrl }),
    database: component("postgres", "Database"),
    redis: component("redis", "Redis"),
    embeddingService: component("embedding-service", "Embedding Service")
  };
};

const dockerComposePs = (paths: KoedServerPaths): KoedServerComponentStatus => {
  const result = spawnSync("docker", ["compose", "ps", "--format", "json"], {
    cwd: paths.repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error) {
    return needsAttention(
      `Could not run docker compose: ${result.error.message}`,
      "Install/start Docker Desktop, then run koed-server start."
    );
  }
  if (result.status !== 0) {
    return needsAttention(
      `docker compose ps failed: ${result.stderr.trim() || "unknown error"}`,
      "Start Docker Desktop, then run koed-server start."
    );
  }

  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const services = lines.flatMap((line) => {
    try {
      const parsed = JSON.parse(line) as {
        Service?: string;
        State?: string;
        Health?: string;
      };
      return [parsed];
    } catch {
      return [];
    }
  });
  const queueServices = services.filter((service) =>
    ["worker", "redis"].includes(service.Service ?? "")
  );
  const present = new Set(queueServices.map((service) => service.Service));
  const missing = ["redis", "worker"].filter(
    (service) => !present.has(service)
  );
  if (missing.length > 0) {
    return starting("Worker queue services have not all been started yet.", {
      missing,
      services: queueServices
    });
  }
  if (queueServices.some((service) => service.State !== "running")) {
    return needsAttention(
      "Worker queues are not fully running.",
      "Run koed-server start.",
      { services: queueServices }
    );
  }
  return healthy(undefined, { services: queueServices });
};

const inspectApiToken = (
  repoEnv: Record<string, string>
): KoedServerStatus["apiToken"] => {
  const token =
    repoEnv.MEMORY_API_TOKEN ??
    repoEnv.CODEX_MEMORY_API_TOKEN ??
    repoEnv.VITE_KOED_API_TOKEN;
  if (!token || token.startsWith("replace_with_")) {
    return {
      ...notConfigured(
        "No local API Token is configured for Koed integrations.",
        "Run koed-server setup codex --json or create an API Token."
      ),
      configured: false
    };
  }
  return { ...healthy("A local API Token is configured."), configured: true };
};

const inspectCodex = (): KoedServerStatus["codex"] => {
  const codexConfigPath = resolve(
    process.env.CODEX_CONFIG_PATH ??
      `${process.env.HOME ?? ""}/.codex/config.toml`
  );
  if (!existsSync(codexConfigPath)) {
    return {
      ...notConfigured(
        "Codex configuration was not found.",
        "Run koed-server setup codex --json to configure the supported AI Client integration."
      ),
      configured: false
    };
  }
  const content = readFileSync(codexConfigPath, "utf8");
  const configured =
    content.includes("# >>> koed") && content.includes("[mcp_servers.");
  if (!configured) {
    return {
      ...notConfigured(
        "Codex is installed but Koed is not configured in Codex.",
        "Run koed-server setup codex --json."
      ),
      configured: false
    };
  }
  return {
    ...healthy("Codex Koed integration is configured."),
    configured: true
  };
};

const inspectCaptureHook = () => {
  const hookConfigPath = resolve(
    process.env.MEMORY_HOOK_CONFIG ??
      `${process.env.HOME ?? ""}/.koed/config.json`
  );
  if (!existsSync(hookConfigPath)) {
    return notConfigured(
      "Supported Capture Hook config was not found.",
      "Run koed-server setup codex --json."
    );
  }
  const parsed = readJsonFile<{
    apiUrl?: string;
    apiToken?: string;
    captureEnabled?: boolean;
  }>(hookConfigPath);
  if (!parsed?.apiUrl || !parsed.apiToken) {
    return needsAttention(
      "Supported Capture Hook config is incomplete.",
      "Run koed-server setup codex --json to rewrite hook configuration."
    );
  }
  if (parsed.captureEnabled === false) {
    return needsAttention(
      "Supported Capture Hook is configured but capture is disabled.",
      "Enable capture in the Koed hook config or rerun setup."
    );
  }
  return healthy("Supported Capture Hook is configured.");
};

const inspectMcp = (
  apiUrl: string,
  repoEnv: Record<string, string>,
  paths: KoedServerPaths
) => {
  const cliPath = resolve(paths.repoRoot, "packages/mcp-server/dist/cli.js");
  if (!existsSync(cliPath)) {
    return notConfigured(
      "MCP Server build output was not found.",
      "Run pnpm --filter @koed/mcp-server build or koed-server setup codex --json."
    );
  }
  const token =
    repoEnv.MEMORY_API_TOKEN ??
    repoEnv.CODEX_MEMORY_API_TOKEN ??
    repoEnv.VITE_KOED_API_TOKEN;
  if (!token || token.startsWith("replace_with_")) {
    return notConfigured(
      "MCP Server needs a local API Token.",
      "Run koed-server setup codex --json."
    );
  }
  const result = spawnSync(process.execPath, [cliPath, "doctor"], {
    cwd: paths.repoRoot,
    env: {
      ...process.env,
      ...repoEnv,
      MEMORY_API_URL: apiUrl,
      MEMORY_API_TOKEN: token
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status === 0) {
    return healthy("MCP Server doctor passed.");
  }
  return needsAttention(
    "MCP Server doctor failed.",
    "Run koed-server doctor --json for details.",
    { stderr: result.stderr.trim(), stdout: result.stdout.trim() }
  );
};

const inspectLastVerification = (paths: KoedServerPaths) => {
  const value = readJsonFile<{
    checkedAt?: string;
    ok?: boolean;
    message?: string;
  }>(paths.lastVerificationPath);
  if (!value?.checkedAt) {
    return {
      ...notConfigured(
        "No setup verification has been recorded yet.",
        "Run koed-server setup codex --json."
      ),
      checkedAt: null
    };
  }
  return {
    ...(value.ok === false
      ? needsAttention(
          value.message ?? "Last verification failed.",
          "Run koed-server setup codex --json."
        )
      : healthy("Last setup verification passed.")),
    checkedAt: value.checkedAt
  };
};

const aggregateState = (
  components: KoedServerComponentStatus[]
): KoedServerComponentState => {
  if (components.some((component) => component.state === "needs_attention")) {
    return "needs_attention";
  }
  if (components.some((component) => component.state === "starting")) {
    return "starting";
  }
  if (components.some((component) => component.state === "not_configured")) {
    return "not_configured";
  }
  return "healthy";
};

export const collectKoedServerStatus = async (
  environment: NodeJS.ProcessEnv = process.env
): Promise<KoedServerStatus> => {
  const paths = resolveKoedServerPaths(environment);
  ensureKoedHome(paths);
  const repoEnv = loadRepoEnv(paths.repoRoot);
  const apiUrl = resolveApiUrl(environment, repoEnv);
  const explorerUrl = resolveExplorerUrl(environment, repoEnv);
  const runtime = readJsonFile<KoedServerRuntimeState>(paths.runtimeStatePath);
  const runtimeProcessRunning = runtime ? checkPid(runtime.pid) : false;
  const apiReady = await statusFromApiReady(apiUrl);
  const apiToken = inspectApiToken(repoEnv);
  const codex = inspectCodex();
  const captureHook = inspectCaptureHook();
  const mcpServer = inspectMcp(apiUrl, repoEnv, paths);
  const workerQueues = dockerComposePs(paths);
  const lcmSummaryService =
    mcpServer.state === "healthy"
      ? healthy("LCM Summary Service is available through the MCP Server.")
      : mcpServer.state === "not_configured"
        ? notConfigured(
            "LCM Summary Service needs the MCP Server setup.",
            "Run koed-server setup codex --json."
          )
        : needsAttention(
            "LCM Summary Service status could not be verified.",
            "Fix MCP Server health first."
          );
  const lastVerification = inspectLastVerification(paths);
  const explorer = runtimeProcessRunning
    ? healthy("Explorer is available through the Koed local service.")
    : starting("Koed server supervisor is not currently running.");
  const project = notConfigured(
    "Project association is not configured yet.",
    "Project identity is tracked by KOE-219."
  );

  const statusWithoutState = {
    ok: false,
    state: "starting" as KoedServerComponentState,
    koedHome: paths.koedHome,
    generatedAt: new Date().toISOString(),
    api: { ...apiReady.api, url: apiUrl },
    database: apiReady.database,
    redis: apiReady.redis,
    workerQueues,
    embeddingService: apiReady.embeddingService,
    apiToken,
    mcpServer,
    captureHook,
    codex,
    lcmSummaryService,
    explorer: { ...explorer, url: explorerUrl },
    project,
    lastVerification
  } satisfies KoedServerStatus;

  const blockingComponents = [
    statusWithoutState.api,
    statusWithoutState.database,
    statusWithoutState.redis,
    statusWithoutState.workerQueues,
    statusWithoutState.embeddingService,
    statusWithoutState.apiToken,
    statusWithoutState.mcpServer,
    statusWithoutState.captureHook,
    statusWithoutState.codex,
    statusWithoutState.lcmSummaryService,
    statusWithoutState.lastVerification
  ];
  const state = aggregateState(blockingComponents);
  return { ...statusWithoutState, state, ok: state === "healthy" };
};

export const collectKoedServerDoctor = async (
  environment: NodeJS.ProcessEnv = process.env
): Promise<KoedServerDoctorResult> => {
  const status = await collectKoedServerStatus(environment);
  const checks: KoedServerDoctorCheck[] = [
    ["api", "API", status.api],
    ["database", "Database", status.database],
    ["redis", "Redis", status.redis],
    ["workerQueues", "Redis/queues", status.workerQueues],
    ["embeddingService", "Embedding Service", status.embeddingService],
    ["apiToken", "Local credential/API Token", status.apiToken],
    ["mcpServer", "MCP Server", status.mcpServer],
    ["captureHook", "Supported Capture Hook", status.captureHook],
    ["codex", "Codex configuration", status.codex],
    ["lcmSummaryService", "LCM Summary Service", status.lcmSummaryService],
    ["lastVerification", "Last verification", status.lastVerification],
    ["project", "Project association", status.project]
  ].map(([id, label, component]) => ({
    id: id as string,
    label: label as string,
    ...(component as KoedServerComponentStatus)
  }));
  const failed = checks.filter((check) => check.state === "needs_attention");
  const missing = checks.filter(
    (check) => check.state === "not_configured" && check.id !== "project"
  );
  const summary =
    failed[0]?.message ??
    missing[0]?.message ??
    "Koed local control plane is healthy.";
  return {
    ok: failed.length === 0 && missing.length === 0,
    state: status.state,
    summary,
    koedHome: status.koedHome,
    generatedAt: status.generatedAt,
    checks
  };
};
