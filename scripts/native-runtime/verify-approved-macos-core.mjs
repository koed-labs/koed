import { createHash } from "node:crypto";
import {
  fstatSync,
  openSync,
  closeSync,
  readFileSync,
  readSync
} from "node:fs";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { canonicalArtifactJson } from "../../packages/koed-server/src/artifact-canonical-json.mjs";
import { coreRecipeId } from "./core-artifact.mjs";
import { verifyApprovedMacosInventory } from "./macos-inventory.mjs";

const policy = JSON.parse(
  readFileSync(
    new URL("../../config/release-artifact-size-policy.json", import.meta.url)
  )
);
const MAX_ENTRIES = 200000;
const MAX_PAX = 1024 * 1024;
const MAX_TAR =
  policy.nativeCoreExpandedMaximum + MAX_ENTRIES * 1024 + MAX_PAX + 1024;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const decoder = new TextDecoder("utf-8", { fatal: true });
const text = (bytes) => decoder.decode(bytes);
const field = (buffer, start, length) => {
  const value = buffer.subarray(start, start + length);
  const end = value.indexOf(0);
  if (end >= 0 && value.subarray(end).some((byte) => byte !== 0))
    throw new Error("Invalid tar string field.");
  return text(end < 0 ? value : value.subarray(0, end));
};
const number = (buffer, start, length) => {
  const value = field(buffer, start, length).trim();
  if (!/^[0-7]+$/.test(value)) throw new Error("Invalid tar numeric field.");
  const result = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(result))
    throw new Error("Tar number out of range.");
  return result;
};
const paxRecords = (bytes) => {
  const records = {};
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    if (space < 0) throw new Error("Invalid PAX record.");
    const lengthBytes = bytes.subarray(offset, space);
    if (
      lengthBytes.length === 0 ||
      lengthBytes[0] < 0x31 ||
      lengthBytes[0] > 0x39 ||
      lengthBytes.some((byte) => byte < 0x30 || byte > 0x39)
    )
      throw new Error("Invalid PAX length.");
    const lengthText = lengthBytes.toString("ascii");
    const length = Number(lengthText),
      end = offset + length;
    if (
      !Number.isSafeInteger(length) ||
      end > bytes.length ||
      end <= space + 2 ||
      bytes[end - 1] !== 10
    )
      throw new Error("Invalid PAX record length.");
    const line = text(bytes.subarray(space + 1, end - 1));
    const equal = line.indexOf("=");
    const key = line.slice(0, equal),
      value = line.slice(equal + 1);
    if (
      equal < 1 ||
      !["path", "linkpath"].includes(key) ||
      Object.hasOwn(records, key) ||
      !value ||
      value.includes("\0")
    )
      throw new Error("Unsupported PAX record.");
    records[key] = value;
    offset = end;
  }
  if (!Object.keys(records).length) throw new Error("Empty PAX record.");
  return records;
};
async function* blocks(stream) {
  let pending = Buffer.alloc(0),
    total = 0;
  for await (const chunk of stream) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= 512) {
      total += 512;
      if (total > MAX_TAR) throw new Error("Tar expanded size limit exceeded.");
      yield pending.subarray(0, 512);
      pending = pending.subarray(512);
    }
  }
  if (pending.length) throw new Error("Partial tar block.");
}
const headerInfo = (header) => {
  const checksum = number(header, 148, 8);
  const copy = Buffer.from(header);
  copy.fill(32, 148, 156);
  if (
    checksum !== copy.reduce((sum, byte) => sum + byte, 0) ||
    field(header, 257, 6) !== "ustar"
  )
    throw new Error("Invalid tar header.");
  const name = field(header, 0, 100),
    prefix = field(header, 345, 155);
  return {
    path: prefix ? `${prefix}/${name}` : name,
    mode: number(header, 100, 8),
    size: number(header, 124, 12),
    type: field(header, 156, 1) || "0",
    target: field(header, 157, 100)
  };
};
async function readEntry(iterator, size, collect) {
  const hash = createHash("sha256"),
    data = [];
  let remaining = size;
  while (remaining > 0) {
    const next = await iterator.next();
    if (next.done) throw new Error("Truncated tar entry.");
    const count = Math.min(remaining, 512);
    hash.update(next.value.subarray(0, count));
    if (collect) data.push(next.value.subarray(0, count));
    if (count < 512 && next.value.subarray(count).some((byte) => byte !== 0))
      throw new Error("Nonzero tar padding.");
    remaining -= count;
  }
  return {
    sha256: hash.digest("hex"),
    bytes: collect ? Buffer.concat(data) : undefined
  };
}
async function verifyTar(stream, expected, manifestBytes) {
  const iterator = blocks(stream),
    seen = new Set();
  let ended = false,
    zeros = 0,
    pendingPax,
    entries = 0,
    expanded = 0;
  for await (const header of iterator) {
    if (header.every((byte) => byte === 0)) {
      if (++zeros >= 2) ended = true;
      continue;
    }
    if (zeros || ended)
      throw new Error("Invalid tar terminator or trailing data.");
    if (++entries > MAX_ENTRIES) throw new Error("Too many tar entries.");
    const item = headerInfo(header);
    if (item.size > policy.nativeCoreExpandedMaximum)
      throw new Error("Tar entry exceeds limit.");
    if (item.type === "x") {
      if (pendingPax || item.size > MAX_PAX)
        throw new Error("Invalid PAX extension.");
      pendingPax = paxRecords(
        (await readEntry(iterator, item.size, true)).bytes
      );
      continue;
    }
    if (!["0", "5", "2"].includes(item.type))
      throw new Error("Unsupported tar entry.");
    if (pendingPax?.path) item.path = pendingPax.path;
    if (pendingPax?.linkpath) item.target = pendingPax.linkpath;
    if (pendingPax?.linkpath && item.type !== "2")
      throw new Error("PAX linkpath on non-link.");
    pendingPax = undefined;
    if (item.path.endsWith("/") && item.type !== "5")
      throw new Error("Non-directory tar path has a trailing slash.");
    const path = item.path.endsWith("/") ? item.path.slice(0, -1) : item.path;
    if (
      !path ||
      path.includes("\\") ||
      path.includes("\0") ||
      path.split("/").some((part) => !part || part === "." || part === "..") ||
      seen.has(path)
    )
      throw new Error("Unsafe or duplicate tar path.");
    seen.add(path);
    const wanted = expected.get(path);
    if (
      !wanted ||
      item.mode !== wanted.mode ||
      (item.type === "5"
        ? wanted.type !== "directory"
        : item.type === "2"
          ? wanted.type !== "symlink"
          : wanted.type !== "file")
    )
      throw new Error("Unexpected tar entry or mode.");
    if (item.type !== "0" && item.size !== 0)
      throw new Error("Non-file tar entry has content.");
    if (item.type === "2" && item.target !== wanted.target)
      throw new Error("Tar symlink target mismatch.");
    if (item.type !== "2" && item.target)
      throw new Error("Unexpected tar link target.");
    if (item.type === "0") {
      expanded += item.size;
      if (
        expanded > policy.nativeCoreExpandedMaximum ||
        item.size !== wanted.bytes
      )
        throw new Error("Tar file size mismatch or limit exceeded.");
      const result = await readEntry(
        iterator,
        item.size,
        path === "koed-runtime/native-core-manifest.json"
      );
      if (
        result.sha256 !== wanted.sha256 ||
        (result.bytes && !result.bytes.equals(manifestBytes))
      )
        throw new Error("Tar file content mismatch.");
    }
  }
  if (!ended || pendingPax || seen.size !== expected.size)
    throw new Error("Incomplete tar archive or inventory.");
}

