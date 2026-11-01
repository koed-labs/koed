import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { extractFile, listPackage, statFile } from "@electron/asar";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const normalize = (path) => path.replaceAll("\\", "/");

// Inspect actual bytes in every packaging location, including nested archives
// and package copies. Symlinks are recorded without following framework loops.
export const inventoryDesktopPayload = (root, privacyPackages = []) => {
  const files = [];
  const links = [];
  const packages = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      const name = normalize(relative(root, path));
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        links.push(name);
      } else if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) {
        const bytes = readFileSync(path);
        files.push({
          path: name,
          bytes: stat.size,
          sha256: digest(bytes),
          location: "filesystem"
        });
        if (entry.name === "package.json") addPackage(name, bytes);
        if (entry.name.endsWith(".asar")) {
          for (const member of listPackage(path)) {
            const memberName = member.replace(/^\//, "");
            const memberStat = statFile(path, memberName);
            if (typeof memberStat.size !== "number") continue;
            const memberPath = `${name}/${memberName}`;
            const content = extractFile(path, memberName);
            files.push({
              path: memberPath,
              bytes: memberStat.size,
              sha256: digest(content),
              location: "asar",
              unpacked: memberStat.unpacked === true
            });
            if (
              memberName.endsWith("/package.json") ||
              memberName === "package.json"
            )
              addPackage(memberPath, content);
          }
        }
      }
    }
  };
  const addPackage = (path, bytes) => {
    const manifest = JSON.parse(bytes.toString("utf8"));
    if (typeof manifest.name === "string")
      packages.push({
        path: normalize(dirname(path)),
        name: manifest.name,
        version: manifest.version ?? null
      });
  };
  visit(root);
  const excluded = new Set([
    "@koed/privacy-service",
    "onnxruntime-node",
    "onnxruntime-web",
    "onnxruntime-common",
    "@huggingface/transformers",
    ...privacyPackages
  ]);
  const privacyRoots = packages
    .filter((entry) => excluded.has(entry.name))
    .flatMap((entry) => [
      entry.path,
      entry.path.replace(/\.asar\//, ".asar.unpacked/")
    ]);
  const privacy = files.filter(
    (entry) =>
      privacyRoots.some((path) => entry.path.startsWith(`${path}/`)) ||
      /(?:^|\/)privacy-service\//.test(entry.path) ||
      /(?:^|\/)(?:libonnxruntime[^/]*|onnxruntime_binding\.node)$/.test(
        entry.path
      ) ||
      /\.(?:onnx(?:_data)?|safetensors)$/i.test(entry.path)
  );
  const copies = new Map();
  for (const entry of files) {
    // An unpacked ASAR member and its physical file are one payload copy.
    if (entry.unpacked || entry.path.endsWith(".asar")) continue;
    const same = copies.get(entry.sha256) ?? [];
    same.push(entry);
    copies.set(entry.sha256, same);
  }
  const duplicates = [...copies.values()]
    .filter((entries) => entries.length > 1)
    .map((entries) => ({
      sha256: entries[0].sha256,
      bytesPerCopy: entries[0].bytes,
      duplicateBytes: entries[0].bytes * (entries.length - 1),
      paths: entries.map((entry) => entry.path)
    }));
  return {
    schemaVersion: 1,
    root: resolve(root),
    physicalBytes: files
      .filter((entry) => entry.location === "filesystem")
      .reduce((sum, entry) => sum + entry.bytes, 0),
    privacyPhysicalBytes: privacy
      .filter((entry) => entry.location === "filesystem")
      .reduce((sum, entry) => sum + entry.bytes, 0),
    privacyAsarLogicalBytes: privacy
      .filter((entry) => entry.location === "asar" && !entry.unpacked)
      .reduce((sum, entry) => sum + entry.bytes, 0),
    privacyFiles: privacy,
    packages,
    duplicates,
    links,
    files
  };
};

export const assertNoPrivacyPayload = (root, privacyPackages = []) => {
  if (!existsSync(root))
    throw new Error(`Desktop payload does not exist: ${root}`);
  const inventory = inventoryDesktopPayload(root, privacyPackages);
  if (inventory.privacyFiles.length)
    throw new Error(
      `Desktop Base contains Privacy-only payload:\n${inventory.privacyFiles
        .slice(0, 20)
        .map((entry) => entry.path)
        .join("\n")}`
    );
  return inventory;
};
