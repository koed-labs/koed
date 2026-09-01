#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncProductPackageVersions } from "./product-release-version-lib.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const releaseChangelogPath = path.join(
  root,
  "packages",
  "koed",
  "CHANGELOG.md"
);
const productChangelogPath = path.join(root, "CHANGELOG.md");
const changesetDir = path.join(root, ".changeset");
const consumeChangesets = process.argv.includes("--consume-changesets");

const writeIfChanged = (filePath, value) => {
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8") === value) {
    return false;
  }
  fs.writeFileSync(filePath, value);
  return true;
};

const synchronized = syncProductPackageVersions(root);
for (const { label } of synchronized.changed) {
  console.log(`Synced ${label} version to ${synchronized.version}`);
}

if (fs.existsSync(releaseChangelogPath)) {
  const releaseChangelog = fs.readFileSync(releaseChangelogPath, "utf8");
  const productChangelog = releaseChangelog.replace(/^# .+$/m, "# Koed");
  if (writeIfChanged(productChangelogPath, productChangelog)) {
    console.log("Synced root CHANGELOG.md from the product release changelog");
  }
}

if (consumeChangesets && fs.existsSync(changesetDir)) {
  for (const entry of fs.readdirSync(changesetDir)) {
    if (!entry.endsWith(".md") || entry === "README.md") {
      continue;
    }

    const changesetPath = path.join(changesetDir, entry);
    const changeset = fs.readFileSync(changesetPath, "utf8");
    if (changeset.includes('"@koed/koed"')) {
      fs.unlinkSync(changesetPath);
      console.log(`Removed consumed product changeset ${entry}`);
    }
  }
}
