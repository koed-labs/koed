import type { SupportedAiClientDriverId } from "./ai-client-contract.js";

export const localAiClientFlowKeys = [
  "mcp_memory_answer",
  "lcm_summary",
  "session_title",
  "curated_memory_review"
] as const;
export type LocalAiClientFlowKey = (typeof localAiClientFlowKeys)[number];

export interface LocalAiClientRuntimeAssignment {
  provider: SupportedAiClientDriverId;
  ai_client_instance_id: string;
  model: string;
  reasoning_effort: string;
  timeout_ms: number;
  max_attempts: number;
}

export interface LocalAiClientDefault {
  source: "environment" | "code";
  available: boolean;
  persistable?: boolean;
  assignment: LocalAiClientRuntimeAssignment | null;
  reason: string | null;
}

type FlowSpec = {
  prefix: string;
  timeoutMs: number;
  parseTimeout: (raw: string | undefined, fallback: number) => number;
  parseAttempts: (raw: string | undefined, fallback: number) => number;
};

const parsedInteger = (raw: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const minimumInteger = (raw: string | undefined, fallback: number): number =>
  Math.max(1, parsedInteger(raw, fallback));
const curatedTimeout = (raw: string | undefined, fallback: number): number =>
  Math.max(1_000, parsedInteger(raw, fallback));
const answerTimeout = (raw: string | undefined, fallback: number): number =>
  Math.min(600_000, Math.max(1_000, parsedInteger(raw, fallback)));
const answerAttempts = (raw: string | undefined, fallback: number): number =>
  Math.min(25, Math.max(1, parsedInteger(raw, fallback)));

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

export const codeDefaultAssignmentFor = (
  flowKey: LocalAiClientFlowKey
): LocalAiClientRuntimeAssignment => ({
  provider: "codex",
  ai_client_instance_id: "codex.default",
  model: "gpt-5.6-luna",
  reasoning_effort: "low",
  timeout_ms: localAiClientDefaultSpec[flowKey].timeoutMs,
  max_attempts: 2
});

export const documentDefault = (
  assignment: LocalAiClientRuntimeAssignment
): LocalAiClientDefault => ({
  source: "code",
  available: true,
  persistable:
    assignment.timeout_ms <= 600_000 && assignment.max_attempts <= 25,
  assignment,
  reason:
    assignment.timeout_ms <= 600_000 && assignment.max_attempts <= 25
      ? null
      : "Effective runtime default exceeds persisted assignment limits; choose bounded values before saving."
});

const isProvider = (value: string): value is SupportedAiClientDriverId =>
  value === "codex" || value === "claude" || value === "pi";

const unavailable = (
  source: "environment" | "code",
  reason: string
): LocalAiClientDefault => ({
  source,
  available: false,
  persistable: false,
  assignment: null,
  reason
});

/** Resolve User-independent runtime default. User settings take precedence outside this resolver. */
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
  if (!base) {
    return unavailable(
      hasEnvironmentValue ? "environment" : "code",
      "No documented default is available."
    );
  }
  const provider = value("PROVIDER")?.toLowerCase() ?? base.provider;
  if (!isProvider(provider)) {
    return unavailable("environment", "Environment provider is unsupported.");
  }
  const model =
    value("MODEL") ??
    (provider === "pi" ? null : provider === "claude" ? "haiku" : base.model);
  if (!model) {
    return unavailable(
      "environment",
      "Selected provider requires explicit model."
    );
  }
  const assignment: LocalAiClientRuntimeAssignment = {
    ...base,
    provider,
    ai_client_instance_id: value("AI_CLIENT_INSTANCE") ?? `${provider}.default`,
    model,
    reasoning_effort: value("REASONING_EFFORT") ?? base.reasoning_effort,
    timeout_ms: spec.parseTimeout(value("TIMEOUT_MS"), base.timeout_ms),
    max_attempts: spec.parseAttempts(value("MAX_ATTEMPTS"), base.max_attempts)
  };
  return {
    ...documentDefault(assignment),
    source: hasEnvironmentValue ? "environment" : "code"
  };
};
