export type ExperienceReplayCommand =
  | {
      name: "preflight" | "run";
      configPath: string;
      confirmPaidRun: boolean;
      productPathProof: boolean;
      oracleSeededProof: boolean;
      oracleBriefPath: string | null;
      codexSubscription: boolean;
    }
  | { name: "resume" | "report" | "sanitize"; runDirectory: string };

const usage =
  "Usage: experience-replay <preflight|run> --config <file> [--confirm-paid-run] [--product-path-proof | --oracle-seeded-proof --oracle-brief <file>] [--codex-subscription] | <resume|report|sanitize> --run <dir>";

export class CommandLineError extends Error {
  override readonly name = "CommandLineError";
}

export const parseExperienceReplayCommand = (
  argv: readonly string[]
): ExperienceReplayCommand => {
  const normalized = argv[0] === "--" ? argv.slice(1) : argv;
  const [name, ...arguments_] = normalized;
  if (
    !name ||
    !["preflight", "run", "resume", "report", "sanitize"].includes(name)
  ) {
    throw new CommandLineError(usage);
  }
  const commandName = name as ExperienceReplayCommand["name"];
  const values = new Map<string, string>();
  let confirmPaidRun = false;
  let productPathProof = false;
  let oracleSeededProof = false;
  let codexSubscription = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index] as string;
    if (argument === "--confirm-paid-run") {
      if (confirmPaidRun)
        throw new CommandLineError("Duplicate --confirm-paid-run");
      confirmPaidRun = true;
      continue;
    }
    if (argument === "--product-path-proof") {
      if (productPathProof)
        throw new CommandLineError("Duplicate --product-path-proof");
      productPathProof = true;
      continue;
    }
    if (argument === "--oracle-seeded-proof") {
      if (oracleSeededProof)
        throw new CommandLineError("Duplicate --oracle-seeded-proof");
      oracleSeededProof = true;
      continue;
    }
    if (argument === "--codex-subscription") {
      if (codexSubscription)
        throw new CommandLineError("Duplicate --codex-subscription");
      codexSubscription = true;
      continue;
    }
    if (
      argument !== "--config" &&
      argument !== "--run" &&
      argument !== "--oracle-brief"
    ) {
      throw new CommandLineError(`Unknown argument: ${argument}\n${usage}`);
    }
    if (values.has(argument))
      throw new CommandLineError(`Duplicate ${argument}`);
    const value = arguments_[index + 1];
    if (!value || value.startsWith("--")) {
      throw new CommandLineError(`${argument} requires a value`);
    }
    values.set(argument, value);
    index += 1;
  }
  if (commandName === "preflight" || commandName === "run") {
    if (values.has("--run"))
      throw new CommandLineError(`${commandName} does not accept --run`);
    const configPath = values.get("--config");
    if (!configPath)
      throw new CommandLineError(`${commandName} requires --config`);
    if (productPathProof && oracleSeededProof) {
      throw new CommandLineError(
        "--product-path-proof and --oracle-seeded-proof are mutually exclusive"
      );
    }
    const oracleBriefPath = values.get("--oracle-brief") ?? null;
    if (oracleSeededProof !== Boolean(oracleBriefPath)) {
      throw new CommandLineError(
        "--oracle-seeded-proof requires exactly one --oracle-brief <file>"
      );
    }
    return {
      name: commandName,
      configPath,
      confirmPaidRun,
      productPathProof,
      oracleSeededProof,
      oracleBriefPath,
      codexSubscription
    };
  }
  if (
    values.has("--config") ||
    confirmPaidRun ||
    productPathProof ||
    oracleSeededProof ||
    values.has("--oracle-brief") ||
    codexSubscription
  ) {
    throw new CommandLineError(`${commandName} accepts only --run <dir>`);
  }
  const runDirectory = values.get("--run");
  if (!runDirectory)
    throw new CommandLineError(`${commandName} requires --run`);
  return { name: commandName, runDirectory };
};
