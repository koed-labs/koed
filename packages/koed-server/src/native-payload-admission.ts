import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { canonicalArtifactJson } from "./artifact-canonical-json.mjs";
import { hashFileDescriptor } from "./component-verification.js";
import { nativeKind, type NativePin } from "./native-runtime-catalog.js";

export const nativeDigest = (value: Buffer | string): string =>
  createHash("sha256").update(value).digest("hex");

export function nativeJsonObject(bytes: Buffer): Record<string, unknown> {
  const data: unknown = JSON.parse(bytes.toString("utf8"));
  if (typeof data !== "object" || data === null || Array.isArray(data))
    throw new Error("Invalid native metadata document.");
  return data as Record<string, unknown>;
}

export function readNativeMetadata(path: string, limit: number): Buffer {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit)
      throw new Error("Invalid native metadata file.");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function syncNativeDirectory(path: string): void {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function nativeFileDigest(
  path: string,
  bytes: number,
  durable = false
): string {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== bytes)
      throw new Error(`Native file size or type changed: ${path}`);
    const digest = hashFileDescriptor(fd);
    if (durable) fsyncSync(fd);
    return digest;
  } finally {
    closeSync(fd);
  }
}

// The manifest digest is the admission authority. Check the entire tree, including
// extra files, before executing a probe or resolving a selection for startup.
export function permitsNativeEntry(
  kind: "core" | "cuda",
  path: string,
  directory: boolean
): boolean {
  if (path === "") return directory;
  if (kind === "core")
    return path !== "llama.cpp/cuda" && !path.startsWith("llama.cpp/cuda/");
  if (path === "llama.cpp" || path === "llama.cpp/cuda") return directory;
  return (
    path.startsWith("llama.cpp/cuda/") &&
    !/(?:^|\/)libcuda\.so(?:\.\d+)*$/.test(path)
  );
}

export function verifyNativePayload(
  root: string,
  pin: NativePin,
  durable = false
): void {
  const kind = nativeKind(pin);
  const name =
    kind === "core"
      ? "native-core-manifest.json"
      : "llama.cpp/cuda/native-cuda-manifest.json";
  const boundary = kind === "core" ? root : resolve(root, "llama.cpp/cuda");
  if (
    !lstatSync(root).isDirectory() ||
    (kind === "cuda" &&
      ![dirname(boundary), boundary].every((path) =>
        lstatSync(path).isDirectory()
      ))
  )
    throw new Error("Native payload directory links are not allowed.");
  const file = resolve(root, name);
  const raw = readNativeMetadata(file, 8 * 1024 * 1024);
  if (
    nativeDigest(raw) !== pin.manifestSha256 ||
    (lstatSync(file).mode & 0o7777) !== 0o644
  )
    throw new Error(
      `Native ${kind} manifest differs from the admitted digest or mode.`
    );
  const manifest = nativeJsonObject(raw);
  if (
    manifest.kind !== kind ||
    manifest.schemaVersion !== 1 ||
    manifest.recipeId !== pin.recipeId ||
    nativeDigest(canonicalArtifactJson(manifest.recipe)) !== pin.recipeId ||
    manifest.runtimeVersion !== pin.runtimeVersion ||
    canonicalArtifactJson(manifest.target) !==
      canonicalArtifactJson(pin.target) ||
    canonicalArtifactJson(manifest.contracts) !==
      canonicalArtifactJson(pin.contracts) ||
    ("components" in pin
      ? canonicalArtifactJson(manifest.components) !==
        canonicalArtifactJson(pin.components)
      : canonicalArtifactJson(manifest.llamaCpp) !==
          canonicalArtifactJson(pin.llamaCpp) ||
        canonicalArtifactJson(manifest.cuda) !==
          canonicalArtifactJson(pin.cuda))
  )
    throw new Error(`Native ${kind} manifest is incompatible with its pin.`);
  if (!Array.isArray(manifest.inventory))
    throw new Error("Missing native payload inventory.");
  const inventory: unknown[] = manifest.inventory;
  let index = 0;
  const check = (entry: { path: string } & Record<string, unknown>) => {
    if (
      index >= inventory.length ||
      canonicalArtifactJson(entry) !== canonicalArtifactJson(inventory[index++])
    )
      throw new Error(
        `Native ${kind} inventory changed at ${entry.path}. Inspect the damaged payload before repair.`
      );
  };
  let expanded = raw.length;
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory).sort()) {
      const path = resolve(directory, entry),
        key = relative(root, path);
      if (key === name) continue;
      const stat = lstatSync(path),
        mode = stat.mode & 0o7777;
      if (!permitsNativeEntry(kind, key, stat.isDirectory()))
        throw new Error(`Unexpected native ${kind} entry: ${key}`);
      if (stat.isDirectory()) {
        check({ path: key, type: "directory", mode });
        walk(path);
      } else if (stat.isFile()) {
        expanded += stat.size;
        if (expanded > pin.expandedBytes)
          throw new Error("Native inventory exceeds its pinned size.");
        check({
          path: key,
          type: "file",
          mode,
          bytes: stat.size,
          sha256: nativeFileDigest(path, stat.size, durable)
        });
      } else if (stat.isSymbolicLink()) {
        const target = readlinkSync(path),
          dest = resolve(dirname(path), target);
        const rel = relative(boundary, dest);
        if (
          isAbsolute(target) ||
          rel.startsWith("../") ||
          rel === ".." ||
          !lstatSync(dest).isFile() ||
          realpathSync(path) !==
            resolve(realpathSync(root), relative(root, dest))
        )
          throw new Error(`Unsafe native library link: ${key}`);
        check({ path: key, type: "symlink", mode: 0o777, target });
      } else throw new Error(`Unsupported native file: ${key}`);
    }
    if (durable) syncNativeDirectory(directory);
  };
  if (durable) nativeFileDigest(file, raw.length, true);
  walk(root);
  if (expanded !== pin.expandedBytes || index !== inventory.length)
    throw new Error(
      `Native ${kind} inventory changed. Inspect the installed payload before repair.`
    );
}
