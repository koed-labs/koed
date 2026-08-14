export type ExperienceReplayCommand =
  | {
      name: "preflight" | "run";
      configPath: string;
      confirmPaidRun: boolean;
      productPathProof: boolean;
      oracleSeededProof: boolean;
      oracleRepeatedStudy: boolean;
      oracleCampaign: boolean;
      oracleCorpusQualification: boolean;
      oracleBriefPath: string | null;
      oracleCorpusPath: string | null;
      oracleCampaignManifestPath: string | null;
      oracleQualificationManifestPath: string | null;
      oracleRepeats: number | null;
      codexSubscription: boolean;
    }
  | {
      name: "campaign-merge";
      manifestPath: string;
      outputDirectory: string;
    }
  | { name: "resume" | "report" | "sanitize"; runDirectory: string };

const usage =
  "Usage: experience-replay <preflight|run> --config <file> [--confirm-paid-run] [--product-path-proof | --oracle-seeded-proof --oracle-brief <file> --oracle-corpus <absolute-dir> | --oracle-repeated-study --oracle-corpus <absolute-dir> [--oracle-repeats <1..100>] | --oracle-qualify --oracle-qualification-manifest <absolute-file> --oracle-corpus <absolute-collection-dir> | --oracle-campaign --oracle-campaign-manifest <absolute-file> --oracle-corpus <absolute-collection-dir>] [--codex-subscription] | campaign-merge --merge-manifest <file> --output <dir> | <resume|report|sanitize> --run <dir>";

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
    ![
      "preflight",
      "run",
      "campaign-merge",
      "resume",
      "report",
      "sanitize"
    ].includes(name)
  ) {
    throw new CommandLineError(usage);
  }
  const commandName = name as ExperienceReplayCommand["name"];
  const values = new Map<string, string>();
  let confirmPaidRun = false;
  let productPathProof = false;
  let oracleSeededProof = false;
  let oracleRepeatedStudy = false;
  let oracleCampaign = false;
  let oracleCorpusQualification = false;
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
    if (argument === "--oracle-campaign") {
      if (oracleCampaign)
        throw new CommandLineError("Duplicate --oracle-campaign");
      oracleCampaign = true;
      continue;
    }
    if (argument === "--oracle-qualify") {
      if (oracleCorpusQualification)
        throw new CommandLineError("Duplicate --oracle-qualify");
      oracleCorpusQualification = true;
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
      argument !== "--oracle-campaign-manifest" &&
      argument !== "--oracle-qualification-manifest" &&
      argument !== "--oracle-repeats" &&
      argument !== "--merge-manifest" &&
      argument !== "--output"
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
  if (commandName === "campaign-merge") {
    if (
      values.has("--config") ||
      values.has("--run") ||
      values.has("--oracle-brief") ||
      values.has("--oracle-corpus") ||
      values.has("--oracle-campaign-manifest") ||
      values.has("--oracle-qualification-manifest") ||
      values.has("--oracle-repeats") ||
      confirmPaidRun ||
      productPathProof ||
      oracleSeededProof ||
      oracleRepeatedStudy ||
      oracleCampaign ||
      oracleCorpusQualification ||
      codexSubscription
    ) {
      throw new CommandLineError(
        "campaign-merge accepts only --merge-manifest <file> --output <dir>"
      );
    }
    const manifestPath = values.get("--merge-manifest");
    const outputDirectory = values.get("--output");
    if (!manifestPath || !outputDirectory)
      throw new CommandLineError(
        "campaign-merge requires --merge-manifest <file> and --output <dir>"
      );
    return { name: "campaign-merge", manifestPath, outputDirectory };
  }
  if (commandName === "preflight" || commandName === "run") {
    if (
      values.has("--run") ||
      values.has("--merge-manifest") ||
      values.has("--output")
    )
      throw new CommandLineError(
        `${commandName} received incompatible arguments`
      );
    const configPath = values.get("--config");
    if (!configPath)
      throw new CommandLineError(`${commandName} requires --config`);
    if (
      [
        productPathProof,
        oracleSeededProof,
        oracleRepeatedStudy,
        oracleCampaign,
        oracleCorpusQualification
      ].filter(Boolean).length > 1
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
      (oracleSeededProof ||
        oracleRepeatedStudy ||
        oracleCampaign ||
        oracleCorpusQualification) !== Boolean(oracleCorpusPath)
    ) {
      throw new CommandLineError(
        "Oracle modes require exactly one --oracle-corpus <absolute-dir>"
      );
    }
    const oracleCampaignManifestPath =
      values.get("--oracle-campaign-manifest") ?? null;
    if (oracleCampaign !== Boolean(oracleCampaignManifestPath)) {
      throw new CommandLineError(
        "--oracle-campaign requires exactly one --oracle-campaign-manifest <absolute-file>"
      );
    }
    const oracleQualificationManifestPath =
      values.get("--oracle-qualification-manifest") ?? null;
    if (
      oracleCorpusQualification !== Boolean(oracleQualificationManifestPath)
    ) {
      throw new CommandLineError(
        "--oracle-qualify requires exactly one --oracle-qualification-manifest <absolute-file>"
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
      oracleCampaign,
      oracleCorpusQualification,
      oracleBriefPath,
      oracleCorpusPath,
      oracleCampaignManifestPath,
      oracleQualificationManifestPath,
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
    oracleCampaign ||
    oracleCorpusQualification ||
    values.has("--oracle-brief") ||
    values.has("--oracle-corpus") ||
    values.has("--oracle-campaign-manifest") ||
    values.has("--oracle-qualification-manifest") ||
    values.has("--oracle-repeats") ||
    values.has("--merge-manifest") ||
    values.has("--output") ||
    codexSubscription
  ) {
    throw new CommandLineError(`${commandName} accepts only --run <dir>`);
  }
  const runDirectory = values.get("--run");
  if (!runDirectory)
    throw new CommandLineError(`${commandName} requires --run`);
  return { name: commandName, runDirectory };
};
