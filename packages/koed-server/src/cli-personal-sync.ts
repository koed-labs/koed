import { Option, type Command } from "commander";
import type { KoedServerCliDependencies } from "./cli-contract.js";
import { resolveKoedServerPaths } from "./paths.js";
import { withCliService } from "./cli-service-loader.js";

export interface PairOptions {
  json?: boolean;
  deviceLabel?: string;
  detach?: boolean;
}
const recoveryOptions = {
  group: ["--group-id <id>", "Personal Sync group identifier"],
  device: ["--device-id <id>", "Retained Desktop compatibility metadata"],
  challenge: ["--challenge-id <id>", "Pending enrollment challenge identifier"],
  user: ["--user-id <id>", "Local User identifier"],
  invitation: [
    "--invitation-fd <fd>",
    "Protected invitation JSON file descriptor"
  ],
  request: [
    "--request-fd <fd>",
    "Protected pairing request JSON file descriptor"
  ],
  statement: [
    "--statement-fd <fd>",
    "Protected signed transition JSON file descriptor"
  ],
  bundle: ["--key-bundle-fd <fd>", "Protected key bundle JSON file descriptor"],
  proof: ["--proof-fd <fd>", "Protected transition proof JSON file descriptor"],
  kit: ["--recovery-kit <path>", "Protected recovery kit file"],
  runtime: [
    "--runtime-secret-ref <reference>",
    "Runtime secret reference for bootstrap"
  ],
  passwordFd: [
    "--password-fd <fd>",
    "Read the recovery password from a protected file descriptor"
  ],
  passwordStdin: ["--password-stdin", "Read the recovery password from stdin"],
  linkFd: [
    "--link-fd <fd>",
    "Read the pairing link from a protected file descriptor"
  ],
  linkStdin: ["--link-stdin", "Read the pairing link from stdin"],
  label: ["--device-label <name>", "Device display name"],
  output: ["--output <path>", "Protected recovery kit output file"],
  payload: [
    "--payload-fd <fd>",
    "Protected recovery payload JSON file descriptor"
  ]
} as const;
type RecoveryOption = keyof typeof recoveryOptions;
const recoveryCommands: Array<{
  path: string;
  description: string;
  options: RecoveryOption[];
}> = [
  {
    path: "group bootstrap",
    description: "Create the initial Personal Sync group",
    options: ["kit", "runtime", "passwordFd", "passwordStdin"]
  },
  {
    path: "invite create",
    description: "Create a pairing invitation",
    options: ["group"]
  },
  {
    path: "join request",
    description: "Request enrollment for this device",
    options: ["group", "invitation"]
  },
  {
    path: "join redeem",
    description: "Redeem a pairing link through protected input",
    options: ["linkFd", "linkStdin", "label"]
  },
  {
    path: "join complete",
    description: "Complete approved device enrollment",
    options: ["group", "challenge"]
  },
  {
    path: "join bind-local-user",
    description: "Bind the enrolled runtime to a local User",
    options: ["group", "user", "challenge"]
  },
  {
    path: "join challenge",
    description: "Show redacted pending pairing request identifiers",
    options: []
  },
  {
    path: "active-device approve",
    description: "Approve a signed device request",
    options: ["request"]
  },
  {
    path: "active-device refresh",
    description: "Refresh this device to the current group epoch",
    options: []
  },
  {
    path: "device list",
    description: "List group devices",
    options: ["group"]
  },
  {
    path: "device revoke",
    description: "Submit a signed device revocation",
    options: ["group", "device", "statement", "bundle", "proof"]
  },
  {
    path: "policy enable",
    description: "Enable Personal Sync policy",
    options: ["group"]
  },
  {
    path: "policy pause",
    description: "Pause Personal Sync policy",
    options: ["group"]
  },
  {
    path: "policy resume",
    description: "Resume Personal Sync policy",
    options: ["group"]
  },
  {
    path: "replica status",
    description: "Inspect local replica status",
    options: ["group"]
  },
  {
    path: "retry",
    description: "Retry pending Personal Sync work",
    options: ["group"]
  },
  {
    path: "recovery approve",
    description: "Submit a signed recovery transition",
    options: ["group", "statement", "bundle", "proof"]
  },
  {
    path: "recovery guidance",
    description: "Show protected recovery guidance",
    options: []
  },
  {
    path: "recovery-kit create",
    description: "Encrypt a protected recovery kit",
    options: ["output", "payload", "passwordFd", "passwordStdin"]
  },
  {
    path: "recovery-kit verify",
    description: "Verify a protected recovery kit",
    options: ["kit", "passwordFd", "passwordStdin"]
  }
];

