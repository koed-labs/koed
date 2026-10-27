import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { verifyPackagedControlPlaneCatalog } from "./verify-packaged-control-plane-catalog.mjs";
import { assertReleasePackageBindings } from "./inspect-release-package-bindings.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const text = (header, start, size) =>
  header
    .subarray(start, start + size)
    .toString("utf8")
    .replace(/\0.*$/s, "");
const number = (header, start, size) => {
  const value = text(header, start, size).trim();
  if (!/^[0-7]+$/.test(value))
    throw new Error("Invalid archive numeric field.");
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed))
    throw new Error("Oversized archive field.");
  return parsed;
};
const safePath = (path) => {
  if (
    !path ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Unsafe package archive path.");
  return path;
};
const paxPath = (bytes) => {
  let offset = 0;
  let path;
  const seen = new Set();
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    const length = Number(bytes.subarray(offset, space).toString());
    if (
      space < offset ||
      !Number.isSafeInteger(length) ||
      length <= space - offset + 1 ||
      offset + length > bytes.length ||
      bytes[offset + length - 1] !== 10
    )
      throw new Error("Malformed package archive PAX record.");
    const record = bytes
      .subarray(space + 1, offset + length - 1)
      .toString("utf8");
    const split = record.indexOf("=");
    const key = record.slice(0, split);
    if (
      split < 1 ||
      seen.has(key) ||
      ![
        "path",
        "mtime",
        "atime",
        "ctime",
        "uid",
        "gid",
        "uname",
        "gname"
      ].includes(key)
    )
      throw new Error("Unsupported package archive PAX record.");
    seen.add(key);
    if (key === "path") path = record.slice(split + 1);
    offset += length;
  }
  return path;
};

export const readPackageFiles = (compressed) => {
  const tar = gunzipSync(compressed, { maxOutputLength: 1024 * 1024 * 1024 });
  const files = new Map();
  const seen = new Set();
  let offset = 0;
  let pendingPath;
  let ended = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (
        pendingPath ||
        tar.length - offset < 1024 ||
        !tar.subarray(offset).every((byte) => byte === 0)
      )
        throw new Error("Invalid package archive terminator.");
      ended = true;
      break;
    }
    const check = Buffer.from(header);
    check.fill(32, 148, 156);
    if (number(header, 148, 8) !== check.reduce((sum, byte) => sum + byte, 0))
      throw new Error("Invalid package archive checksum.");
    const size = number(header, 124, 12);
    const type = text(header, 156, 1) || "0";
    offset += 512;
    if (size > 256 * 1024 * 1024 || offset + size > tar.length)
      throw new Error("Truncated or oversized package archive entry.");
    const bytes = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    if (type === "x") {
      if (pendingPath) throw new Error("Duplicate package archive PAX header.");
      pendingPath = paxPath(bytes);
      continue;
    }
    if (!["0", "5"].includes(type))
      throw new Error("Package archive links or special entries forbidden.");
    const prefix = text(header, 345, 155);
    const name = safePath(
      (
        pendingPath ?? `${prefix ? `${prefix}/` : ""}${text(header, 0, 100)}`
      ).replace(/\/$/, "")
    );
    pendingPath = undefined;
    if (name !== "package" && !name.startsWith("package/"))
      throw new Error("Package archive root mismatch.");
    if (seen.has(name)) throw new Error("Duplicate package archive path.");
    seen.add(name);
    if (seen.size > 100000)
      throw new Error("Package archive file count exceeded.");
    if (type === "5") {
      if (size) throw new Error("Nonempty package archive directory.");
    } else {
      if (name === "package")
        throw new Error("Package archive root must be directory.");
      files.set(name.slice(8), Buffer.from(bytes));
    }
  }
  if (!ended) throw new Error("Missing package archive terminator.");
  for (const path of seen) {
    const parts = path.slice(8).split("/");
    for (let i = 1; i < parts.length; i++)
      if (files.has(parts.slice(0, i).join("/")))
        throw new Error("Package archive file path conflict.");
  }
  return files;
};

export const inspectReleasePackage = ({
  bytes,
  expected,
  version,
  root,
  catalogPath
}) => {
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (integrity !== expected.integrity || bytes.length !== expected.bytes)
    throw new Error("npm package SRI/size mismatch.");
  const files = readPackageFiles(bytes);
  const manifest = JSON.parse(files.get("package.json")?.toString() ?? "null");
  if (
    manifest?.name !== "@koed-labs/server" ||
    manifest.version !== version ||
    JSON.stringify(manifest.bin) !== JSON.stringify({ koed: "bin/koed.js" }) ||
    !files.has("bin/koed.js")
  )
    throw new Error("npm package name/version/bin mismatch.");
  const inventory = createHash("sha256");
  for (const [path, data] of [...files].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  )) {
    inventory.update(path).update("\0").update(sha256(data)).update("\0");
    const output = resolve(root, path);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, data, { flag: "wx", mode: 0o600 });
  }
  if (inventory.digest("hex") !== expected.inventorySha256)
    throw new Error("npm package inventory mismatch.");
  assertReleasePackageBindings(files);
  verifyPackagedControlPlaneCatalog({
    modulePath: resolve(root, "vendor/control-plane.js"),
    catalogPath,
    version
  });
  return {
    integrity,
    inventorySha256: expected.inventorySha256,
    bytes: bytes.length
  };
};
