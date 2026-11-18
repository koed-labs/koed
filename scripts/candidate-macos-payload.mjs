import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  createReadStream,
  createWriteStream,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import plist from "plist";
import yauzl from "yauzl";
import { signMacosRuntime } from "../apps/desktop/scripts/sign-macos-runtime.mjs";

const validatedArchives = new WeakSet();
const validatedBundles = new WeakMap();
// The tested arm64 app is ~754 MiB; cap dereferenced native hashing at 6 GiB.
const maxNativeHashBytes = 6 * 1024 ** 3;
const trustedBuildDirectory = fileURLToPath(
  new URL("../apps/desktop/build/", import.meta.url)
);

const fileType = (entry) => {
  if (entry.versionMadeBy >>> 8 !== 3)
    throw new Error("Unsupported ZIP creator type");
  const mode = entry.externalFileAttributes >>> 16;
  const type = mode & 0o170000;
  if (type === 0o100000 && !entry.fileName.endsWith("/")) return "file";
  if (type === 0o040000 && entry.fileName.endsWith("/")) return "directory";
  if (type === 0o120000 && !entry.fileName.endsWith("/")) return "symlink";
  throw new Error("Unsupported special or inconsistent ZIP entry type");
};

const safeName = (name) => {
  const segments = name.replace(/\/$/, "").split("/");
  if (
    segments[0] !== "Koed.app" ||
    segments.length > 64 ||
    segments.some((part) => !part || part === "." || part === "..") ||
    name.includes("\\") ||
    name.includes("\0")
  )
    throw new Error("Unsafe candidate archive path");
  return segments.join("/");
};

const inspectEntries = async (zip, options) => {
  const entries = [];
  const seen = new Set();
  let expanded = 0;
  for await (const entry of zip.eachEntry()) {
    const path = safeName(entry.fileName);
    const key = path.normalize("NFC").toLowerCase();
    if (seen.has(key)) throw new Error("Duplicate or colliding archive path");
    seen.add(key);
    const type = fileType(entry);
    if (entry.isEncrypted())
      throw new Error("Encrypted ZIP entries are not supported");
    if (!Number.isSafeInteger(entry.uncompressedSize))
      throw new Error("Invalid entry size");
    expanded += entry.uncompressedSize;
    if (expanded > options.maxBytes)
      throw new Error("Expanded archive size exceeds limit");
    if (entries.length >= options.maxEntries)
      throw new Error("Archive entries exceed limit");
    if (type === "symlink" && entry.uncompressedSize > 4096)
      throw new Error("Symlink too large");
    entries.push({ entry, path, type, key });
  }
  const byKey = new Map(entries.map((item) => [item.key, item]));
  for (const item of entries) {
    const parts = item.key.split("/");
    parts.pop();
    while (parts.length) {
      const parent = byKey.get(parts.join("/"));
      if (parent && parent.type !== "directory")
        throw new Error("Non-directory or symlink ancestor");
      parts.pop();
    }
  }
  if (
    byKey.get("koed.app/contents/info.plist")?.type !== "file" ||
    byKey.get("koed.app/contents/macos/koed")?.type !== "file"
  ) {
    throw new Error("Candidate app layout is incomplete");
  }
  return entries;
};

const readEntry = async (zip, entry) => {
  const stream = await zip.openReadStreamPromise(entry);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
};

