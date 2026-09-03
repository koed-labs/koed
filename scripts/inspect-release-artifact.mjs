#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  evaluateArtifactPolicy,
  formatArtifactReport,
  inspectArchive,
  inspectTree
} from "./release-artifact-inspector-lib.mjs";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const path = value("--path");
const platform = value("--platform");
const architecture = value("--arch");
if (!path || !platform || !architecture) {
  throw new Error(
    "Usage: inspect-release-artifact --path <tree> --platform <platform> --arch <architecture> [--policy <json>] [--baseline <json>] [--out <json>] [--json]"
  );
}
const inspect = path.endsWith(".tar.gz") ? inspectArchive : inspectTree;
const report = await inspect({ path, platform, architecture });
const policyPath = value("--policy");
const baselinePath = value("--baseline");
const result = policyPath
  ? {
      ...report,
      policy: evaluateArtifactPolicy(
        report,
        JSON.parse(readFileSync(resolve(policyPath), "utf8")),
        baselinePath
          ? JSON.parse(readFileSync(resolve(baselinePath), "utf8"))
          : null
      )
    }
  : report;
const output = `${JSON.stringify(result, null, 2)}\n`;
const out = value("--out");
if (out) writeFileSync(resolve(out), output);
console.log(
  args.includes("--json") ? output.trimEnd() : formatArtifactReport(report)
);
if (result.policy && !result.policy.ok) process.exitCode = 1;
