export type ExperienceReplayCommand =
  | {
      name: "preflight" | "run";
      configPath: string;
      confirmPaidRun: boolean;
      productPathProof: boolean;
      oracleSeededProof: boolean;
      oracleRepeatedStudy: boolean;
      oracleBriefPath: string | null;
      oracleCorpusPath: string | null;
      oracleRepeats: number | null;
      codexSubscription: boolean;
    }
  | { name: "resume" | "report" | "sanitize"; runDirectory: string };

const usage =
  "Usage: experience-replay <preflight|run> --config <file> [--confirm-paid-run] [--product-path-proof | --oracle-seeded-proof --oracle-brief <file> --oracle-corpus <absolute-dir> | --oracle-repeated-study --oracle-corpus <absolute-dir> [--oracle-repeats <1..100>]] [--codex-subscription] | <resume|report|sanitize> --run <dir>";

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
  let oracleRepeatedStudy = false;
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
    if (argument === "--oracle-repeated-study") {
      if (oracleRepeatedStudy)
        throw new CommandLineError("Duplicate --oracle-repeated-study");
      oracleRepeatedStudy = true;
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
      argument !== "--oracle-brief" &&
      argument !== "--oracle-corpus" &&
      argument !== "--oracle-repeats"
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
    if (
      [productPathProof, oracleSeededProof, oracleRepeatedStudy].filter(Boolean)
        .length > 1
    ) {
      throw new CommandLineError(
        "Product-path proof modes are mutually exclusive"
      );
    }
    const oracleBriefPath = values.get("--oracle-brief") ?? null;
    if (oracleSeededProof !== Boolean(oracleBriefPath)) {
      throw new CommandLineError(
        "--oracle-seeded-proof requires exactly one --oracle-brief <file>"
      );
    }
    const oracleCorpusPath = values.get("--oracle-corpus") ?? null;
    if (
      (oracleSeededProof || oracleRepeatedStudy) !== Boolean(oracleCorpusPath)
    ) {
      throw new CommandLineError(
        "Oracle proof and repeated study modes require exactly one --oracle-corpus <absolute-dir>"
      );
    }
    const oracleRepeatsValue = values.get("--oracle-repeats") ?? null;
    if (oracleRepeatsValue !== null && !oracleRepeatedStudy) {
      throw new CommandLineError(
        "--oracle-repeats is valid only with --oracle-repeated-study"
      );
    }
    const oracleRepeats =
      oracleRepeatsValue === null ? null : Number(oracleRepeatsValue);
    if (
      oracleRepeats !== null &&
      (!Number.isSafeInteger(oracleRepeats) ||
        oracleRepeats < 1 ||
        oracleRepeats > 100)
    ) {
      throw new CommandLineError(
        "--oracle-repeats must be an integer from 1 to 100"
      );
    }
    return {
      name: commandName,
      configPath,
      confirmPaidRun,
      productPathProof,
      oracleSeededProof,
      oracleRepeatedStudy,
      oracleBriefPath,
      oracleCorpusPath,
      oracleRepeats,
      codexSubscription
    };
  }
  if (
    values.has("--config") ||
    confirmPaidRun ||
    productPathProof ||
    oracleSeededProof ||
    oracleRepeatedStudy ||
    values.has("--oracle-brief") ||
    values.has("--oracle-corpus") ||
    values.has("--oracle-repeats") ||
    codexSubscription
  ) {
    throw new CommandLineError(`${commandName} accepts only --run <dir>`);
  }
  const runDirectory = values.get("--run");
  if (!runDirectory)
    throw new CommandLineError(`${commandName} requires --run`);
  return { name: commandName, runDirectory };
};
