import type { KoedServerCliDependencies } from "./cli-contract.js";
import type {
  IntegrationOptions,
  IntegrationOperation
} from "./cli-integrations.js";
import { createCliServiceContext } from "./cli-service-context.js";
import { printJson } from "./cli-service-output.js";
import { evaluateAiClientReadiness } from "./status.js";

export const runIntegrationCommand = async (
  command: IntegrationOperation,
  options: IntegrationOptions,
  dependencies: KoedServerCliDependencies
): Promise<number> => {
  const {
    collectStatus,
    setupCoreIntegration,
    setup,
    setupClaudeIntegration,
    setupPiIntegration,
    removeClaudeIntegration,
    removePiIntegration,
    removeCodexIntegrationFn,
    repairCodex,
    stdout,
    stderr
  } = createCliServiceContext(dependencies);
  const subcommand = options.client;
  const wantsJson = options.json;
  try {
    if (command === "setup" && subcommand === "core") {
      const result = await setupCoreIntegration();
      if (wantsJson) {
        printJson(stdout, result);
      } else {
        stdout.write(
          result.ok
            ? "Koed core setup completed.\n"
            : `${result.error ?? "Koed core setup failed."}\n`
        );
      }
      return result.ok ? 0 : 1;
    }

    if (command === "setup" && subcommand === "codex") {
      const withoutGuidance = Boolean(options.withoutMemoryGuidance);
      const withGuidance = Boolean(options.withMemoryGuidance);
      if (withoutGuidance && withGuidance) {
        throw new Error(
          "Use only one of --with-memory-guidance or --without-memory-guidance."
        );
      }
      const deferredRecall = Boolean(options.deferredRecall);
      const blockingRecall = Boolean(options.blockingRecall);
      if (deferredRecall && blockingRecall)
        throw new Error(
          "Use only one of --deferred-recall or --blocking-recall."
        );
      if (deferredRecall || blockingRecall) {
        stderr.write(
          "Legacy recall flags are deprecated; select delivery_mode on memory_answer instead.\n"
        );
      }
      const result = await setup({
        environment: {
          ...process.env,
          ...(withoutGuidance || withGuidance
            ? {
                KOED_CODEX_GLOBAL_MEMORY_GUIDANCE_ENABLED: String(withGuidance)
              }
            : {}),
          ...(deferredRecall || blockingRecall
            ? { KOED_CODEX_STOP_DELIVERY: deferredRecall ? "1" : "0" }
            : {})
        }
      });
      if (wantsJson) {
        printJson(stdout, result);
      } else {
        stdout.write(
          result.ok
            ? "Codex setup completed.\n"
            : `${result.error ?? "Codex setup failed."}\n`
        );
      }
      return result.ok ? 0 : 1;
    }

    if (command === "setup" && subcommand === "pi") {
      const result = await setupPiIntegration();
      if (wantsJson) {
        printJson(stdout, result);
      } else {
        stdout.write(
          result.ok
            ? result.authenticationState === "authenticated"
              ? "Pi setup completed.\n"
              : "Pi profile configured. Authenticate at least one model through Pi, then refresh capabilities; Pi-executed work remains unavailable until authentication.\n"
            : `${result.error ?? "Pi setup failed."}\n`
        );
      }
      return result.ok ? 0 : 1;
    }

    if (command === "setup" && subcommand === "claude") {
      const result = await (options.backgroundRecall
        ? setupClaudeIntegration(undefined, undefined, {
            backgroundRecall: true
          })
        : setupClaudeIntegration());
      if (wantsJson) {
        printJson(stdout, result);
      } else {
        stdout.write(
          result.ok
            ? result.authenticationState === "authenticated"
              ? "Claude Code setup completed. Restart Claude Code before verifying capture and recall.\n"
              : "Claude Code profile configured. Run `claude auth login`, then refresh capabilities; Claude-executed work remains unavailable until sign-in.\n"
            : `${result.error ?? "Claude Code setup failed."}\n`
        );
      }
      if (!wantsJson && result.backgroundRecall)
        stdout.write(`${result.backgroundRecall.message}\n`);
      return result.ok ? 0 : 1;
    }

    if (command === "repair" && subcommand === "codex") {
      const result = await repairCodex();
      if (wantsJson) {
        printJson(stdout, result);
      } else {
        stdout.write(
          result.ok
            ? "Codex integration repaired. Restart Codex and trust updated hooks if prompted.\n"
            : `${result.error ?? "Codex integration repair failed."}\n`
        );
      }
      return result.ok ? 0 : 1;
    }

    if (command === "check" && subcommand) {
      const status = await collectStatus(undefined, undefined, {
        capabilitiesRefreshedSince: options.capabilitiesRefreshedSince
      });
      const components: Record<string, unknown> = {
        codex: status.codex,
        claude: status.claudeCode,
        pi: status.pi
      };
      const readiness = components[subcommand]
        ? status.aiClients?.[subcommand]
        : undefined;
      if (!components[subcommand])
        throw new Error("check client must be codex, claude, or pi.");
      const result = {
        client: subcommand,
        readiness: readiness ?? null,
        ...(options.includeStatus ? { status } : {}),
        ...evaluateAiClientReadiness(readiness)
      };
      if (wantsJson) printJson(stdout, result);
      else stdout.write(`${result.message}\n`);
      return result.ok ? 0 : 1;
    }

    if (command === "repair" && subcommand) {
      const result =
        subcommand === "codex"
          ? await repairCodex()
          : subcommand === "claude"
            ? await setupClaudeIntegration()
            : subcommand === "pi"
              ? await setupPiIntegration()
              : null;
      if (!result)
        throw new Error("repair client must be codex, claude, or pi.");
      if (wantsJson) printJson(stdout, result);
      else
        stdout.write(
          `${result.ok ? "AI Client integration repaired." : (result.error ?? "AI Client integration repair failed.")}\n`
        );
      return result.ok ? 0 : 1;
    }

    if (command === "remove" && subcommand) {
      const result =
        subcommand === "codex"
          ? removeCodexIntegrationFn()
          : subcommand === "claude"
            ? removeClaudeIntegration()
            : subcommand === "pi"
              ? removePiIntegration()
              : null;
      if (!result)
        throw new Error("remove client must be codex, claude, or pi.");
      if (wantsJson) printJson(stdout, result);
      else
        stdout.write(
          `${result.ok ? "AI Client integration removed." : (result.error ?? "AI Client integration removal failed.")}\n`
        );
      return result.ok ? 0 : 1;
    }

    throw new Error("Unknown AI Client integration operation.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (wantsJson) printJson(stdout, { ok: false, error: message });
    else stderr.write(`${message}\n`);
    return 1;
  }
};
