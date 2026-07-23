import {
  existsSync,
  lstatSync,
  readlinkSync,
  readdirSync,
  rmSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, join } from "node:path";

/**
 * Electron's prebuilt macOS binary is ad-hoc signed without a sealed resource
 * manifest. When publishing an intentionally unsigned artifact, replace that
 * incomplete signature after electron-builder has copied every app resource.
 *
 * Production builds must use a Developer ID signature and notarization instead;
 * this hook is intentionally opt-in for internal artifacts only.
 */
const signAdHoc = (path, options = []) => {
  const result = spawnSync(
    "codesign",
    ["--force", ...options, "--sign", "-", path],
    {
      stdio: "inherit"
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Ad-hoc signing ${path} failed with ${result.status}.`);
  }
};

const nestedCodeBundles = (directory) => {
  const bundles = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const entryPath = join(directory, entry.name);
    if (entry.name.endsWith(".app") || entry.name.endsWith(".framework")) {
      bundles.push(entryPath);
      continue;
    }
    bundles.push(...nestedCodeBundles(entryPath));
  }
  return bundles;
};

export const normalizePackagedSymlinks = (directory) => {
  let removed = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    const stat = lstatSync(entryPath);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(entryPath);
      if (isAbsolute(target)) {
        throw new Error(
          `Packaged app contains an absolute symlink ${entryPath} -> ${target}. Native runtime copies must preserve relative symlink targets.`
        );
      } else if (!existsSync(entryPath)) {
        // pnpm deploy can retain workspace self-links whose targets are
        // outside the packaged app. They cannot work at runtime or be sealed.
        rmSync(entryPath);
        removed += 1;
      }
      continue;
    }
    if (stat.isDirectory()) {
      removed += normalizePackagedSymlinks(entryPath);
    }
  }
  return removed;
};

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );
  if (!existsSync(appPath)) {
    throw new Error(`Expected packaged macOS app at ${appPath}.`);
  }

  const removed = normalizePackagedSymlinks(appPath);
  if (removed > 0) {
    console.log(`Removed ${removed} dangling symlink(s) from ${appPath}.`);
  }
  if (process.env.KOED_ADHOC_SIGN_MACOS_APP !== "true") return;

  // Sign Electron's nested app/framework bundles before sealing the completed
  // outer bundle. Do not use --deep on the outer bundle: it would re-sign the
  // native runtime dylibs after they have been included in the resource seal.
  for (const bundle of nestedCodeBundles(
    join(appPath, "Contents", "Frameworks")
  )) {
    signAdHoc(bundle, ["--deep"]);
  }
  signAdHoc(appPath);
}
