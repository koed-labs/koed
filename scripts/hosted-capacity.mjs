#!/usr/bin/env node
import {
  formatCapacityPlan,
  formatCapacityReport,
  hostedCapacityUsage,
  parseHostedCapacityArgs,
  runHostedCapacity
} from "./hosted-capacity-lib.mjs";
import { loadRootEnv } from "./api-token-bootstrap-lib.mjs";

loadRootEnv(process.cwd(), process.env);

let options;
try {
  options = parseHostedCapacityArgs(process.argv.slice(2), process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

if (options.command === "help") {
  process.stdout.write(hostedCapacityUsage());
  process.exit(0);
}

if (options.command === "plan") {
  process.stdout.write(formatCapacityPlan());
  process.exit(0);
}

try {
  const result = await runHostedCapacity({ options });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(formatCapacityReport(result));
  }
  if (result.failures.length) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
