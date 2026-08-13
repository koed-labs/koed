import { z } from "zod";
import { immutableHash } from "./hash.js";

export const EXPERIENCE_REPLAY_CONFIG_VERSION = 1 as const;
export const TRAJECTORY_JUDGE_PROMPT_VERSION =
  "experience-replay-trajectory-judge-v1" as const;
export const TRAJECTORY_JUDGE_SCHEMA_VERSION =
  "experience-replay-trajectory-judge-v1" as const;
export const PROFILES = ["smoke", "quick", "standard", "full"] as const;
export type ExperienceReplayProfile = (typeof PROFILES)[number];

export const PROFILE_POLICY = {
  smoke: {
    taskCount: 2,
    replayAttemptsPerCondition: 1,
    codingAgentAttempts: 10
  },
  quick: {
    taskCount: 12,
    replayAttemptsPerCondition: 1,
    codingAgentAttempts: 60
  },
  standard: {
    taskCount: 24,
    replayAttemptsPerCondition: 2,
    codingAgentAttempts: 216
  },
  full: {
    taskCount: 74,
    replayAttemptsPerCondition: 3,
    codingAgentAttempts: 962
  }
} as const satisfies Record<
  ExperienceReplayProfile,
  {
    taskCount: number;
    replayAttemptsPerCondition: number;
    codingAgentAttempts: number;
  }
>;

const immutableIdentifier = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !/(?:^|[-_.])latest(?:$|[-_.])/i.test(value), {
    message: "mutable latest identifiers are not allowed"
  });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const modelSchema = z
  .object({
    id: immutableIdentifier,
    reasoning_effort: z.enum(["low", "medium", "high", "xhigh"])
  })
  .strict();
const workerSchema = z
  .object({
    model: modelSchema,
    prompt_version: immutableIdentifier,
    output_schema_version: immutableIdentifier
  })
  .strict();
const trajectoryJudgeSchema = z
  .object({
    model: modelSchema,
    prompt_version: z.literal(TRAJECTORY_JUDGE_PROMPT_VERSION),
    output_schema_version: z.literal(TRAJECTORY_JUDGE_SCHEMA_VERSION)
  })
  .strict();
const timeoutSchema = z
  .object({
    agent_seconds: z.number().int().positive(),
    setup_seconds: z.number().int().positive(),
    verifier_seconds: z.number().int().positive(),
    preparation_seconds: z.number().int().positive(),
    judge_seconds: z.number().int().positive(),
    teardown_seconds: z.number().int().positive()
  })
  .strict();
const priceSchema = z
  .object({
    uncached_input_usd_per_million: z.number().finite().nonnegative(),
    cached_input_usd_per_million: z.number().finite().nonnegative(),
    output_usd_per_million: z.number().finite().nonnegative()
  })
  .strict();
const admissionSchema = z
  .object({
    maximum_trajectory_bytes: z.number().int().positive(),
    estimated_attempt_artifact_bytes: z.number().int().nonnegative(),
    estimated_image_bytes_per_task: z.number().int().nonnegative(),
    scratch_multiplier: z.number().finite().min(1),
    minimum_free_space_reserve_bytes: z.number().int().nonnegative(),
    max_input_tokens_per_call: z.number().int().positive(),
    max_output_tokens_per_call: z.number().int().positive(),
    max_memory_answer_calls_per_attempt: z.number().int().nonnegative(),
    max_preparation_calls_per_source: z.number().int().nonnegative(),
    provider_spending_limit_usd: z.number().finite().positive().optional()
  })
  .strict();

