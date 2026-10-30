import type { Command } from "commander";
import type { KoedServerCliDependencies } from "./cli-contract.js";
import { withCliService } from "./cli-service-loader.js";

export const secretProviderUsage =
  "Usage: koed secret-provider <get|put|delete> <reference>\n";

export const registerInternalCommands = (
  program: Command,
  dependencies: KoedServerCliDependencies,
  complete: (code: number) => void
): void => {
  const secret = program
    .command("secret-provider", { hidden: true })
    .description("Internal credential adapter");
  secret.action(() => {
    (dependencies.stdout ?? process.stdout).write(secretProviderUsage);
    complete(1);
  });
  for (const operation of ["get", "put", "delete"] as const)
    secret
      .command(operation)
      .argument("<reference>")
      .action(async (reference: string) => {
        if (!reference) {
          (dependencies.stdout ?? process.stdout).write(secretProviderUsage);
          complete(1);
          return;
        }
        complete(
          await withCliService(
            () => import("./cli-internal-operations.js"),
            (service) =>
              service.runSecretProviderCommand(
                operation,
                reference,
                dependencies
              ),
            dependencies,
            false
          )
        );
      });
  const desktop = program
    .command("desktop", { hidden: true })
    .description("Internal Desktop commands");
  desktop.action(() => desktop.outputHelp());
  desktop.command("collaboration-broker").action(async () => {
    complete(
      await withCliService(
        () => import("./desktop-collaboration-broker.js"),
        async (service) => {
          try {
            await service.runDesktopCollaborationBrokerProcess();
            return 0;
          } catch (error) {
            (dependencies.stderr ?? process.stderr).write(
              `${error instanceof Error ? error.message : String(error)}\n`
            );
            return 1;
          }
        },
        dependencies,
        false
      )
    );
  });
};
