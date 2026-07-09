import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function main(): Promise<void> {
  const [argvMode, entryPath, ...args] = process.argv.slice(2);
  if (argvMode !== "node-script") {
    throw new Error(
      `Unsupported node entrypoint argv mode: ${argvMode ?? "<missing>"}`
    );
  }
  if (!entryPath) {
    throw new Error("Missing node entrypoint path.");
  }

  process.argv = [process.argv[0] ?? "node", entryPath, ...args];
  await import(pathToFileURL(entryPath).href);
}

export const isCurrentEntrypoint = (
  metaUrl: string,
  argvPath: string | undefined
): boolean => {
  if (!argvPath) {
    return false;
  }
  const normalize = (path: string) => {
    const resolved = resolve(path);
    try {
      return realpathSync.native(resolved);
    } catch {
      return resolved;
    }
  };
  return normalize(fileURLToPath(metaUrl)) === normalize(argvPath);
};

if (
  process.argv[2] === "node-script" ||
  isCurrentEntrypoint(import.meta.url, process.argv[1])
) {
  void main().catch((error) => {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