const configSchema = z
  .object({
    version: z.literal(EXPERIENCE_REPLAY_CONFIG_VERSION),
    profile: z.enum(PROFILES),
    seed: z.string().min(1),
    output_dir: z.string().min(1),
    codex_cli: z
      .object({
        version: immutableIdentifier,
        host_sha256: sha256Schema,
        container_sha256: sha256Schema,
        container_code_mode_host_sha256: sha256Schema
      })
      .strict(),
    coding_agent: modelSchema,
    memory_answer: workerSchema,
    lcm_summary: workerSchema,
    session_title: workerSchema,
    trajectory_judge: trajectoryJudgeSchema,
    embedding: z
      .object({
        model: immutableIdentifier,
        artifact_sha256: sha256Schema,
        tokenizer: immutableIdentifier,
        transform: immutableIdentifier,
        dimensions: z.number().int().positive()
      })
      .strict(),
    price_table: z
      .object({
        version: immutableIdentifier,
        sha256: sha256Schema,
        models: z.record(immutableIdentifier, priceSchema)
      })
      .strict(),
    timeouts: timeoutSchema,
    admission: admissionSchema,
    paid_cost_stop_usd: z.number().finite().positive().optional(),
    concurrency: z.number().int().positive().optional()
  })
  .strict()
  .superRefine((config, context) => {
    const concurrency =
      config.concurrency ?? (config.profile === "standard" ? 2 : 1);
    if (config.profile !== "smoke" && config.paid_cost_stop_usd === undefined) {
      context.addIssue({
        code: "custom",
        path: ["paid_cost_stop_usd"],
        message: "is required for model-driven profiles"
      });
    }
    if (
      config.profile !== "smoke" &&
      config.admission.provider_spending_limit_usd === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["admission", "provider_spending_limit_usd"],
        message: "is required for model-driven profiles"
      });
    }
    if (config.profile === "quick" && concurrency !== 1) {
      context.addIssue({
        code: "custom",
        path: ["concurrency"],
        message: "quick requires concurrency 1"
      });
    }
    if (config.profile === "standard" && concurrency > 2) {
      context.addIssue({
        code: "custom",
        path: ["concurrency"],
        message: "standard concurrency cannot exceed 2"
      });
    }
    if (config.profile === "full" && config.concurrency === undefined) {
      context.addIssue({
        code: "custom",
        path: ["concurrency"],
        message: "full requires explicit concurrency"
      });
    }
    if (config.profile === "quick" || config.profile === "standard") {
      const models = [
        config.coding_agent,
        config.memory_answer.model,
        config.lcm_summary.model,
        config.session_title.model
      ];
      if (
        models.some(
          (model) =>
            model.id !== "gpt-5.6-luna" || model.reasoning_effort !== "low"
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["coding_agent"],
          message: `${config.profile} requires the exact gpt-5.6-luna model with low reasoning for every AI Client workflow`
        });
      }
      if (
        config.trajectory_judge.model.id !== "gpt-5.6-luna" ||
        config.trajectory_judge.model.reasoning_effort !== "medium"
      ) {
        context.addIssue({
          code: "custom",
          path: ["trajectory_judge", "model"],
          message: `${config.profile} requires the exact gpt-5.6-luna model with medium reasoning for trajectory judging`
        });
      }
    }
    if (
      config.profile === "smoke" &&
      (config.trajectory_judge.model.id !== "deterministic-smoke" ||
        config.trajectory_judge.model.reasoning_effort !== "low")
    ) {
      context.addIssue({
        code: "custom",
        path: ["trajectory_judge", "model"],
        message:
          "smoke requires the exact deterministic-smoke model with low reasoning for trajectory judging"
      });
    }
    const selectedModels = new Set([
      config.coding_agent.id,
      config.memory_answer.model.id,
      config.lcm_summary.model.id,
      config.session_title.model.id,
      config.trajectory_judge.model.id
    ]);
    for (const model of selectedModels) {
      if (!(model in config.price_table.models) && config.profile !== "smoke") {
        context.addIssue({
          code: "custom",
          path: ["price_table", "models"],
          message: `missing price for ${model}`
        });
      }
    }
  });

export type ExperienceReplayConfig = z.infer<typeof configSchema>;
export type ResolvedExperienceReplayConfig = ExperienceReplayConfig & {
  task_count: number;
  replay_attempts_per_condition: number;
  coding_agent_attempt_count: number;
  concurrency: number;
  maximum_top_level_attempt_cost_usd: number;
  maximum_judge_call_cost_usd: number;
  maximum_concurrent_overshoot_usd: number;
  semantic_config_hash: string;
};

const callMaximumCost = (
  config: ExperienceReplayConfig,
  modelId: string
): number => {
  const price = config.price_table.models[modelId];
  if (!price) return 0;
  return (
    (config.admission.max_input_tokens_per_call *
      price.uncached_input_usd_per_million +
      config.admission.max_output_tokens_per_call *
        price.output_usd_per_million) /
    1_000_000
  );
};

export const parseExperienceReplayConfig = (
  input: unknown
): ExperienceReplayConfig => configSchema.parse(input);

export const resolveExperienceReplayConfig = (
  input: unknown
): ResolvedExperienceReplayConfig => {
  const config = parseExperienceReplayConfig(input);
  const policy = PROFILE_POLICY[config.profile];
  const concurrency =
    config.concurrency ?? (config.profile === "standard" ? 2 : 1);
  const maximumTopLevelAttemptCost =
    callMaximumCost(config, config.coding_agent.id) +
    config.admission.max_memory_answer_calls_per_attempt *
      callMaximumCost(config, config.memory_answer.model.id) +
    config.admission.max_preparation_calls_per_source *
      Math.max(
        callMaximumCost(config, config.lcm_summary.model.id),
        callMaximumCost(config, config.session_title.model.id)
      );
  const maximumJudgeCallCost = callMaximumCost(
    config,
    config.trajectory_judge.model.id
  );
  const maximumConcurrentOvershoot =
    maximumTopLevelAttemptCost * concurrency + maximumJudgeCallCost;
  if (config.profile !== "smoke") {
    const budget = config.paid_cost_stop_usd!;
    const providerLimit = config.admission.provider_spending_limit_usd!;
    const epsilon = 1e-9;
    if (
      providerLimit + epsilon < budget ||
      providerLimit > budget + maximumConcurrentOvershoot + epsilon
    ) {
      throw new Error(
        "provider_spending_limit_usd must be between the paid stop and the paid stop plus maximum concurrent overshoot"
      );
    }
  }
  const resolvedWithoutHash = {
    ...config,
    concurrency,
    task_count: policy.taskCount,
    replay_attempts_per_condition: policy.replayAttemptsPerCondition,
    coding_agent_attempt_count: policy.codingAgentAttempts,
    maximum_top_level_attempt_cost_usd: maximumTopLevelAttemptCost,
    maximum_judge_call_cost_usd: maximumJudgeCallCost,
    maximum_concurrent_overshoot_usd: maximumConcurrentOvershoot
  };
  const semanticConfig = Object.fromEntries(
    Object.entries(resolvedWithoutHash).filter(([key]) => key !== "output_dir")
  );
  return {
    ...resolvedWithoutHash,
    semantic_config_hash: immutableHash(semanticConfig)
  };
};
