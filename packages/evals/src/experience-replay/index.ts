import { pathToFileURL } from "node:url";
import { parseExperienceReplayCommand } from "./command.js";
import {
  reportExistingSmokeRun,
  resumeSmokeRun,
  runSmokeExperienceReplay,
  sanitizeRunReport
} from "./coordinator.js";
import {
  loadExperienceReplayConfig,
  preflightExperienceReplay
} from "./preflight.js";

export * from "./artifacts.js";
export * from "./command.js";
export * from "./coordinator.js";
export * from "./cost-admission.js";
export * from "./journal.js";
export * from "./preflight.js";

export const runExperienceReplayCli = async (
  argv: readonly string[]
): Promise<unknown> => {
  const command = parseExperienceReplayCommand(argv);
  switch (command.name) {
    case "preflight": {
      const config = await loadExperienceReplayConfig(command.configPath);
      const result = await preflightExperienceReplay({
        config,
        confirmPaidRun: command.confirmPaidRun,
        requireRunnable: true
      });
      return {
        profile: result.config.profile,
        semanticConfigHash: result.config.semantic_config_hash,
        codingAgentAttempts: result.config.coding_agent_attempt_count,
        concurrency: result.config.concurrency,
        paidCostStopUsd: result.config.paid_cost_stop_usd ?? null,
        capacity: result.capacity,
        recordedModelPathReady: result.recordedModelPathReady
      };
    }
    case "run": {
      const config = await loadExperienceReplayConfig(command.configPath);
      const result = await preflightExperienceReplay({
        config,
        confirmPaidRun: command.confirmPaidRun,
        requireRunnable: true
      });
      return runSmokeExperienceReplay(config, result);
    }
    case "resume":
      return { reportPath: await resumeSmokeRun(command.runDirectory) };
    case "report":
      return { reportPath: await reportExistingSmokeRun(command.runDirectory) };
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
