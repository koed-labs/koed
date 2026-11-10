import { posix } from "node:path";
import { coreRecipeId } from "./core-artifact.mjs";

const comparePaths = (a, b) => {
  const left = a.split("/");
  const right = b.split("/");
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return left.length - right.length;
};
const validPath = (path) =>
  typeof path === "string" &&
  path.length > 0 &&
  !path.includes("\\") &&
  !path.includes("\0") &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== "..");

export const verifyApprovedMacosInventory = (inventory, approvedSha256) => {
  if (
    !/^[a-f0-9]{64}$/.test(approvedSha256 ?? "") ||
    !Array.isArray(inventory) ||
    inventory.length === 0 ||
    inventory.length > 200000
  )
    throw new Error("Missing or invalid approved macOS inventory evidence.");
  const entries = new Map();
  let previous;
  for (const entry of inventory) {
    if (
      !entry ||
      !validPath(entry.path) ||
      (previous !== undefined && comparePaths(previous, entry.path) >= 0)
    )
      throw new Error("Invalid macOS inventory path or ordering.");
    const keys = Object.keys(entry).sort().join(",");
    const valid =
      entry.type === "directory"
        ? keys === "mode,path,type" && entry.mode === 0o755
        : entry.type === "file"
          ? keys === "bytes,mode,path,sha256,type" &&
            Number.isSafeInteger(entry.bytes) &&
            entry.bytes >= 0 &&
            /^[a-f0-9]{64}$/.test(entry.sha256 ?? "") &&
            Number.isInteger(entry.mode) &&
            entry.mode >= 0 &&
            entry.mode <= 0o777
          : entry.type === "symlink" &&
            keys === "mode,path,target,type" &&
            entry.mode === 0o777 &&
            typeof entry.target === "string" &&
            entry.target.length > 0 &&
            !entry.target.includes("\0") &&
            !entry.target.includes("\\") &&
            !posix.isAbsolute(entry.target);
    if (!valid) throw new Error("Invalid macOS inventory entry.");
    const parent = posix.dirname(entry.path);
    if (parent !== "." && entries.get(parent)?.type !== "directory")
      throw new Error("Missing macOS inventory parent directory.");
    entries.set(entry.path, entry);
    previous = entry.path;
  }
  for (const entry of inventory) {
    if (entry.type !== "symlink") continue;
    const target = posix.normalize(
      posix.join(posix.dirname(entry.path), entry.target)
    );
    if (
      target === ".." ||
      target.startsWith("../") ||
      entries.get(target)?.type !== "file"
    )
      throw new Error("Unsafe macOS inventory symlink.");
  }
  if (coreRecipeId(inventory) !== approvedSha256)
    throw new Error("Frozen runtime does not match approved inventory digest.");
  return inventory.filter(
    (entry) =>
      !["provenance.json", "README.koed-native-runtime.txt"].includes(
        entry.path
      )
  );
};
