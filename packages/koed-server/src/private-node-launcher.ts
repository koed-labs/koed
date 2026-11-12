import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const wrapperMarker = "#!/bin/sh\n# Koed private Node:";
const maximumWrapperBytes = 4096;

// Reverses Python's shlex.quote, which the installer uses to write the wrapper.
const shellWord = (word: string): string | null => {
  if (/^[\w@%+=:,./-]+$/.test(word)) return word;
  const quoted = /^'((?:[^']|'"'"')*)'$/.exec(word);
  return quoted ? quoted[1]!.replaceAll(`'"'"'`, "'") : null;
};

const realPath = (path: string): string | null => {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
};

/**
 * Returns the executable a Node child process should launch.
 *
 * On Linux, the installer's private Node keeps its real binary at
 * `bin/node.bin` behind a `bin/node` wrapper that points the loader at the
 * bundled libatomic. `process.execPath` names `node.bin`, so a child launched
 * with a restricted environment would lose that library path and fail to
 * start. Use the wrapper only when it is the installer's own regular file and
 * runs this same binary; otherwise return `execPath` unchanged.
 */
export const privateNodeLauncher = (
  execPath: string = process.execPath
): string => {
  if (basename(execPath) !== "node.bin") return execPath;
  const wrapper = join(dirname(execPath), "node");
  try {
    const stat = lstatSync(wrapper);
    if (!stat.isFile() || stat.size > maximumWrapperBytes) return execPath;
    const lines = readFileSync(wrapper, "utf8").split("\n");
    if (!lines.slice(0, 2).join("\n").startsWith(wrapperMarker))
      return execPath;
    const exec = lines
      .map((line) => /^exec (.+) "\$@"$/.exec(line))
      .find((match) => match !== null);
    const target = exec ? shellWord(exec[1]!) : null;
    const binary = realPath(execPath);
    if (!target || !binary || realPath(target) !== binary) return execPath;
    return wrapper;
  } catch {
    return execPath;
  }
};
