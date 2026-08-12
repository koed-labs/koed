import {
  countTokensForModel,
  lcmLexicalAnchorGroundingPayloads,
  validateLcmLexicalAnchors
} from "@koed/core";
import type { ActorContext, MemorySourceRepository } from "@koed/db";
import {
  buildLcmSummaryPrompt,
  LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
  loadPrompt,
  parseStructuredLcmSummary,
  resolveLcmSummaryWorkerConfig,
  runCodexAppServerLcmSummary,
  type CodexLcmSummaryRunner,
  type LcmSummaryWorkerConfig
} from "@koed/mcp-server";
import type { ResolvedExperienceReplayConfig } from "./core/index.js";
import type { ScheduledLcmJobAttestation } from "./local-product-adapter.js";

export interface RecordedLcmJobRunnerOptions {
  config: ResolvedExperienceReplayConfig;
  environment: NodeJS.ProcessEnv;
  runner?: CodexLcmSummaryRunner;
}

const usage = (result: Awaited<ReturnType<CodexLcmSummaryRunner>>) => {
  const measured = result.tokenUsage?.total ?? result.tokenUsage?.last;
  const inputTokens = measured?.inputTokens;
  const outputTokens = measured?.outputTokens;
  if (
    !Number.isSafeInteger(inputTokens) ||
    (inputTokens as number) < 0 ||
    !Number.isSafeInteger(outputTokens) ||
    (outputTokens as number) < 0
  ) {
    throw new Error("Codex LCM result lacks measured input/output token usage");
  }
  return {
    inputTokens: inputTokens as number,
    outputTokens: outputTokens as number
  };
};

const createNodes = async (
  repository: MemorySourceRepository,
  actor: ActorContext,
  scheduledEventIds: readonly string[]
): Promise<string[]> => {
  const scopes = await repository.listPendingLcmDispatchScopes({
    ownerUserId: actor.userId
  });
  const pending = new Set(
    scopes.flatMap((scope) => scope.pendingMemoryEventIds)
  );
  if (scheduledEventIds.some((eventId) => !pending.has(eventId))) {
    throw new Error("Recorded LCM dispatch scope is incomplete");
  }
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
  if (scheduledEventIds.length > 0 && nodeIds.length === 0) {
    throw new Error("Recorded LCM worker created no nodes");
  }
  return nodeIds;
};

export const createRecordedLcmJobRunner = ({
  config,
  environment,
  runner = runCodexAppServerLcmSummary
}: RecordedLcmJobRunnerOptions) => {
  if (
    config.lcm_summary.output_schema_version !==
    LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION
  ) {
    throw new Error(
      `Recorded LCM output schema must be ${LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION}`
    );
  }
  const productionPromptVersions = (
    [
      "lcm-summary-leaf",
      "lcm-summary-rollup",
      "lcm-summary-partial",
      "lcm-summary-reduce"
    ] as const
  ).map((promptId) => loadPrompt(promptId, { env: environment }).version);
  if (
    productionPromptVersions.some(
      (version) => version !== config.lcm_summary.prompt_version
    )
  ) {
    throw new Error(
      "Recorded LCM prompt version does not match the production prompt bundle"
    );
  }
  const workerConfig: LcmSummaryWorkerConfig = resolveLcmSummaryWorkerConfig(
    environment,
    {
      provider: "codex",
      model: config.lcm_summary.model.id,
      reasoningEffort: config.lcm_summary.model.reasoning_effort,
      timeoutMs: config.timeouts.preparation_seconds * 1_000,
      maxPromptTokens: config.admission.max_input_tokens_per_call,
      appServerBinary: environment.MEMORY_CODEX_APP_SERVER_BINARY
    }
  );

  return async ({
    repository,
    actor,
    scheduledEventIds
  }: {
    repository: MemorySourceRepository;
    actor: ActorContext;
    scheduledEventIds: readonly string[];
  }): Promise<ScheduledLcmJobAttestation> => {
    const nodeIds = await createNodes(repository, actor, scheduledEventIds);
    let inputTokens = 0;
    let outputTokens = 0;
    for (const nodeId of nodeIds) {
      const node = await repository.getLcmNodeForSummarization(nodeId);
      if (!node) throw new Error(`Recorded LCM node disappeared: ${nodeId}`);
      const prompt = buildLcmSummaryPrompt(node, "summary", workerConfig.env);
      const promptTokens = countTokensForModel(prompt, {
        model: workerConfig.model
      }).tokens;
      if (promptTokens > workerConfig.maxPromptTokens) {
        throw new Error(
          `Recorded LCM prompt exceeds configured input limit for ${nodeId}`
        );
      }
      let result: Awaited<ReturnType<CodexLcmSummaryRunner>> | undefined;
      let failure: unknown;
      for (let attempt = 1; attempt <= workerConfig.maxAttempts; attempt += 1) {
        try {
          result = await runner(
            prompt,
            workerConfig,
            workerConfig.timeoutMs * attempt
          );
          break;
        } catch (error) {
          failure = error;
        }
      }
      if (!result) throw failure;
      const structured = parseStructuredLcmSummary(result.text);
      const grounding = validateLcmLexicalAnchors(
        structured.lexical_anchors,
        lcmLexicalAnchorGroundingPayloads(node.sourceItems)
      );
      if (grounding.rejected.length > 0) {
        throw new Error(`Recorded LCM summary has unsupported lexical anchors`);
      }
      const measured = usage(result);
      inputTokens += measured.inputTokens;
      outputTokens += measured.outputTokens;
      await repository.updateLcmNodeSummary({
        nodeId,
        summaryText: structured.summary_text,
        summaryModel: result.model,
        summaryPromptVersion: config.lcm_summary.prompt_version,
        summaryTokenEstimate: countTokensForModel(structured.summary_text, {
          model: workerConfig.model
        }).tokens,
        summaryStructuredJson: structured,
        summaryStructuredSchemaVersion: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION
      });
    }
    return {
      nodeIds,
      model: config.lcm_summary.model.id,
      promptVersion: config.lcm_summary.prompt_version,
      inputTokens,
      outputTokens
    };
  };
};
