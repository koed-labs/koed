#!/usr/bin/env node
import { resolve } from "node:path";
import {
  checkSourceRuntime,
  prepareSourceRuntime,
  releaseSourceRuntimeLease
} from "./source-runtime-build-lib.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const mode = process.argv[2];
const startedAt = Date.now();
const leasePidIndex = process.argv.indexOf("--lease-pid");
const leasePid =
  leasePidIndex >= 0
    ? Number.parseInt(process.argv[leasePidIndex + 1] ?? "", 10)
    : undefined;

if (leasePid !== undefined && (!Number.isInteger(leasePid) || leasePid <= 0)) {
  console.error("--lease-pid requires a positive process ID.");
  process.exit(1);
}

try {
  let result;
  if (mode === "prepare") {
    result = await prepareSourceRuntime(repoRoot);
  } else if (mode === "check") {
    result = await checkSourceRuntime(repoRoot, { leasePid });
  } else if (mode === "release-lease" && leasePid !== undefined) {
    result = {
      state: (await releaseSourceRuntimeLease(repoRoot, leasePid))
        ? "released"
        : "not_owned"
    };
  } else {
    throw new Error(
      "Usage: source-runtime-build.mjs <prepare|check|release-lease> [--lease-pid PID]"
    );
  }
  console.log(
    JSON.stringify({
      ok: true,
      state: result.state,
      ...(result.calculated?.fingerprint
        ? { fingerprint: result.calculated.fingerprint }
        : {}),
      durationMs: Date.now() - startedAt
    })
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
