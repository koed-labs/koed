import { gzipSync } from "node:zlib";
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
  readdirSync,
  rmSync,
  writeSync,
  writeFileSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const tarString = (buffer, offset, length, value) => {
  if (Buffer.byteLength(value) > length) {
    throw new Error(`Tar header value is too long: ${value}`);
  }
  buffer.write(value, offset, length, "utf8");
};

const tarOctal = (buffer, offset, length, value) => {
  const text = value.toString(8).padStart(length - 1, "0");
  tarString(buffer, offset, length, `${text.slice(-(length - 1))}\0`);
};

const splitTarPath = (path) => {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  const parts = path.split("/");
  for (let index = 1; index < parts.length; index += 1) {
    const prefix = parts.slice(0, index).join("/");
    const name = parts.slice(index).join("/");
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`Path is too long for deterministic ustar archive: ${path}`);
};

const tarHeader = ({ path, mode, size, type, linkname = "" }) => {
  const header = Buffer.alloc(512, 0);
  const { name, prefix } = splitTarPath(path);
  tarString(header, 0, 100, name);
  tarOctal(header, 100, 8, mode);
  tarOctal(header, 108, 8, 0);
  tarOctal(header, 116, 8, 0);
  tarOctal(header, 124, 12, size);
  tarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  tarString(header, 156, 1, type);
  tarString(header, 157, 100, linkname);
  tarString(header, 257, 6, "ustar");
  tarString(header, 263, 2, "00");
  tarString(header, 265, 32, "root");
  tarString(header, 297, 32, "root");
  tarString(header, 345, 155, prefix);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  tarOctal(header, 148, 8, checksum);
  return header;
};

const paxRecord = (key, value) => {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  for (;;) {
    const candidate = `${length}${body}`;
    const actual = Buffer.byteLength(candidate);
    if (actual === length) return candidate;
    length = actual;
  }
};

const paxContent = (records) =>
  Buffer.from(
    Object.entries(records)
      .map(([key, value]) => paxRecord(key, value))
      .join(""),
    "utf8"
  );

const padded = (buffer) => {
  const remainder = buffer.length % 512;
  return remainder === 0
    ? buffer
    : Buffer.concat([buffer, Buffer.alloc(512 - remainder, 0)]);
};

export const deterministicArchiveEntries = (root, relativeRoot = "") =>
  readdirSync(root)
    .sort()
    .flatMap((name) => {
      const path = resolve(root, name);
      const relativePath = relativeRoot ? `${relativeRoot}/${name}` : name;
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        return [
          { path, relativePath: `${relativePath}/`, stat, type: "directory" },
          ...deterministicArchiveEntries(path, relativePath)
        ];
      }
      if (stat.isSymbolicLink()) {
        return [{ path, relativePath, stat, type: "symlink" }];
      }
      if (stat.isFile()) {
        return [{ path, relativePath, stat, type: "file" }];
      }
      throw new Error(`Unsupported package archive entry: ${relativePath}`);
    });

export const writeDeterministicTarGz = ({
  sourceDir,
  rootName,
  tarPath,
  streaming = false
}) => {
  const blocks = [];
  const temporaryTarPath = `${tarPath}.tar-${process.pid}`;
  const descriptor = streaming
    ? openSync(temporaryTarPath, "w", 0o600)
    : undefined;
  const append = (buffer) => {
    if (descriptor === undefined) blocks.push(buffer);
    else {
      let offset = 0;
      while (offset < buffer.length) {
        offset += writeSync(descriptor, buffer, offset, buffer.length - offset);
      }
    }
  };
  const appendFile = (path, size) => {
    if (descriptor === undefined) {
      append(padded(readFileSync(path)));
      return;
    }
    const source = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
      let bytesRead = 0;
      do {
        bytesRead = readSync(source, buffer, 0, buffer.length, null);
        if (bytesRead > 0) append(buffer.subarray(0, bytesRead));
      } while (bytesRead > 0);
    } finally {
      closeSync(source);
    }
    const remainder = size % 512;
    if (remainder !== 0) append(Buffer.alloc(512 - remainder, 0));
  };
  append(tarHeader({ path: `${rootName}/`, mode: 0o755, size: 0, type: "5" }));
  let paxIndex = 0;
  let writeFailure;
  try {
    for (const entry of deterministicArchiveEntries(sourceDir)) {
      const archivePath = `${rootName}/${entry.relativePath}`;
      const linkname =
        entry.type === "symlink" ? readlinkSync(entry.path) : undefined;
      const pax = {};
      try {
        splitTarPath(archivePath);
      } catch {
        pax.path = archivePath;
      }
      if (linkname && Buffer.byteLength(linkname) > 100) {
        pax.linkpath = linkname;
      }
      let paxEntryIndex;
      if (Object.keys(pax).length > 0) {
        const content = paxContent(pax);
        paxEntryIndex = String(paxIndex).padStart(6, "0");
        paxIndex += 1;
        append(
          tarHeader({
            path: `PaxHeaders/${paxEntryIndex}`,
            mode: 0o644,
            size: content.length,
            type: "x"
          })
        );
        append(padded(content));
      }
      const headerPath = pax.path ? `PaxEntries/${paxEntryIndex}` : archivePath;
      if (entry.type === "directory") {
        append(
          tarHeader({ path: headerPath, mode: 0o755, size: 0, type: "5" })
        );
      } else if (entry.type === "symlink") {
        append(
          tarHeader({
            path: headerPath,
            mode: 0o777,
            size: 0,
            type: "2",
            linkname: pax.linkpath ? "" : linkname
          })
        );
      } else {
        append(
          tarHeader({
            path: headerPath,
            mode: entry.stat.mode & 0o777,
            size: entry.stat.size,
            type: "0"
          })
        );
        appendFile(entry.path, entry.stat.size);
      }
    }
    append(Buffer.alloc(1024, 0));
  } catch (error) {
    writeFailure = error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  if (writeFailure) {
    if (streaming) rmSync(temporaryTarPath, { force: true });
    throw writeFailure;
  }
  if (!streaming) {
    writeFileSync(tarPath, gzipSync(Buffer.concat(blocks), { mtime: 0 }));
    return;
  }
  try {
    const script = [
      'import { createReadStream, createWriteStream } from "node:fs";',
      'import { createGzip } from "node:zlib";',
      'import { pipeline } from "node:stream/promises";',
      "await pipeline(createReadStream(process.argv[1]), createGzip({ mtime: 0 }), createWriteStream(process.argv[2], { mode: 0o600 }));"
    ].join("\n");
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", script, temporaryTarPath, tarPath],
      { encoding: "utf8" }
    );
    if (result.error || result.status !== 0) {
      throw new Error(
        `Could not gzip deterministic tar: ${result.stderr || result.stdout || result.error?.message || "unknown error"}`
      );
    }
  } finally {
    rmSync(temporaryTarPath, { force: true });
  }
};

export const sourceDate = (environment = process.env) => {
  const raw = environment.SOURCE_DATE_EPOCH?.trim();
  if (raw === undefined || raw === "") return "1970-01-01T00:00:00.000Z";
  if (!/^\d+$/.test(raw)) {
    throw new Error("SOURCE_DATE_EPOCH must be a non-negative integer.");
  }
  const date = new Date(Number(raw) * 1000);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("SOURCE_DATE_EPOCH is outside the supported date range.");
  }
  return date.toISOString();
};
