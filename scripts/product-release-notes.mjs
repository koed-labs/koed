#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const changelogPath = path.join(root, "CHANGELOG.md");

export const extractReleaseNotes = (changelog, version) => {
  const sections = [...changelog.matchAll(/^##\s+(.+)\s*$/gm)];
  if (sections.length === 0)
    throw new Error("CHANGELOG.md does not contain a release section.");
  const selected = version
    ? sections.find((section) => section[1].trim() === version)
    : sections[0];
  if (!selected)
    throw new Error(`CHANGELOG.md has no release section for ${version}.`);
  const next = sections.find((section) => section.index > selected.index);
  const notes = changelog
    .slice(selected.index, next?.index ?? changelog.length)
    .trim();
  if (!notes)
    throw new Error(
      `Could not extract release notes for ${version ?? selected[1]}.`
    );
  return notes;
};

const parseVersion = (args) => {
  const index = args.indexOf("--version");
  return index < 0 ? undefined : args[index + 1];
};

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href
) {
  try {
    if (!fs.existsSync(changelogPath))
      throw new Error(
        "CHANGELOG.md does not exist. Run `pnpm release:version` first."
      );
    process.stdout.write(
      `${extractReleaseNotes(fs.readFileSync(changelogPath, "utf8"), parseVersion(process.argv.slice(2)))}\n`
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
