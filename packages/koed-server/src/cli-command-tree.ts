import { registerPersonalSyncCommands } from "./cli-personal-sync.js";
import { registerRemoteCommands } from "./cli-remote.js";
import {
  registerInternalCommands,
  secretProviderUsage
} from "./cli-internal.js";
import { Command, CommanderError } from "commander";
import type { KoedServerCliDependencies } from "./cli-contract.js";
import {
  registerComponentCommands,
  componentSyntaxError
} from "./cli-components.js";
import { registerIntegrationCommands } from "./cli-integrations.js";
import { registerLifecycleCommands } from "./cli-lifecycle.js";
import { registerUpstreamCommands } from "./cli-upstream.js";
import { registerProjectCommands } from "./cli-projects.js";
import { registerPackageCommands } from "./cli-package.js";
import { registerModelCommands } from "./cli-models.js";
import { registerRuntimeCommands } from "./cli-runtime.js";
import { resolveKoedControlPlaneVersion } from "./app-runtime.js";

export const runCommandTree = async (
  args: string[],
  dependencies: KoedServerCliDependencies = {}
): Promise<number> => {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  let exitCode = 0;
  const program = new Command()
    .name("koed")
    .description("Manage Koed services and AI Client integrations")
    .version(
      resolveKoedControlPlaneVersion(),
      "-V, --version",
      "Print the Koed version"
    )
    .exitOverride()
    .showSuggestionAfterError(false)
    .configureOutput({
      writeOut: (text) => {
        stdout.write(text);
      },
      writeErr: () => {},
      outputError: () => {}
    });
  program.action(() => program.outputHelp());
  registerRuntimeCommands(program, dependencies, (code) => {
    exitCode = code;
  });
  registerModelCommands(program, dependencies, (code) => {
    exitCode = code;
  });
  registerPackageCommands(program, dependencies, (code) => {
    exitCode = code;
  });
  registerProjectCommands(program, dependencies, (code) => {
    exitCode = code;
  });
  registerUpstreamCommands(program, dependencies, (code) => {
    exitCode = code;
  });
  registerLifecycleCommands(program, dependencies, (code) => {
    exitCode = code;
  });
  registerIntegrationCommands(program, dependencies, (code) => {
    exitCode = code;
  });
  registerComponentCommands(program, dependencies, (code) => {
    exitCode = code;
  });
  registerInternalCommands(program, dependencies, (code) => {
    exitCode = code;
  });
  registerRemoteCommands(program, dependencies, (code) => {
    exitCode = code;
  });
  registerPersonalSyncCommands(
    program,
    dependencies,
    (code) => {
      exitCode = code;
    },
    args.includes("--advanced")
  );
  program.addHelpText(
    "after",
    "\nEnvironment:\n  KOED_HOME       Local configuration, logs, and runtime state\n  KOED_REPO_ROOT  Checkout path for development builds\n\nRun koed <command> --help for command help."
  );
  const configureCommand = (command: Command): void => {
    if (command.commands.length) command.helpCommand(true);
    // The former value readers selected the first occurrence, including FD
    // inputs. Keep that behavior without treating a default as a CLI value.
    // Component commands still reject duplicates through their own listeners.
    for (const option of command.options) {
      if (option.required && !option.parseArg) {
        option.argParser((value, previous: string | undefined) =>
          command.getOptionValueSource(option.attributeName()) === "cli"
            ? previous
            : value
        );
      }
    }
    for (const child of command.commands) configureCommand(child);
  };
  configureCommand(program);
  const publicFamilies = program.commands
    .map((command) => command.name())
    .filter(
      (name) =>
        name !== "secret-provider" && name !== "desktop" && name !== "help"
    );
  try {
    await program.parseAsync(args, { from: "user" });
    return exitCode;
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    if (error.exitCode === 0) return 0;
    if (args[0] === "secret-provider") {
      stdout.write(secretProviderUsage);
      return 1;
    }
    // Commander messages can contain raw arguments. Never echo untrusted values.
    const scope = publicFamilies.includes(args[0] ?? "")
      ? `koed ${args[0]}`
      : "koed";
    const isComponentInput = args[0] === "components";
    const message = isComponentInput
      ? error.code === "koed.componentInput"
        ? error.message
        : componentSyntaxError(error)
      : `${error.code === "commander.unknownCommand" || error.code === "commander.excessArguments" ? "Unknown command" : "Invalid command syntax"}. Run ${scope} --help.`;
    if (publicFamilies.includes(args[0] ?? "") && args.includes("--json"))
      stdout.write(
        `${JSON.stringify({ ok: false, error: message }, null, 2)}\n`
      );
    else stderr.write(`${message}\n`);
    return isComponentInput ? 1 : 2;
  }
};
