#!/usr/bin/env node
import {
  defaultMultiDeviceProfileRoot,
  prepareMultiDeviceProfiles
} from "./multi-device-profile-lib.mjs";

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

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(`Usage: pnpm multi-device:prepare [options]

Creates two disposable, isolated Koed/Codex/Electron test profiles. It does not
start services, enroll devices, or write credentials to its redacted manifest.

Options:
  --root <path>  Disposable koed-multi-device-* directory under the OS temp dir.
  --reset        Replace an existing disposable root.
`);
  process.exit(0);
}

try {
  const result = prepareMultiDeviceProfiles({
    root: valueFor("--root") ?? defaultMultiDeviceProfileRoot(),
    reset: args.includes("--reset")
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
