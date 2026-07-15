import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

/**
 * Electron's prebuilt macOS binary is ad-hoc signed without a sealed resource
 * manifest. When publishing an intentionally unsigned artifact, replace that
 * incomplete signature after electron-builder has copied every app resource.
 *
 * Production builds must use a Developer ID signature and notarization instead;
 * this hook is intentionally opt-in for internal artifacts only.
 */
const removeDanglingSymlinks = (directory) => {
  let removed = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    const stat = lstatSync(entryPath);
    if (stat.isSymbolicLink()) {
      // pnpm deploy can retain workspace self-links whose targets are outside
      // the packaged app. They cannot work at runtime and break macOS sealing.
      if (!existsSync(entryPath)) {
        rmSync(entryPath);
        removed += 1;
      }
      continue;
    }
    if (stat.isDirectory()) removed += removeDanglingSymlinks(entryPath);
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

  const removed = removeDanglingSymlinks(appPath);
  if (removed > 0) {
    console.log(`Removed ${removed} dangling symlink(s) from ${appPath}.`);
  }
  if (process.env.KOED_ADHOC_SIGN_MACOS_APP !== "true") return;

  const result = spawnSync(
    "codesign",
    ["--force", "--deep", "--sign", "-", appPath],
    { stdio: "inherit" }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Ad-hoc signing ${appPath} failed with ${result.status}.`);
  }
}
