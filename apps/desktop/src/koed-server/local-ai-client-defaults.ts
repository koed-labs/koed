import type {
  LocalAiClientDefault,
  LocalAiClientFlowKey,
  LocalAiClientRuntimeAssignment
} from "../ipc/local-ai-client-protocol.js";

type DocumentedDefault = {
  source: "code";
  available: true;
  persistable: boolean;
  assignment: LocalAiClientRuntimeAssignment;
  reason: string | null;
};

type FlowSpec = {
  prefix: string;
  timeoutMs: number;
  parseTimeout: (raw: string | undefined, fallback: number) => number;
  parseAttempts: (raw: string | undefined, fallback: number) => number;
};

export const localAiClientDefaultSpec: Record<LocalAiClientFlowKey, FlowSpec> =
  {
    mcp_memory_answer: {
      prefix: "MEMORY_ANSWER",
      timeoutMs: 120_000,
      parseTimeout: answerTimeout,
      parseAttempts: answerAttempts
    },
    lcm_summary: {
      prefix: "MEMORY_LCM_SUMMARY",
      timeoutMs: 120_000,
      parseTimeout: minimumInteger,
      parseAttempts: minimumInteger
    },
    session_title: {
      prefix: "MEMORY_LCM_SUMMARY",
      timeoutMs: 120_000,
      parseTimeout: minimumInteger,
      parseAttempts: minimumInteger
    },
    curated_memory_review: {
      prefix: "MEMORY_CURATED_REVIEW",
      timeoutMs: 90_000,
      parseTimeout: curatedTimeout,
      parseAttempts: minimumInteger
    }
  };

function parsedInteger(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function minimumInteger(raw: string | undefined, fallback: number): number {
  return Math.max(1, parsedInteger(raw, fallback));
}

function curatedTimeout(raw: string | undefined, fallback: number): number {
  return Math.max(1_000, parsedInteger(raw, fallback));
}

function answerTimeout(raw: string | undefined, fallback: number): number {
  return Math.min(600_000, Math.max(1_000, parsedInteger(raw, fallback)));
}

function answerAttempts(raw: string | undefined, fallback: number): number {
  return Math.min(25, Math.max(1, parsedInteger(raw, fallback)));
}

const persisted = (assignment: LocalAiClientRuntimeAssignment): boolean =>
  assignment.timeout_ms <= 600_000 && assignment.max_attempts <= 25;

export const documentDefault = (
  assignment: LocalAiClientRuntimeAssignment
): DocumentedDefault => {
  const persistable = persisted(assignment);
  return {
    source: "code",
    available: true,
    persistable,
    assignment,
    reason: persistable
      ? null
      : "Effective runtime default exceeds persisted assignment limits; choose bounded values before saving."
  };
};

export const environmentDefaultFor = (
  flowKey: LocalAiClientFlowKey,
  documented: LocalAiClientDefault | undefined,
  environment: NodeJS.ProcessEnv
): LocalAiClientDefault => {
  const spec = localAiClientDefaultSpec[flowKey];
  const base = documented?.assignment;
  const value = (suffix: string): string | undefined => {
    const raw = environment[`${spec.prefix}_${suffix}`]?.trim();
    return raw || undefined;
  };
  const hasEnvironmentValue = [
    "PROVIDER",
    "AI_CLIENT_INSTANCE",
    "MODEL",
    "REASONING_EFFORT",
    "TIMEOUT_MS",
    "MAX_ATTEMPTS"
  ].some((suffix) => value(suffix) !== undefined);
  if (!base) return unavailableDefault(hasEnvironmentValue);
  const provider = value("PROVIDER")?.toLowerCase() ?? base.provider;
  if (!isProvider(provider)) {
    return unavailableEnvironment("Environment provider is unsupported.");
  }
  const model = value("MODEL") ?? providerModel(provider, base.model);
  if (!model) {
    return unavailableEnvironment("Selected provider requires explicit model.");
  }
  const assignment = {
    ...base,
    provider,
    ai_client_instance_id: value("AI_CLIENT_INSTANCE") ?? `${provider}.default`,
    model,
    reasoning_effort: value("REASONING_EFFORT") ?? base.reasoning_effort,
    timeout_ms: parseTimeout(spec, value("TIMEOUT_MS"), base.timeout_ms),
    max_attempts: spec.parseAttempts(value("MAX_ATTEMPTS"), base.max_attempts)
  };
  return {
    ...documentDefault(assignment),
    source: hasEnvironmentValue ? "environment" : "code"
  };
};

const parseTimeout = (
  spec: FlowSpec,
  raw: string | undefined,
  fallback: number
): number => spec.parseTimeout(raw, fallback);

const providerModel = (provider: string, fallback: string): string | null =>
  provider === "pi" ? null : provider === "claude" ? "haiku" : fallback;

const isProvider = (
  provider: string
): provider is LocalAiClientRuntimeAssignment["provider"] =>
  provider === "codex" || provider === "claude" || provider === "pi";

const unavailableEnvironment = (reason: string): LocalAiClientDefault => ({
  source: "environment",
  available: false,
  persistable: false,
  assignment: null,
  reason
});

const unavailableDefault = (
  hasEnvironmentValue: boolean
): LocalAiClientDefault => ({
  source: hasEnvironmentValue ? "environment" : "code",
  available: false,
  persistable: false,
  assignment: null,
  reason: "No documented default is available."
});
