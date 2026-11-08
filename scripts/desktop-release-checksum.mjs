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

function linuxChecksumPaths({ releaseVersion, releaseDirectory }) {
  assertKoedReleaseVersion(releaseVersion);
  const name = `Koed-${releaseVersion}-x86_64.AppImage`;
  return {
    name,
    asset: resolve(releaseDirectory, name),
    checksum: resolve(releaseDirectory, "koed-desktop-linux-x64.sha256")
  };
}

function linuxChecksumLine(paths) {
  if (!statSync(paths.asset).isFile())
    throw new Error("AppImage must be a regular file.");
  const hash = createHash("sha256")
    .update(readFileSync(paths.asset))
    .digest("hex");
  return `${hash}  ${paths.name}\n`;
}

export function writeLinuxDesktopReleaseChecksum(options) {
  const paths = linuxChecksumPaths(options);
  writeFileSync(paths.checksum, linuxChecksumLine(paths));
  return paths.checksum;
}

export function verifyLinuxDesktopReleaseSize(options) {
  const paths = linuxChecksumPaths(options);
  const stat = statSync(paths.asset);
  // Provisional safety ceiling matches the protected candidate verifier limit;
  // it is not an empirical Linux release size baseline.
  if (!stat.isFile() || stat.size === 0 || stat.size > 4 * 1024 ** 3)
    throw new Error(
      "Linux AppImage exceeds provisional 4 GiB ceiling or is not a nonempty regular file."
    );
}

export function verifyLinuxDesktopReleaseChecksum(options) {
  const paths = linuxChecksumPaths(options);
  if (readFileSync(paths.checksum, "utf8") !== linuxChecksumLine(paths)) {
    throw new Error("Invalid Linux AppImage checksum or asset.");
  }
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
    } else if (
      ["checksum-linux", "verify-linux", "size-linux"].includes(mode) &&
      directory &&
      version &&
      process.argv.length === 5
    ) {
      const options = { releaseDirectory: directory, releaseVersion: version };
      if (mode === "checksum-linux") writeLinuxDesktopReleaseChecksum(options);
      else if (mode === "verify-linux")
        verifyLinuxDesktopReleaseChecksum(options);
      else verifyLinuxDesktopReleaseSize(options);
    } else
      throw new Error(
        "Usage: desktop-release-checksum.mjs app|checksum|checksum-linux|verify-linux|size-linux <release-directory> [version]"
      );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
