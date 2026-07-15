import {
  existsSync,
  lstatSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";

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

const normalizePackagedSymlinks = (directory) => {
  const result = { removed: 0, relocated: 0 };
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    const stat = lstatSync(entryPath);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(entryPath);
      if (target.startsWith("/")) {
        // The native Postgres install leaves compatibility links pointing at
        // its staging directory. Preserve the link name but point it at the
        // copied sibling inside the app bundle.
        const packagedTarget = join(directory, basename(target));
        if (!existsSync(packagedTarget)) {
          throw new Error(
            `Cannot relocate absolute symlink ${entryPath} -> ${target}: ${packagedTarget} is missing.`
          );
        }
        rmSync(entryPath);
        symlinkSync(basename(packagedTarget), entryPath);
        result.relocated += 1;
      } else if (!existsSync(entryPath)) {
        // pnpm deploy can retain workspace self-links whose targets are
        // outside the packaged app. They cannot work at runtime or be sealed.
        rmSync(entryPath);
        result.removed += 1;
      }
      continue;
    }
    if (stat.isDirectory()) {
      const child = normalizePackagedSymlinks(entryPath);
      result.removed += child.removed;
      result.relocated += child.relocated;
    }
  }
  return result;
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

  const symlinks = normalizePackagedSymlinks(appPath);
  if (symlinks.removed > 0 || symlinks.relocated > 0) {
    console.log(
      `Normalized ${symlinks.relocated} absolute and removed ${symlinks.removed} dangling symlink(s) from ${appPath}.`
    );
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
