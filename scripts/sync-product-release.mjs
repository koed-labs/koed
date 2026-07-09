#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootPackagePath = path.join(root, "package.json");
const releasePackagePath = path.join(root, "packages", "koed", "package.json");
const syncedPackagePaths = [
  ["root package", rootPackagePath],
  [
    "koed-server package",
    path.join(root, "packages", "koed-server", "package.json")
  ],
  ["Desktop package", path.join(root, "apps", "desktop", "package.json")]
];
const releaseChangelogPath = path.join(
  root,
  "packages",
  "koed",
  "CHANGELOG.md"
);
const productChangelogPath = path.join(root, "CHANGELOG.md");
const changesetDir = path.join(root, ".changeset");
const consumeChangesets = process.argv.includes("--consume-changesets");

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));

const writeJson = (filePath, value) => {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
};

const writeIfChanged = (filePath, value) => {
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8") === value) {
    return false;
  }
  fs.writeFileSync(filePath, value);
  return true;
};

const releasePackage = readJson(releasePackagePath);

for (const [label, packagePath] of syncedPackagePaths) {
  const packageJson = readJson(packagePath);
  if (packageJson.version !== releasePackage.version) {
    packageJson.version = releasePackage.version;
    writeJson(packagePath, packageJson);
    console.log(`Synced ${label} version to ${releasePackage.version}`);
  }
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
