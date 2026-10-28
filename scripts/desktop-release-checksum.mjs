#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertKoedReleaseVersion } from "../packages/koed/release-version.mjs";

export function writeDesktopReleaseChecksum({
  releaseVersion,
  releaseDirectory
}) {
  assertKoedReleaseVersion(releaseVersion);
  const lines = ["dmg", "zip"].map((ext) => {
    const name = `Koed-${releaseVersion}-arm64.${ext}`;
    const hash = createHash("sha256")
      .update(readFileSync(resolve(releaseDirectory, name)))
      .digest("hex");
    return `${hash}  ${name}\n`;
  });
  const path = resolve(releaseDirectory, "koed-desktop-macos-arm64.sha256");
  writeFileSync(path, lines.join(""));
  return path;
}

export function resolveDesktopReleaseApp(releaseDirectory) {
  const candidates = ["mac-arm64", "mac"]
    .map((layout) => resolve(releaseDirectory, layout, "Koed.app"))
    .filter((path) => statSync(path, { throwIfNoEntry: false })?.isDirectory());
  if (candidates.length !== 1)
    throw new Error("Expected exactly one packaged Desktop app.");
  return candidates[0];
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const [mode, directory, version] = process.argv.slice(2);
    if (mode === "app" && process.env.GITHUB_OUTPUT) {
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `app=${resolveDesktopReleaseApp(directory)}\n`
      );
    } else if (mode === "checksum") {
      writeDesktopReleaseChecksum({
        releaseDirectory: directory,
        releaseVersion: version
      });
    } else
      throw new Error(
        "Usage: desktop-release-checksum.mjs app|checksum <release-directory> [version]"
      );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