export const registerPersonalSyncCommands = (
  program: Command,
  dependencies: KoedServerCliDependencies,
  complete: (code: number) => void,
  advanced: boolean
): void => {
  const pair = program
    .command("pair")
    .description("Connect this device through Koed Desktop")
    .option("--device-label <name>", "Device display name")
    .option("--detach", "Return after creating the request")
    .option("--json", "Emit JSON progress records");
  const pairAction = async (
    operation: "status" | "cancel" | undefined,
    options: PairOptions
  ) => {
    const input = { ...pair.opts<PairOptions>(), ...options };
    complete(
      await withCliService(
        () => import("./cli-pair-operations.js"),
        (service) => service.runPairCommand(operation, input, dependencies),
        dependencies,
        input.json
      )
    );
  };
  pair.action(async (options: PairOptions) => pairAction(undefined, options));
  for (const operation of ["status", "cancel"] as const)
    pair
      .command(operation)
      .description(`${operation} the pending pairing request`)
      .option("--json", "Emit JSON output")
      .action(async (options: PairOptions) => pairAction(operation, options));
  const sync = program
    .command("personal-sync")
    .description("Inspect Personal Sync and recovery guidance")
    .option("--advanced", "Show advanced compatibility and recovery commands");
  sync.action(() => sync.outputHelp());
  sync.addHelpText(
    "after",
    "\nConnect this device with koed pair. Create your first group and manage devices in Electron → Devices.\n\nExamples:\n  koed personal-sync status --json\n  koed personal-sync --help --advanced"
  );
  const execute = (
    command: Command,
    path: string[],
    flags: readonly string[]
  ) => {
    command
      .option("--json", "Emit JSON output")
      .action(async (options: Record<string, unknown>) => {
        const args = [...path];
        for (const flag of flags) {
          const key = flag
            .slice(2)
            .replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
          const value = options[key];
          if (value === true) args.push(flag);
          else if (typeof value === "string") args.push(flag, value);
        }
        const stdout = dependencies.stdout ?? process.stdout;
        const stderr = dependencies.stderr ?? process.stderr;
        try {
          const operation =
            dependencies.runPersonalSync ??
            (await import("./personal-sync.js")).runPersonalSyncCommand;
          const result = await operation(
            args,
            (dependencies.resolvePaths ?? resolveKoedServerPaths)(),
            process.env
          );
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
  execute(
    sync
      .command("status")
      .description("Show redacted status for this local Personal installation"),
    ["status"],
    []
  );
  const groups = new Map<string, Command>();
  for (const entry of recoveryCommands) {
    const path = entry.path.split(" ");
    let parent = sync;
    if (path.length === 2) {
      const name = path[0]!;
      let group = groups.get(name);
      if (!group) {
        group = sync
          .command(name, { hidden: !advanced })
          .description(`Advanced ${name} operations`);
        group.action(() => group!.outputHelp());
        groups.set(name, group);
      }
      parent = group;
    }
    const command = parent
      .command(path.at(-1)!, { hidden: path.length === 1 && !advanced })
      .description(entry.description);
    const flags: string[] = [];
    for (const key of entry.options) {
      const [syntax, description] = recoveryOptions[key];
      if (key === "device") {
        // Existing Desktop callers supply this metadata. The signed statement
        // remains authoritative; the recovery routine does not use this flag.
        command.addOption(new Option(syntax, description).hideHelp());
      } else command.option(syntax, description);
      flags.push(syntax.split(" ")[0]!);
    }
    execute(command, path, flags);
  }
};
