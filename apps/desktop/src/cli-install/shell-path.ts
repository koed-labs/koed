import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
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

interface RcSnapshot {
  contents: string;
  dev: number;
  ino: number;
  mode: number;
}

const readRc = (path: string): RcSnapshot | null => {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile())
      throw new Error("Shell rc path must be a regular file, not a symlink.");
    return {
      contents: readFileSync(descriptor, "utf8"),
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP")
      throw new Error("Shell rc path must be a regular file, not a symlink.");
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
};

const buildUpdatedContent = (
  original: string,
  operation: ShellPathMutation["operation"],
  directory: string
): string | null => {
  const beginCount = original.split(begin).length - 1;
  const endCount = original.split(end).length - 1;
  const exactBeginLines =
    original.match(/^# >>> koed managed PATH >>>$/gmu) ?? [];
  const exactEndLines =
    original.match(/^# <<< koed managed PATH <<<$\n?/gmu) ?? [];
  if (
    beginCount !== endCount ||
    beginCount > 1 ||
    exactBeginLines.length !== beginCount ||
    exactEndLines.length !== endCount
  ) {
    throw new Error(
      "Koed PATH markers are duplicated or incomplete; resolve conflict manually."
    );
  }
  const generated = `${begin}\nexport PATH="$PATH:${escapeShell(directory)}"\n${end}\n`;
  if (beginCount === 1) {
    const start = original.indexOf(`${begin}\n`);
    const ending = original.indexOf(end, start);
    const after = ending + end.length;
    const block = original.slice(
      start,
      after + (original[after] === "\n" ? 1 : 0)
    );
    if (block !== generated)
      throw new Error("Koed PATH block was edited; resolve conflict manually.");
    if (operation === "add") return null;
    return original.slice(0, start) + original.slice(start + block.length);
  }
  if (operation === "remove") return null;
  return `${original}${original.endsWith("\n") || original.length === 0 ? "" : "\n"}${generated}`;
};

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
  const before = readRc(input.rcPath);
  const original = before?.contents ?? "";
  const updated = buildUpdatedContent(
    original,
    input.operation,
    input.launcherDirectory
  );
  if (updated === null || updated === original) return;
  const temporary = `${input.rcPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, updated, {
      mode: before?.mode ?? 0o600,
      flag: "wx"
    });
    const current = readRc(input.rcPath);
    if (!before) {
      if (current)
        throw new Error("Shell rc appeared during inspection; retry.");
      try {
        writeFileSync(input.rcPath, updated, { mode: 0o600, flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new Error("Shell rc appeared during inspection; retry.", {
            cause: error
          });
        throw error;
      }
      return;
    }
    if (
      !current ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      hash(current.contents) !== hash(before.contents)
    ) {
      throw new Error("Shell rc changed during inspection; retry.");
    }
    renameSync(temporary, input.rcPath);
  } finally {
    rmSync(temporary, { force: true });
  }
};