const inside = (root, path) => {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

const extractFile = async (zip, item, root) => {
  const path = join(root, item.path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const mode =
    (item.entry.externalFileAttributes >>> 16) & 0o111 ? 0o755 : 0o644;
  await pipeline(
    await zip.openReadStreamPromise(item.entry),
    createWriteStream(path, { flags: "wx", mode })
  );
};

const extractSymlinks = async (zip, entries, root) => {
  const links = [];
  const appRoot = join(root, "Koed.app");
  for (const item of entries.filter((item) => item.type === "symlink")) {
    const path = join(root, item.path);
    const target = new TextDecoder("utf-8", { fatal: true }).decode(
      await readEntry(zip, item.entry)
    );
    if (
      !target ||
      target.includes("\0") ||
      isAbsolute(target) ||
      !inside(appRoot, resolve(dirname(path), target))
    ) {
      throw new Error("Unsafe symlink target");
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
    symlinkSync(target, path);
    links.push(path);
  }
  for (const link of links) {
    if (!inside(appRoot, realpathSync.native(link)))
      throw new Error("Symlink escapes candidate root");
  }
};

const digestFile = async (fd) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream("", {
    fd,
    autoClose: false,
    start: 0
  }))
    hash.update(chunk);
  return hash.digest("hex");
};

export const validateCandidateArchive = async (archivePath, options) => {
  if (
    !/^[0-9a-f]{64}$/.test(options.sha256) ||
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes <= 0 ||
    !Number.isSafeInteger(options.maxEntries) ||
    options.maxEntries <= 0
  ) {
    throw new Error("Invalid archive validation parameters");
  }
  const fd = openSync(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let zip;
  let root;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > options.maxBytes)
      throw new Error("Archive size exceeds limit");
    if ((await digestFile(fd)) !== options.sha256)
      throw new Error("Archive digest mismatch");
    zip = await yauzl.fromFdPromise(fd, {
      autoClose: false,
      lazyEntries: true,
      strictFileNames: true
    });
    const entries = await inspectEntries(zip, options);
    root = mkdtempSync(join(realpathSync(options.workspace), "candidate-"));
    for (const item of entries) {
      if (item.type === "directory")
        mkdirSync(join(root, item.path), { recursive: true, mode: 0o755 });
      else if (item.type === "file") await extractFile(zip, item, root);
    }
    await extractSymlinks(zip, entries, root);
    const result = Object.freeze({ appPath: join(root, "Koed.app"), root });
    validatedArchives.add(result);
    return result;
  } catch (error) {
    if (root) rmSync(root, { recursive: true, force: true });
    throw error;
  } finally {
    if (zip) zip.close();
    else closeSync(fd);
  }
};

const hashRegularFile = (hash, path) => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let count;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, count));
  } finally {
    closeSync(fd);
  }
};

const hashCandidateTree = (root) => {
  const hash = createHash("sha256");
  const pending = [root];
  while (pending.length) {
    const path = pending.pop();
    const stat = lstatSync(path);
    const name = relative(root, path);
    const type = stat.isDirectory()
      ? "directory"
      : stat.isSymbolicLink()
        ? "symlink"
        : stat.isFile()
          ? "file"
          : "special";
    if (type === "special") throw new Error("Invalid candidate tree entry");
    hash.update(
      JSON.stringify([
        name,
        type,
        stat.mode & 0o777,
        stat.size,
        type === "symlink" ? readlinkSync(path) : null
      ]) + "\n"
    );
    if (type === "directory") {
      for (const child of readdirSync(path).sort().reverse())
        pending.push(join(path, child));
    } else if (type === "file") hashRegularFile(hash, path);
  }
  return hash.digest("hex");
};

const readBoundedFile = (path, limit) => {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > limit)
    throw new Error("Invalid bundle metadata file");
  return readFileSync(path, "utf8");
};

const validateRelativeAssetPath = (root, path) => {
  if (
    typeof path !== "string" ||
    !path ||
    path.includes("\\") ||
    path.includes("\0")
  ) {
    throw new Error("Invalid native asset path");
  }
  if (
    path
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("Unsafe native asset path");
  }
  const resolved = realpathSync.native(join(root, path));
  if (!inside(root, resolved))
    throw new Error("Native asset path escapes asset root");
};

