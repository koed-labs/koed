export type ExperienceReplayCommand =
  | { name: "preflight" | "run"; configPath: string; confirmPaidRun: boolean }
  | { name: "resume" | "report" | "sanitize"; runDirectory: string };

const usage =
  "Usage: experience-replay <preflight|run> --config <file> [--confirm-paid-run] | <resume|report|sanitize> --run <dir>";

export class CommandLineError extends Error {
  override readonly name = "CommandLineError";
}

export const parseExperienceReplayCommand = (
  argv: readonly string[]
): ExperienceReplayCommand => {
  const [name, ...arguments_] = argv;
  if (
    !name ||
    !["preflight", "run", "resume", "report", "sanitize"].includes(name)
  ) {
    throw new CommandLineError(usage);
  }
  const commandName = name as ExperienceReplayCommand["name"];
  const values = new Map<string, string>();
  let confirmPaidRun = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index] as string;
    if (argument === "--confirm-paid-run") {
      if (confirmPaidRun)
        throw new CommandLineError("Duplicate --confirm-paid-run");
      confirmPaidRun = true;
      continue;
    }
    if (argument !== "--config" && argument !== "--run") {
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
    return { name: commandName, configPath, confirmPaidRun };
  }
  if (values.has("--config") || confirmPaidRun) {
    throw new CommandLineError(`${commandName} accepts only --run <dir>`);
  }
  const runDirectory = values.get("--run");
  if (!runDirectory)
    throw new CommandLineError(`${commandName} requires --run`);
  return { name: commandName, runDirectory };
};
