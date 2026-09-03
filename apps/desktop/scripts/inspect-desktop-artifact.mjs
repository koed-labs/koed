#!/usr/bin/env node
/* global console, process */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildDesktopArtifactReport,
  evaluateDesktopArtifactPolicy
} from "./desktop-artifact-report-lib.mjs";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const appPath = value("--app");
if (!appPath) {
  throw new Error(
    "Usage: inspect-desktop-artifact --app <Koed.app> [--dmg <path>] [--zip <path>] [--policy <json> --baseline <json>] [--out <json>]"
  );
}
const report = buildDesktopArtifactReport({
  appPath: resolve(appPath),
  dmgPath: value("--dmg") ? resolve(value("--dmg")) : undefined,
  zipPath: value("--zip") ? resolve(value("--zip")) : undefined
});
const policyPath = value("--policy");
const baselinePath = value("--baseline");
const result =
  policyPath && baselinePath
    ? {
        ...report,
        policy: evaluateDesktopArtifactPolicy(
          report,
          JSON.parse(readFileSync(resolve(policyPath), "utf8")),
          JSON.parse(readFileSync(resolve(baselinePath), "utf8"))
        )
      }
    : report;
const output = `${JSON.stringify(result, null, 2)}\n`;
if (value("--out")) writeFileSync(resolve(value("--out")), output);
console.log(output.trimEnd());
if (result.policy && !result.policy.ok) process.exitCode = 1;