const validateSignerTraversal = (root) => {
  const pending = [{ path: root, ancestors: new Set() }];
  let count = 0;
  while (pending.length) {
    const { path, ancestors } = pending.pop();
    if (++count > 100000 || ancestors.size > 64)
      throw new Error("Signer traversal exceeds limit");
    const stat = statSync(path);
    if (!stat.isDirectory()) continue;
    const key = `${stat.dev}:${stat.ino}`;
    if (ancestors.has(key))
      throw new Error("Directory symlink cycle in signer traversal");
    const next = new Set(ancestors);
    next.add(key);
    const children = readdirSync(path);
    if (count + pending.length + children.length > 100000)
      throw new Error("Signer traversal exceeds limit");
    for (const child of children)
      pending.push({ path: join(path, child), ancestors: next });
  }
};

const validateNativeHashWork = (runtimeRoot) => {
  const pending = [
    join(runtimeRoot, "postgres"),
    join(runtimeRoot, "llama.cpp")
  ];
  let bytes = 0;
  while (pending.length) {
    const path = pending.pop();
    const entry = lstatSync(path);
    if (entry.isDirectory()) {
      for (const child of readdirSync(path)) pending.push(join(path, child));
    } else {
      const target = statSync(path);
      if (target.isFile()) bytes += target.size;
      if (bytes > maxNativeHashBytes)
        throw new Error("Native hash work exceeds limit");
    }
  }
};

const validateRuntimeSymlinks = (root) => {
  const pending = [root];
  while (pending.length) {
    for (const entry of readdirSync(pending.pop(), { withFileTypes: true })) {
      const path = join(entry.parentPath, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (
        entry.isSymbolicLink() &&
        !inside(root, realpathSync.native(path))
      ) {
        throw new Error("Runtime symlink escapes runtime root");
      }
    }
  }
};

const validateExecutable = (root, path) => {
  validateRelativeAssetPath(root, path);
  const stat = statSync(join(root, path));
  if (!stat.isFile() || (stat.mode & 0o111) === 0)
    throw new Error("Invalid native executable");
};

const validateAssetExecutables = (asset, root) => {
  const required =
    asset.id === "postgres"
      ? ["initdb", "pg_ctl", "psql", "pg_config"]
      : ["llama_server"];
  for (const key of required)
    validateExecutable(root, asset.executablePaths[key]);
  for (const path of Object.values(asset.executablePaths))
    validateExecutable(root, path);
  if (asset.id === "llama.cpp") {
    if (!Array.isArray(asset.variants) || asset.variants.length !== 1)
      throw new Error("Unsupported native asset variants");
    const variant = asset.variants[0];
    if (
      variant?.backend !== "metal" ||
      variant.requirements?.platform !== "macos" ||
      variant.requirements?.architecture !== "arm64"
    )
      throw new Error("Unsupported native asset variant");
    validateExecutable(root, variant.executablePath);
  } else if (asset.variants !== undefined)
    throw new Error("Unsupported native asset variants");
};

const validateAsset = (asset, runtimeRoot) => {
  if (
    !asset ||
    !["postgres", "llama.cpp"].includes(asset.id) ||
    asset.platform !== "macos" ||
    asset.architecture !== "arm64" ||
    asset.packagedResourcePath !== asset.id ||
    asset.installPath !== asset.id ||
    typeof asset.version !== "string" ||
    !asset.version ||
    !/^[0-9a-f]{64}$/.test(asset.sha256)
  ) {
    throw new Error("Unsupported native asset metadata");
  }
  const assetRoot = join(runtimeRoot, asset.id);
  if (!lstatSync(assetRoot).isDirectory())
    throw new Error("Invalid native asset root");
  if (
    !Array.isArray(asset.expectedFiles) ||
    !asset.expectedFiles.length ||
    asset.expectedFiles.length > 50000 ||
    !asset.executablePaths ||
    typeof asset.executablePaths !== "object" ||
    Array.isArray(asset.executablePaths)
  ) {
    throw new Error("Invalid native asset file inventory");
  }
  for (const path of asset.expectedFiles)
    validateRelativeAssetPath(assetRoot, path);
  validateAssetExecutables(asset, assetRoot);
};

export const readCandidateVersion = (validated) => {
  if (!validatedArchives.has(validated))
    throw new Error("Candidate archive must be validated first");
  const info = plist.parse(
    readBoundedFile(join(validated.appPath, "Contents/Info.plist"), 1024 * 1024)
  );
  const value = info.CFBundleShortVersionString;
  if (
    typeof value !== "string" ||
    value.length > 128 ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
      value
    )
  )
    throw new Error("Invalid candidate version");
  return value;
};

