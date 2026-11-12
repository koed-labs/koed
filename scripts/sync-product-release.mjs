#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncProductPackageVersions } from "./product-release-version-lib.mjs";
import { syncChangelogs } from "./product-changelog.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const releaseChangelogPath = path.join(
  root,
  "packages",
  "koed",
  "CHANGELOG.md"
);
const productChangelogPath = path.join(root, "CHANGELOG.md");
const serverChangelogPath = path.join(
  root,
  "packages",
  "koed-server",
  "CHANGELOG.md"
);
const desktopChangelogPath = path.join(root, "apps", "desktop", "CHANGELOG.md");
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

const changelogs = syncChangelogs({
  root: fs.readFileSync(productChangelogPath, "utf8"),
  desktop: fs.readFileSync(desktopChangelogPath, "utf8"),
  product: fs.readFileSync(releaseChangelogPath, "utf8"),
  server: fs.readFileSync(serverChangelogPath, "utf8"),
  version: synchronized.version
});
if (writeIfChanged(productChangelogPath, changelogs.root)) {
  console.log("Synced root CHANGELOG.md from release changelogs");
}
if (writeIfChanged(desktopChangelogPath, changelogs.desktop)) {
  console.log("Synced Desktop CHANGELOG.md release heading");
}

if (consumeChangesets && fs.existsSync(changesetDir)) {
  for (const entry of fs.readdirSync(changesetDir)) {
    if (!entry.endsWith(".md") || entry === "README.md") {
      continue;
    }

    const changesetPath = path.join(changesetDir, entry);
    const changeset = fs.readFileSync(changesetPath, "utf8");
    if (changeset.includes('"@koed-labs/koed"')) {
      fs.unlinkSync(changesetPath);
      console.log(`Removed consumed product changeset ${entry}`);
    }
  }
}
