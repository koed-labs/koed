import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  ExperienceReplayCodexAuthMode,
  ExperienceReplayRunPlan,
  ResolvedExperienceReplayConfig
} from "./core/index.js";
import { createExperienceReplayCoordinatorDependencies } from "./coordinator-dependencies.js";
import {
  EXPERIENCE_REPLAY_BENCHMARK_SOURCE_ROOT,
  ProductPathPrerequisiteError
} from "./preflight.js";
import {
  createDeterministicSmokeHarborExecutor,
  createDeterministicSmokeProductRuntimeDependencies
} from "./deterministic-smoke-runtime.js";
import { createRecordedCliExperienceReplayDependencies } from "./recorded-runtime.js";
import {
  runTrajectoryJudge,
  TRAJECTORY_JUDGE_SCHEMA_VERSION
} from "./trajectory-judge.js";

const corpusManifest = path.join(
  EXPERIENCE_REPLAY_BENCHMARK_SOURCE_ROOT,
  "fixtures/tb3-v3.0.0.json"
);

export const requiresForcedMemoryAnswerProof = (
  kind: ExperienceReplayRunPlan["kind"]
): boolean =>
  kind === "product_path_proof" ||
  kind === "oracle_seeded_product_proof" ||
  kind === "oracle_seeded_repeated_study";

const required = (
  environment: Readonly<NodeJS.ProcessEnv>,
  name: string
): string => {
  const value = environment[name]?.trim();
  if (!value || /[\r\n]/u.test(value))
    throw new ProductPathPrerequisiteError([`${name} is required`]);
  return value;
};

const postgres = (environment: Readonly<NodeJS.ProcessEnv>) => {
  const adminUrl = required(
    environment,
    "KOED_EXPERIENCE_REPLAY_POSTGRES_ADMIN_URL"
  );
  const parsed = new URL(adminUrl);
  if (parsed.username || parsed.password)
    throw new ProductPathPrerequisiteError([
      "KOED_EXPERIENCE_REPLAY_POSTGRES_ADMIN_URL must not contain credentials"
    ]);
  return {
    adminUrl,
    user: required(environment, "KOED_EXPERIENCE_REPLAY_POSTGRES_USER"),
    password: required(environment, "KOED_EXPERIENCE_REPLAY_POSTGRES_PASSWORD")
  };
};

export const createCliExperienceReplayDependencies = (
  config: ResolvedExperienceReplayConfig,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  runId: string = randomUUID(),
  frozenTaskImages: Readonly<Record<string, string>> = Object.freeze({}),
  codexAuthMode: ExperienceReplayCodexAuthMode = "api_key",
  productPathProof = false
) => {
  if (config.profile !== "smoke") {
    return createRecordedCliExperienceReplayDependencies(config, environment, {
      runId,
      corpusManifest,
      postgres: postgres(environment),
      frozenTaskImages,
      codexAuthMode,
      productPathProof
    });
  }
  return createExperienceReplayCoordinatorDependencies({
    mode: "smoke",
    runId,
    corpusManifest,
    postgres: postgres(environment),
    countEmbeddingTokens: (text) =>
      text.match(/[\p{L}\p{N}_./:-]+/gu)?.length ?? 0,
    smokeExecutor: createDeterministicSmokeHarborExecutor(),
    productPathProof,
    productRuntimeDependencies:
      createDeterministicSmokeProductRuntimeDependencies(),
    lcmSummaryConfig: {
      model: "deterministic-smoke",
      promptVersion: "smoke-v1"
    },
    runScheduledLcmJobs: async ({ repository, actor, scheduledEventIds }) => {
      const scopes = await repository.listPendingLcmDispatchScopes({
        ownerUserId: actor.userId
      });
      const pending = new Set(
        scopes.flatMap((scope) => scope.pendingMemoryEventIds)
      );
      if (scheduledEventIds.some((eventId) => !pending.has(eventId)))
        throw new Error("Deterministic LCM dispatch scope is incomplete");
      const nodeIds: string[] = [];
      for (const scope of scopes) {
        const created = await repository.createLcmNodes(actor, {
          visibility: scope.visibility,
          workClass: scope.workClass,
          force: true
        });
        nodeIds.push(
          ...created.leafNodeIds,
          ...(created.rollupNodeId ? [created.rollupNodeId] : [])
        );
      }
      if (scheduledEventIds.length > 0 && nodeIds.length === 0)
        throw new Error("Deterministic LCM worker created no nodes");
      let inputTokens = 0;
      let outputTokens = 0;
      for (const nodeId of nodeIds) {
        const node = await repository.getLcmNodeForSummarization(nodeId);
        if (!node)
          throw new Error(`Deterministic LCM node disappeared: ${nodeId}`);
        const sourceText = node.sourceItems
          .map((item) => item.text ?? "")
          .filter(Boolean)
          .join(" ");
        const summaryText = sourceText || node.summaryText;
        const count = (value: string) =>
          value.match(/[\p{L}\p{N}_./:-]+/gu)?.length ?? 0;
        inputTokens += count(sourceText);
        outputTokens += count(summaryText);
        await repository.updateLcmNodeSummary({
          nodeId,
          summaryText,
          summaryModel: "deterministic-smoke",
          summaryPromptVersion: "smoke-v1",
          summaryTokenEstimate: count(summaryText),
          summaryStructuredJson: {
            schema_version: "lcm-semantic-summary-v1",
            title: "Deterministic smoke summary",
            summary_text: summaryText,
            lexical_anchors: []
          },
          summaryStructuredSchemaVersion: "lcm-semantic-summary-v1"
        });
      }
      return {
        nodeIds,
        model: "deterministic-smoke",
        promptVersion: "smoke-v1",
        inputTokens,
        outputTokens
      };
    },
    judgeTrajectory: (input) =>
      runTrajectoryJudge(input, {
        config: {
          appServerBinary: "deterministic-smoke",
          model: "deterministic-smoke",
          reasoningEffort: "low",
          timeoutMs: config.timeouts.judge_seconds * 1_000,
          cwd: process.cwd(),
          env: {}
        },
        runner: () =>
          Promise.resolve({
            model: "deterministic-smoke",
            text: JSON.stringify({
              schema_version: TRAJECTORY_JUDGE_SCHEMA_VERSION,
              preference: "tie",
              confidence: 1,
              candidates: Object.fromEntries(
                ["A", "B"].map((label) => [
                  label,
                  {
                    progress_quality: 0,
                    efficiency: 0,
                    error_recognition: 0,
                    failed_approach_avoidance: 0,
                    informed_failure: 0,
                    retrieval_quality: null,
                    correct_prior_experience_reuse: null,
                    distraction_resistance: null,
                    evidence_refs: []
                  }
                ])
              ),
              rationale: "Deterministic smoke tie."
            }),
            tokenUsage: {
              total: {
                inputTokens: 0,
                cachedInputTokens: 0,
                outputTokens: 0,
                reasoningOutputTokens: 0
              }
            }
          })
      }),
    productApiEnvironment: {},
    productRuntimeEnvironment: {}
  });
};
