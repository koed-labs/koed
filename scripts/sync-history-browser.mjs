#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "apps", "history-browser", "koed-history-browser");
const repo =
  process.env.HISTORY_BROWSER_REPO ??
  "https://github.com/koed-labs/koed-history-browser.git";
const ref = process.env.HISTORY_BROWSER_REF ?? "main";
const token = process.env.HISTORY_BROWSER_GITHUB_TOKEN ?? "";

const skipSync = process.env.HISTORY_BROWSER_SKIP_SYNC === "1";

const gitAuthArgs = token
  ? [
      "-c",
      `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(
        `x-access-token:${token}`
      ).toString("base64")}`
    ]
  : [];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    stdio: "inherit"
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (skipSync) {
  if (!fs.existsSync(target)) {
    console.error(
      "History browser sync is disabled, but apps/history-browser/koed-history-browser is missing."
    );
    process.exit(1);
  }
  console.log("History browser sync skipped.");
  process.exit(0);
}

if (fs.existsSync(target) && !fs.existsSync(path.join(target, ".git"))) {
  console.error(
    "apps/history-browser/koed-history-browser exists but is not a Git checkout."
  );
  process.exit(1);
}

if (!fs.existsSync(target)) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  run("git", [...gitAuthArgs, "clone", "--depth", "1", repo, target]);
}

run("git", [...gitAuthArgs, "fetch", "--depth", "1", "origin", ref], {
  cwd: target
});
run("git", ["checkout", "--detach", "FETCH_HEAD"], { cwd: target });
