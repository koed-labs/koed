import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseExperienceReplayCommand } from "./command.js";
import {
  reportExistingRun,
  readExperienceReplayResumeIdentity,
  resumeExperienceReplay,
  runExperienceReplay,
  sanitizeRunReport
} from "./coordinator.js";
import {
  loadExperienceReplayConfig,
  preflightExperienceReplay
} from "./preflight.js";
import { createRecordedPreflightRuntime } from "./recorded-preflight-runtime.js";
import { createCliExperienceReplayDependencies } from "./runtime-options.js";

export * from "./artifacts.js";
export * from "./command.js";
export * from "./coordinator.js";
export * from "./cost-admission.js";
export * from "./journal.js";
export * from "./local-product-adapter.js";
export * from "./oracle-corpus.js";
export * from "./preflight.js";
export * from "./recorded-preflight-runtime.js";
export * from "./replay-scheduler.js";
export * from "./runtime-options.js";

export const runExperienceReplayCli = async (
  argv: readonly string[]
): Promise<unknown> => {
  const command = parseExperienceReplayCommand(argv);
  switch (command.name) {
    case "preflight": {
      const config = await loadExperienceReplayConfig(command.configPath);
      const oracleBrief = command.oracleBriefPath
        ? await readFile(command.oracleBriefPath, "utf8")
        : undefined;
      const oracleBriefSha256 = oracleBrief
        ? createHash("sha256").update(oracleBrief).digest("hex")
        : undefined;
      const codexAuthMode = command.codexSubscription
        ? "subscription"
        : "api_key";
      const recorded =
        config.profile === "smoke"
          ? null
          : createRecordedPreflightRuntime(
              config,
              process.env,
              {},
              codexAuthMode
            );
      const result = await preflightExperienceReplay({
        config,
        confirmPaidRun: command.confirmPaidRun || command.codexSubscription,
        executionKind: command.oracleSeededProof
          ? "oracle_seeded_product_proof"
          : command.productPathProof
            ? "product_path_proof"
            : "benchmark_profile",
        oracleBriefSha256,
        codexAuthMode,
        requireRunnable: true,
        ...(recorded
          ? {
              recordedRunAdapters: recorded.adapters,
              productPathReady: recorded.productPathReady
            }
          : {})
      });
      return {
        executionKind: result.runPlan.kind,
        codexAuthMode: result.runPlan.codexAuthMode,
        profile: result.config.profile,
        semanticConfigHash: result.config.semantic_config_hash,
        codingAgentAttempts: result.runPlan.codingAgentAttemptCount,
        sourceTasks: result.runPlan.sourceTaskDigests.length,
        replayTargetTasks: result.runPlan.replayTargetTaskDigests.length,
        concurrency: result.config.concurrency,
        paidCostStopUsd: result.config.paid_cost_stop_usd ?? null,
        capacity: result.capacity,
        recordedModelPathReady: result.recordedModelPathReady
      };
    }
    case "run": {
      const config = await loadExperienceReplayConfig(command.configPath);
      const oracleBrief = command.oracleBriefPath
        ? await readFile(command.oracleBriefPath, "utf8")
        : undefined;
      const oracleBriefSha256 = oracleBrief
        ? createHash("sha256").update(oracleBrief).digest("hex")
        : undefined;
      const codexAuthMode = command.codexSubscription
        ? "subscription"
        : "api_key";
      const recorded =
        config.profile === "smoke"
          ? null
          : createRecordedPreflightRuntime(
              config,
              process.env,
              {},
              codexAuthMode
            );
      const result = await preflightExperienceReplay({
        config,
        confirmPaidRun: command.confirmPaidRun || command.codexSubscription,
        executionKind: command.oracleSeededProof
          ? "oracle_seeded_product_proof"
          : command.productPathProof
            ? "product_path_proof"
            : "benchmark_profile",
        oracleBriefSha256,
        codexAuthMode,
        requireRunnable: true,
        ...(recorded
          ? {
              recordedRunAdapters: recorded.adapters,
              productPathReady: recorded.productPathReady
            }
          : {})
      });
      const dependencies = createCliExperienceReplayDependencies(
        config,
        process.env,
        undefined,
        result.frozenTaskImages,
        codexAuthMode,
        result.runPlan.kind === "product_path_proof" ||
          result.runPlan.kind === "oracle_seeded_product_proof"
      );
      return runExperienceReplay(config, {
        preflight: result,
        dependencies,
        ...(oracleBrief ? { oracleBrief } : {})
      });
    }
    case "resume": {
      const identity = await readExperienceReplayResumeIdentity(
        command.runDirectory
      );
      const recorded =
        identity.config.profile === "smoke"
          ? null
          : createRecordedPreflightRuntime(
              identity.config,
              process.env,
              {},
              identity.runPlan.codexAuthMode,
              identity.recordedRunAttestation?.taskImages
            );
      const result = await preflightExperienceReplay({
        config: identity.config,
        confirmPaidRun: identity.config.profile !== "smoke",
        executionKind: identity.runPlan.kind,
        oracleBriefSha256: identity.runPlan.oracleBriefSha256,
        codexAuthMode: identity.runPlan.codexAuthMode,
        requireRunnable: true,
        ...(recorded
          ? {
              recordedRunAdapters: recorded.adapters,
              productPathReady: recorded.productPathReady
            }
          : {})
      });
      const dependencies = createCliExperienceReplayDependencies(
        identity.config,
        process.env,
        identity.runId,
        result.frozenTaskImages,
        identity.runPlan.codexAuthMode,
        identity.runPlan.kind === "product_path_proof" ||
          identity.runPlan.kind === "oracle_seeded_product_proof"
      );
      return {
        reportPath: await resumeExperienceReplay(identity.runRoot, {
          preflight: result,
          dependencies
        })
      };
    }
    case "report":
      return { reportPath: await reportExistingRun(command.runDirectory) };
    case "sanitize":
      return {
        publicationDirectory: await sanitizeRunReport(command.runDirectory)
      };
  }
};

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  runExperienceReplayCli(process.argv.slice(2))
    .then((result) =>
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    )
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`experience-replay: ${message}\n`);
      process.exitCode = 1;
    });
}
