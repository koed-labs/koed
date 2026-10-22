import { createHash } from "node:crypto";
import {
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  chmodSync,
  writeFileSync
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  listFiles,
  sha256File,
  sha256Files
} from "../../../scripts/native-runtime/manifest-lib.mjs";

export const inventoryRuntime = (runtimeRoot, directory = runtimeRoot) => {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    const name = relative(runtimeRoot, path).replaceAll("\\", "/");
    if (name === "desktop-bundle-manifest.json") continue;
    if (entry.isSymbolicLink()) {
      const target = relative(runtimeRoot, realpathSync(path));
      if (target === ".." || target.startsWith("../") || isAbsolute(target)) {
        throw new Error(`Bundled runtime symlink escapes root: ${name}`);
      }
      files.push({
        path: name,
        kind: "symlink",
        sha256: createHash("sha256").update(readlinkSync(path)).digest("hex")
      });
    } else if (entry.isDirectory())
      files.push(...inventoryRuntime(runtimeRoot, path));
    else if (entry.isFile())
      files.push({ path: name, kind: "file", sha256: sha256File(path) });
    else throw new Error(`Bundled runtime contains unsupported entry: ${name}`);
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
};

export const writeDesktopBundleManifest = (runtimeRoot, bundle) => {
  const bundlePath = resolve(runtimeRoot, "desktop-bundle-manifest.json");
  writeFileSync(bundlePath, `${JSON.stringify(bundle)}\n`, { mode: 0o644 });
  chmodSync(bundlePath, 0o644);
};

export const finalizeRuntimeManifests = (runtimeRoot) => {
  // Validate the complete tree before hashing native assets, which follow links.
  inventoryRuntime(runtimeRoot);
  const nativePath = resolve(runtimeRoot, "runtime-asset-manifest.json");
  const native = JSON.parse(readFileSync(nativePath, "utf8"));
  for (const asset of native.assets) {
    const root = resolve(runtimeRoot, asset.packagedResourcePath);
    const target = relative(runtimeRoot, root);
    if (
      !target ||
      target === ".." ||
      target.startsWith("../") ||
      isAbsolute(target)
    ) {
      throw new Error(`Native asset path escapes runtime: ${asset.id}`);
    }
    asset.expectedFiles = listFiles(root).sort();
    asset.sha256 = sha256Files(root, asset.expectedFiles);
  }
  writeFileSync(nativePath, `${JSON.stringify(native, null, 2)}\n`);
  const bundle = JSON.parse(
    readFileSync(resolve(runtimeRoot, "desktop-bundle-manifest.json"), "utf8")
  );
  bundle.files = inventoryRuntime(runtimeRoot);
  writeDesktopBundleManifest(runtimeRoot, bundle);
};
