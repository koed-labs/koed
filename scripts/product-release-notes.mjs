#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const changelogPath = path.join(root, "CHANGELOG.md");

if (!fs.existsSync(changelogPath)) {
  console.error(
    "CHANGELOG.md does not exist. Run `pnpm release:version` first."
  );
  process.exit(1);
}

const changelog = fs.readFileSync(changelogPath, "utf8");
const sections = [...changelog.matchAll(/^##\s+/gm)];

if (sections.length === 0) {
  console.error("CHANGELOG.md does not contain a release section.");
  process.exit(1);
}

const start = sections[0].index;
const end = sections[1]?.index ?? changelog.length;
const notes = changelog.slice(start, end).trim();

if (!notes) {
  console.error("Could not extract release notes from CHANGELOG.md.");
  process.exit(1);
}

process.stdout.write(`${notes}\n`);
