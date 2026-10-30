import type { Command } from "commander";
import type { KoedServerCliDependencies } from "./cli-contract.js";
import type { ServerPackageInstallOptions } from "./package-runtime.js";
import { resolveKoedServerPaths } from "./paths.js";

interface PackageOptions {
  json?: boolean;
  source?: string;
  version?: string;
  keep?: string;
  sha256?: string;
  sha256File?: string;
  activate?: boolean;
  provenanceFile?: string;
  signatureFile?: string;
  trustedPublicKey?: string;
  trustedPublicKeyFile?: string;
  trustPolicy?: string;
  allowDowngrade?: boolean;
}

const required = (value: string | undefined, flag: string): string => {
  if (!value) throw new Error(`${flag} is required.`);
  return value;
};

export const registerPackageCommands = (
  program: Command,
  dependencies: KoedServerCliDependencies,
  complete: (code: number) => void
): void => {
  const packages = program
    .command("package")
    .description("Manage standalone Server packages");
  packages.action(() => packages.outputHelp());
  const status = packages
    .command("status")
    .description("Show installed package status");
  const install = packages
    .command("install")
    .description("Verify and install a standalone Server package")
    .option("--source <source>", "Package archive source")
    .option("--sha256 <digest>", "Expected archive SHA-256 digest")
    .option("--sha256-file <path>", "Archive checksum file")
    .option("--activate", "Activate the installed package")
    .option("--provenance-file <path>", "Package provenance file")
    .option("--signature-file <path>", "Package provenance signature")
    .option(
      "--trusted-public-key <key>",
      "Trusted package provenance public key"
    )
    .option(
      "--trusted-public-key-file <path>",
      "Trusted package provenance public key file"
    )
    .option(
      "--trust-policy <policy>",
      "sha256-only, require-provenance, or require-signature"
    )
    .option(
      "--allow-downgrade",
      "Allow a downgrade subject to existing package policy"
    );
  const activate = packages
    .command("activate")
    .description("Activate an installed package version")
    .option("--version <version>", "Installed package version")
    .option(
      "--allow-downgrade",
      "Allow a downgrade subject to existing package policy"
    );
  const cleanup = packages
    .command("cleanup")
    .description("Remove inactive versions and stale archives")
    .option("--keep <count>", "Number of inactive versions to retain", "1");
  for (const command of [status, install, activate, cleanup])
    command
      .option("--json", "Emit JSON output")
      .action(async (options: PackageOptions) => {
        const stdout = dependencies.stdout ?? process.stdout;
        const stderr = dependencies.stderr ?? process.stderr;
        try {
          const paths = (dependencies.resolvePaths ?? resolveKoedServerPaths)();
          let result: { ok: boolean; message: string };
          switch (command.name()) {
            case "status": {
              const execute =
                dependencies.collectPackageStatus ??
                (await import("./package-runtime.js"))
                  .collectServerPackageStatus;
              result = execute(paths);
              break;
            }
            case "install": {
              const source = required(options.source, "--source");
              const policy = options.trustPolicy;
              if (
                policy !== undefined &&
                policy !== "sha256-only" &&
                policy !== "require-provenance" &&
                policy !== "require-signature"
              )
                throw new Error(
                  "--trust-policy must be sha256-only, require-provenance, or require-signature."
                );
              const input: ServerPackageInstallOptions = {
                source,
                activate: Boolean(options.activate)
              };
              for (const key of [
                "sha256",
                "sha256File",
                "provenanceFile",
                "signatureFile",
                "trustedPublicKey",
                "trustedPublicKeyFile"
              ] as const)
                if (options[key] !== undefined) input[key] = options[key];
              if (policy !== undefined) input.trustPolicy = policy;
              if (options.allowDowngrade) input.allowDowngrade = true;
              const execute =
                dependencies.installPackage ??
                (await import("./package-runtime.js")).installServerPackage;
              result = await execute(paths, input);
              break;
            }
            case "activate": {
              const version = required(options.version, "--version");
              const execute =
                dependencies.activatePackage ??
                (await import("./package-runtime.js")).activateServerPackage;
              result = execute(paths, version, {
                allowDowngrade: Boolean(options.allowDowngrade)
              });
              break;
            }
            default: {
              const execute =
                dependencies.cleanupPackages ??
                (await import("./package-runtime.js")).cleanupServerPackages;
              result = execute(paths, Number.parseInt(options.keep ?? "1", 10));
            }
          }
          stdout.write(
            options.json
              ? `${JSON.stringify(result, null, 2)}\n`
              : `${result.message}\n`
          );
          complete(result.ok ? 0 : 1);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (options.json)
            stdout.write(
              `${JSON.stringify({ ok: false, error: message }, null, 2)}\n`
            );
          else stderr.write(`${message}\n`);
          complete(1);
        }
      });
};