// Approval and full inventory must come from an authenticated authority independent of the candidate.
export async function verifyApprovedMacosCore({
  archivePath,
  externalManifestPath,
  fullInventory,
  approvedSha256,
  pin
}) {
  const projected = verifyApprovedMacosInventory(fullInventory, approvedSha256);
  if (
    !pin ||
    !/^[a-f0-9]{64}$/.test(pin.sha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(pin.manifestSha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(pin.recipeId ?? "") ||
    !Number.isSafeInteger(pin.expandedBytes) ||
    pin.expandedBytes <= 0 ||
    pin.expandedBytes > policy.nativeCoreExpandedMaximum ||
    !Number.isSafeInteger(pin.archiveBytes) ||
    pin.archiveBytes <= 0 ||
    pin.archiveBytes > policy.nativeCoreArchiveMaximum
  )
    throw new Error("Missing or invalid archive pin.");
  const manifestFd = openSync(externalManifestPath, "r");
  let manifestBytes;
  try {
    const stat = fstatSync(manifestFd);
    if (!stat.isFile() || stat.size > policy.maxManifestBytes)
      throw new Error("External manifest exceeds limit.");
    manifestBytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < manifestBytes.length) {
      const count = readSync(
        manifestFd,
        manifestBytes,
        offset,
        manifestBytes.length - offset,
        offset
      );
      if (!count) throw new Error("External manifest changed.");
      offset += count;
    }
    if (fstatSync(manifestFd).size !== stat.size)
      throw new Error("External manifest changed.");
  } finally {
    closeSync(manifestFd);
  }
  if (
    manifestBytes.length > policy.maxManifestBytes ||
    sha(manifestBytes) !== pin.manifestSha256
  )
    throw new Error("External manifest mismatch.");
  const manifest = JSON.parse(text(manifestBytes));
  if (
    text(manifestBytes) !== `${canonicalArtifactJson(manifest)}\n` ||
    manifest.schemaVersion !== 1 ||
    manifest.kind !== "core" ||
    manifest.recipeId !== pin.recipeId ||
    manifest.recipeId !== coreRecipeId(manifest.recipe) ||
    projected.reduce(
      (sum, entry) => sum + (entry.type === "file" ? entry.bytes : 0),
      manifestBytes.length
    ) !== pin.expandedBytes ||
    canonicalArtifactJson(manifest.inventory) !==
      canonicalArtifactJson(projected) ||
    manifest.recipe?.approvedDesktopInventorySha256 !== approvedSha256 ||
    manifest.recipe?.frozenInventorySha256 !== coreRecipeId(projected)
  )
    throw new Error("Manifest does not match approved inventory.");
  const expected = new Map([
    ["koed-runtime", { type: "directory", mode: 0o755 }],
    ...projected.map((entry) => [`koed-runtime/${entry.path}`, entry]),
    [
      "koed-runtime/native-core-manifest.json",
      {
        type: "file",
        mode: 0o644,
        bytes: manifestBytes.length,
        sha256: pin.manifestSha256
      }
    ]
  ]);
  if (expected.size !== projected.length + 2)
    throw new Error("Manifest conflicts with approved inventory.");
  const fd = openSync(archivePath, "r");
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size !== pin.archiveBytes)
      throw new Error("Archive size mismatch.");
    const hash = createHash("sha256");
    let count = 0;
    function* hashed() {
      for (;;) {
        const buffer = Buffer.allocUnsafe(65536);
        const length = readSync(fd, buffer, 0, buffer.length, count);
        if (!length) return;
        count += length;
        if (count > pin.archiveBytes) throw new Error("Archive size exceeded.");
        const chunk = buffer.subarray(0, length);
        hash.update(chunk);
        yield chunk;
      }
    }
    const input = Readable.from(hashed()),
      gunzip = createGunzip();
    input.on("error", (error) => gunzip.destroy(error));
    try {
      await verifyTar(input.pipe(gunzip), expected, manifestBytes);
    } finally {
      input.destroy();
      gunzip.destroy();
    }
    const after = fstatSync(fd);
    if (
      count !== pin.archiveBytes ||
      hash.digest("hex") !== pin.sha256 ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("Archive changed or digest mismatch.");
  } finally {
    closeSync(fd);
  }
}
