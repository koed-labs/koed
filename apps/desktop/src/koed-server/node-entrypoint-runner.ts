import { pathToFileURL } from "node:url";

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

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error) => {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
