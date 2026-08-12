import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedExperienceReplayConfig } from "./core/index.js";
import { createExperienceReplayCoordinatorDependencies } from "./coordinator-dependencies.js";
import { ProductPathPrerequisiteError } from "./preflight.js";
import {
  createDeterministicSmokeHarborExecutor,
  createDeterministicSmokeProductRuntimeDependencies
} from "./deterministic-smoke-runtime.js";
import { createRecordedCliExperienceReplayDependencies } from "./recorded-runtime.js";

const sourceRoot = path.dirname(fileURLToPath(import.meta.url));

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
  frozenTaskImages: Readonly<Record<string, string>> = Object.freeze({})
) => {
  if (config.profile !== "smoke") {
    return createRecordedCliExperienceReplayDependencies(config, environment, {
      runId,
      corpusManifest: path.join(sourceRoot, "fixtures/tb3-v3.0.0.json"),
      postgres: postgres(environment),
      frozenTaskImages
    });
  }
  return createExperienceReplayCoordinatorDependencies({
    mode: "smoke",
    runId,
    corpusManifest: path.join(sourceRoot, "fixtures/tb3-v3.0.0.json"),
    postgres: postgres(environment),
    countEmbeddingTokens: (text) =>
      text.match(/[\p{L}\p{N}_./:-]+/gu)?.length ?? 0,
    smokeExecutor: createDeterministicSmokeHarborExecutor(),
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
    productApiEnvironment: {},
    productRuntimeEnvironment: {}
  });
};