export const validateCandidateBundle = (validated, { expectedVersion }) => {
  if (!validatedArchives.has(validated))
    throw new Error("Candidate archive must be validated first");
  if (
    typeof expectedVersion !== "string" ||
    !/^[0-9A-Za-z.+-]{1,128}$/.test(expectedVersion)
  )
    throw new Error("Invalid expected version");
  const app = validated.appPath;
  const info = plist.parse(
    readBoundedFile(join(app, "Contents/Info.plist"), 1024 * 1024)
  );
  if (
    info.CFBundleIdentifier !== "ai.koed.desktop" ||
    info.CFBundleExecutable !== "Koed" ||
    info.CFBundleShortVersionString !== expectedVersion ||
    info.CFBundleVersion !== expectedVersion
  ) {
    throw new Error("Candidate bundle identity or version mismatch");
  }
  try {
    lstatSync(join(app, "Contents/Library/LoginItems"));
    throw new Error("Unsupported LoginItems bundle");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  validateSignerTraversal(app);
  const runtimeRoot = join(app, "Contents/Resources/koed-runtime");
  if (!lstatSync(runtimeRoot).isDirectory())
    throw new Error("Invalid runtime root");
  validateRuntimeSymlinks(realpathSync.native(runtimeRoot));
  const assets = JSON.parse(
    readBoundedFile(
      join(runtimeRoot, "runtime-asset-manifest.json"),
      16 * 1024 * 1024
    )
  );
  if (
    assets.schemaVersion !== 1 ||
    !Array.isArray(assets.assets) ||
    assets.assets.length !== 2 ||
    new Set(assets.assets.map((asset) => asset?.id)).size !== 2
  )
    throw new Error("Unsupported native manifest schema");
  for (const asset of assets.assets) validateAsset(asset, runtimeRoot);
  validateNativeHashWork(runtimeRoot);
  const bundle = JSON.parse(
    readBoundedFile(
      join(runtimeRoot, "desktop-bundle-manifest.json"),
      16 * 1024 * 1024
    )
  );
  if (
    bundle.schemaVersion !== 1 ||
    bundle.productVersion !== expectedVersion ||
    bundle.component !== "base" ||
    bundle.target?.platform !== "macos" ||
    bundle.target?.architecture !== "arm64" ||
    !Array.isArray(bundle.files)
  ) {
    throw new Error("Unsupported desktop bundle manifest");
  }
  const result = Object.freeze({
    appPath: app,
    runtimeRoot,
    version: expectedVersion
  });
  validatedBundles.set(result, hashCandidateTree(app));
  return result;
};

export const signCandidateBundle = async (
  bundle,
  { identity, keychain },
  { sign = signMacosRuntime } = {}
) => {
  if (!validatedBundles.has(bundle))
    throw new Error("Candidate bundle must be validated first");
  if (hashCandidateTree(bundle.appPath) !== validatedBundles.get(bundle))
    throw new Error("Validated candidate integrity changed before signing");
  if (typeof identity !== "string" || !/^[A-F0-9]{40}$/.test(identity))
    throw new Error("Invalid signing identity");
  if (
    typeof keychain !== "string" ||
    !isAbsolute(keychain) ||
    keychain.includes("\0")
  )
    throw new Error("Invalid signing keychain");
  await sign({
    app: bundle.appPath,
    platform: "darwin",
    identity,
    keychain,
    identityValidation: true,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    optionsForFile: (path) => ({
      entitlements: join(
        trustedBuildDirectory,
        path === bundle.appPath
          ? "entitlements.mac.plist"
          : "entitlements.mac.inherit.plist"
      ),
      hardenedRuntime: true
    })
  });
};
