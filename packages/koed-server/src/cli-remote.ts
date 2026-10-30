import type { Command } from "commander";
import type { KoedServerCliDependencies } from "./cli-contract.js";
import type {
  RemoteOperation,
  RemoteCommandOptions
} from "./remote-mcp-client.js";
import { withCliService } from "./cli-service-loader.js";

// Only the injected compatibility callback receives an argument array. Production
// execution consumes the parsed options directly, including --flag=value forms.
const callbackArguments = (
  operation: RemoteOperation,
  options: RemoteCommandOptions
): string[] => {
  const args: string[] = [operation];
  if (options.client) args.push(options.client);
  for (const [key, flag] of [
    ["backend", "--backend"],
    ["koedHome", "--koed-home"]
  ] as const)
    if (options[key] !== undefined) args.push(flag, options[key]);
  for (const [key, flag] of [
    ["consent", "--consent"],
    ["localRuntime", "--local-runtime"],
    ["teamRead", "--team-read"],
    ["json", "--json"]
  ] as const)
    if (options[key]) args.push(flag);
  return args;
};

export const registerRemoteCommands = (
  program: Command,
  dependencies: KoedServerCliDependencies,
  complete: (code: number) => void
): void => {
  const remote = program
    .command("remote")
    .description("Manage remote authorization and AI Client integrations");
  remote.action(() => remote.outputHelp());
  const bind = (
    command: Command,
    operation: RemoteOperation,
    client?: RemoteCommandOptions["client"]
  ) => {
    command
      .option("--koed-home <path>", "Dedicated local instance directory")
      .option("--json", "Emit pretty JSON output")
      .action(async (options: RemoteCommandOptions) => {
        const input = { ...options, client };
        if (dependencies.runRemoteMcp) {
          complete(
            await dependencies.runRemoteMcp(
              callbackArguments(operation, input),
              {
                stdout: dependencies.stdout ?? process.stdout,
                stderr: dependencies.stderr ?? process.stderr
              }
            )
          );
          return;
        }
        complete(
          await withCliService(
            () => import("./remote-mcp-client.js"),
            (service) =>
              service.runRemoteMcpOperation(operation, input, {
                environment: dependencies.remoteEnvironment,
                stdout: dependencies.stdout ?? process.stdout,
                stderr: dependencies.stderr ?? process.stderr
              }),
            dependencies,
            options.json
          )
        );
      });
  };
  bind(
    remote
      .command("login")
      .description("Authorize remote recall and optional local execution")
      .option("--backend <url>", "HTTPS backend URL")
      .option("--consent", "Explicitly authorize the requested scopes")
      .option("--local-runtime", "Also authorize capture and local execution")
      .option("--team-read", "Request authorized Team recall"),
    "login"
  );
  bind(
    remote
      .command("logout")
      .description("Revoke remote authorization and clear local tokens")
      .option("--consent", "Explicitly authorize logout"),
    "logout"
  );
  bind(
    remote
      .command("start")
      .description("Run the shared remote Local AI Runtime in the foreground"),
    "start"
  );
  for (const operation of ["setup", "check", "remove"] as const) {
    const group = remote
      .command(operation)
      .description(`${operation} a remote AI Client integration`);
    group.action(() => group.outputHelp());
    for (const client of ["codex", "claude", "pi"] as const) {
      const command = group
        .command(client)
        .description(`${operation} the ${client} remote integration`);
      command.option("--consent", "Explicitly authorize integration changes");
      bind(command, operation, client);
    }
  }
};
