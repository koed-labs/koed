import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";

export interface ShellPathMutation {
  rcPath: string;
  shell: "zsh" | "bash";
  operation: "add" | "remove";
  consent: boolean;
  launcherDirectory: string;
}

const begin = "# >>> koed managed PATH >>>";
const end = "# <<< koed managed PATH <<<";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const escapeShell = (value: string) => value.replace(/[\\\\"$`]/gu, "\\$&");

export const updateManagedPathBlock = async (
  input: ShellPathMutation
): Promise<void> => {
  if (!input.consent)
    throw new Error("PATH changes require separate explicit consent.");
  if (
    [...input.launcherDirectory].some(
      (character) =>
        character.codePointAt(0)! < 0x20 || character.codePointAt(0) === 0x7f
    )
  ) {
    throw new Error(
      "Launcher directory contains unsupported control characters."
    );
  }
  let stat;
  try {
    stat = lstatSync(input.rcPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (stat?.isSymbolicLink() || (stat && !stat.isFile()))
    throw new Error("Shell rc path must be a regular file, not a symlink.");
  const original = stat ? readFileSync(input.rcPath, "utf8") : "";
  const blockPattern =
    /^# >>> koed managed PATH >>>\n[\s\S]*?^# <<< koed managed PATH <<<\n?/mu;
  const existing = blockPattern.exec(original);
  const outside = original.replace(blockPattern, "");
  let updated: string;
  if (input.operation === "add") {
    if (existing && !existing[0].includes(escapeShell(input.launcherDirectory)))
      throw new Error("Koed PATH block was edited; resolve conflict manually.");
    if (existing) return;
    const line = `export PATH="$PATH:${escapeShell(input.launcherDirectory)}"`;
    updated = `${outside}${outside.endsWith("\n") || outside.length === 0 ? "" : "\n"}${begin}\n${line}\n${end}\n`;
  } else {
    if (!existing) return;
    if (!existing[0].includes(escapeShell(input.launcherDirectory)))
      throw new Error("Koed PATH block was edited; refusing removal.");
    updated = outside;
  }
  if (stat && hash(readFileSync(input.rcPath, "utf8")) !== hash(original))
    throw new Error("Shell rc changed during inspection; retry.");
  const temporary = `${input.rcPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, updated, {
      mode: stat?.mode ?? 0o600,
      flag: "wx"
    });
    renameSync(temporary, input.rcPath);
  } finally {
    rmSync(temporary, { force: true });
  }
};
