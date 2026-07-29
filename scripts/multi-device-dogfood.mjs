#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runMultiDeviceElectronDogfood } from "./multi-device-dogfood-lib.mjs";

const args = process.argv.slice(2);
const valueFor = (flag) => {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
};
const integerFor = (flag, fallback) => {
  const value = valueFor(flag);
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
};

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(`Usage: pnpm multi-device:validate [options]

Validates two running Koed Electron devices through their isolated Chrome
DevTools Protocol ports. Both devices must already be enrolled against the same
remote backend and launched with --remote-debugging-port.

Options:
  --device-a-cdp-port <port>  Device A Electron CDP port. Default: 9224
  --device-b-cdp-port <port>  Device B Electron CDP port. Default: 9225
  --backend-id <id>           Expected active upstream backend id.
  --timeout-ms <ms>           Per-event timeout. Default: 15000
  --report <path>             Also write the JSON report to this path.
`);
  process.exit(0);
}

try {
  const report = await runMultiDeviceElectronDogfood({
    deviceAPort: integerFor("--device-a-cdp-port", 9224),
    deviceBPort: integerFor("--device-b-cdp-port", 9225),
    expectedBackendId: valueFor("--backend-id") ?? undefined,
    timeoutMs: integerFor("--timeout-ms", 15_000)
  });
  const output = `${JSON.stringify(report, null, 2)}\n`;
  const reportPath = valueFor("--report");
  if (reportPath) await writeFile(resolve(reportPath), output, "utf8");
  process.stdout.write(output);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (error?.diagnostics) {
    console.error(JSON.stringify(error.diagnostics, null, 2));
  }
  process.exitCode = 1;
}
