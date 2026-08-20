import { countTokensForModel } from "@koed/core";
import type { ActorContext, MemorySourceRepository } from "@koed/db";
import {
  executeLcmSummaryNode,
  LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
  loadPrompt,
  resolveLcmSummaryWorkerConfig,
  runLcmSummary,
  type LcmSummaryRunner,
  type LcmSummaryWorkerConfig
} from "@koed/mcp-server";
import type { ResolvedExperienceReplayConfig } from "./core/index.js";
import type { ScheduledLcmJobAttestation } from "./local-product-adapter.js";

export interface RecordedLcmJobRunnerOptions {
  config: ResolvedExperienceReplayConfig;
  environment: NodeJS.ProcessEnv;
  runner?: LcmSummaryRunner;
}

const usage = (result: Awaited<ReturnType<LcmSummaryRunner>>) => {
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
  if (scheduledEventIds.length === 0) {
    return [];
  }
  const observedPending = new Set<string>();
  const nodeIds: string[] = [];
  while (true) {
    const scopes = await repository.listPendingLcmDispatchScopes({
      ownerUserId: actor.userId
    });
    const pendingIds = scopes.flatMap((scope) => scope.pendingMemoryEventIds);
    if (pendingIds.length === 0) {
      break;
    }
    if (pendingIds.some((eventId) => observedPending.has(eventId))) {
      throw new Error("Recorded LCM dispatch repeated pending work");
    }
    for (const eventId of pendingIds) {
      observedPending.add(eventId);
    }
    for (const scope of scopes) {
      const created = await repository.createLcmNodes(actor, {
        visibility: scope.visibility,
        workClass: scope.workClass,
        force: true
      });
      const createdNodeIds = [
        ...created.leafNodeIds,
        ...(created.rollupNodeId ? [created.rollupNodeId] : [])
      ];
      if (createdNodeIds.length === 0) {
        throw new Error("Recorded LCM worker made no dispatch progress");
      }
      nodeIds.push(...createdNodeIds);
    }
  }
  return nodeIds;
};

export const createRecordedLcmJobRunner = ({
  config,
  environment,
  runner = runLcmSummary
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
      executablePath: environment.MEMORY_CODEX_APP_SERVER_BINARY
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
    if (scheduledEventIds.length === 0) {
      return {
        nodeIds: [],
        model: config.lcm_summary.model.id,
        promptVersion: config.lcm_summary.prompt_version,
        inputTokens: 0,
        outputTokens: 0
      };
    }
    await createNodes(repository, actor, scheduledEventIds);
    const nodeIds: string[] = [];
    const processedNodeIds = new Set<string>();
    let inputTokens = 0;
    let outputTokens = 0;
    while (true) {
      const pending = await repository.listLcmNodesNeedingSummaries(actor, {
        limit: 50
      });
      if (pending.length === 0) break;
      if (pending.some((node) => processedNodeIds.has(node.id))) {
        throw new Error("Recorded LCM summary queue repeated pending work");
      }
      for (const node of pending) {
        processedNodeIds.add(node.id);
        const execution = await executeLcmSummaryNode(
          node,
          workerConfig,
          runner
        );
        const structured = execution.result.structuredSummary;
        if (!structured) {
          throw new Error("Recorded LCM result lacks a structured summary");
        }
        for (const promptResult of execution.promptResults) {
          const measured = usage(promptResult);
          inputTokens += measured.inputTokens;
          outputTokens += measured.outputTokens;
        }
        await repository.updateLcmNodeSummary({
          nodeId: node.id,
          summaryText: structured.summary_text,
          summaryModel: execution.result.model,
          summaryPromptVersion: config.lcm_summary.prompt_version,
          summaryTokenEstimate: countTokensForModel(structured.summary_text, {
            model: workerConfig.model
          }).tokens,
          summaryStructuredJson: structured,
          summaryStructuredSchemaVersion: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION
        });
        nodeIds.push(node.id);
      }
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
