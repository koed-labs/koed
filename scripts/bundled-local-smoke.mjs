#!/usr/bin/env node
import {
  bundledLocalSmokeUsage,
  parseBundledLocalSmokeArgs,
  renderBundledLocalSmokeResult,
  runBundledLocalSmoke
} from "./bundled-local-smoke-lib.mjs";

const write = (stream, text) =>
  new Promise((resolve) => {
    stream.write(text, () => resolve());
  });

let exitCode = 0;
try {
  const options = parseBundledLocalSmokeArgs(process.argv.slice(2));
  if (options.help) {
    await write(process.stdout, bundledLocalSmokeUsage);
  } else {
    const result = await runBundledLocalSmoke(options);
    if (options.json || !result.ok) {
      await write(process.stdout, renderBundledLocalSmokeResult(result));
    } else {
      await write(process.stdout, "Bundled-local smoke passed.\n");
    }
    exitCode = result.ok ? 0 : 1;
  }
} catch (error) {
  await write(
    process.stderr,
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  exitCode = 1;
}

process.exit(exitCode);
