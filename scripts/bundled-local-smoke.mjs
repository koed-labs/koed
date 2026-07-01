#!/usr/bin/env node
import {
  bundledLocalSmokeUsage,
  parseBundledLocalSmokeArgs,
  renderBundledLocalSmokeResult,
  runBundledLocalSmoke
} from "./bundled-local-smoke-lib.mjs";

try {
  const options = parseBundledLocalSmokeArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(bundledLocalSmokeUsage);
    process.exitCode = 0;
  } else {
    const result = await runBundledLocalSmoke(options);
    if (options.json || !result.ok) {
      process.stdout.write(renderBundledLocalSmokeResult(result));
    } else {
      process.stdout.write("Bundled-local smoke passed.\n");
    }
    process.exitCode = result.ok ? 0 : 1;
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
}
