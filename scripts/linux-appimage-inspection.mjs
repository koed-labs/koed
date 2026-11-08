import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { createHash } from "node:crypto";

const maxImageBytes = 4 * 1024 ** 3;
const maxHeaders = 4096;
const invalid = () => {
  throw new Error("Invalid or unsupported Linux x64 AppImage.");
};

const openRegularInput = (path) => {
  if (typeof constants.O_NOFOLLOW !== "number") invalid();
  return openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
};

const readAt = (fd, position, size, fileSize) => {
  if (
    !Number.isSafeInteger(position) ||
    position < 0 ||
    position + size > fileSize
  )
    invalid();
  const bytes = Buffer.alloc(size);
  if (readSync(fd, bytes, 0, size, position) !== size) invalid();
  return bytes;
};

const number64 = (bytes, offset) => {
  const value = bytes.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
  return Number(value);
};

const checkRange = (start, size, end) => {
  if (!Number.isSafeInteger(start + size) || start + size > end) invalid();
};

export const verifyAppImageChecksum = ({
  imagePath,
  checksumPath,
  assetName
}) => {
  if (!/^Koed-[0-9A-Za-z.-]+-x86_64\.AppImage$/.test(assetName ?? ""))
    invalid();
  const checksumFd = openRegularInput(checksumPath);
  let checksum;
  try {
    const stat = fstatSync(checksumFd);
    if (!stat.isFile() || stat.size > 256) invalid();
    checksum = readAt(checksumFd, 0, stat.size, stat.size).toString("utf8");
  } finally {
    closeSync(checksumFd);
  }
  const fd = openRegularInput(imagePath);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxImageBytes) invalid();
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (let position = 0; position < stat.size;) {
      const count = readSync(
        fd,
        buffer,
        0,
        Math.min(buffer.length, stat.size - position),
        position
      );
      if (!count) invalid();
      hash.update(buffer.subarray(0, count));
      position += count;
    }
    if (checksum !== `${hash.digest("hex")}  ${assetName}\n`) invalid();
  } finally {
    closeSync(fd);
  }
};

const inspectElf = (fd, fileSize) => {
  const h = readAt(fd, 0, 64, fileSize);
  if (
    !h.subarray(0, 7).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])) ||
    !h.subarray(8, 11).equals(Buffer.from([0x41, 0x49, 2])) ||
    ![2, 3].includes(h.readUInt16LE(16)) ||
    h.readUInt16LE(18) !== 62 ||
    h.readUInt32LE(20) !== 1 ||
    h.readUInt16LE(52) !== 64
  )
    invalid();
  const phoff = number64(h, 32),
    shoff = number64(h, 40);
  const phsize = h.readUInt16LE(54),
    phnum = h.readUInt16LE(56);
  const shsize = h.readUInt16LE(58),
    shnum = h.readUInt16LE(60);
  if (
    !phnum ||
    phnum > maxHeaders ||
    phsize !== 56 ||
    phoff < 64 ||
    !shnum ||
    shnum > maxHeaders ||
    shsize !== 64 ||
    shoff < 64
  )
    invalid();
  const offset = shoff + shsize * shnum;
  checkRange(shoff, shsize * shnum, fileSize);
  checkRange(phoff, phsize * phnum, offset);
  const programs = readAt(fd, phoff, phsize * phnum, fileSize);
  for (let i = 0; i < phnum; i++) {
    const p = programs.subarray(i * phsize, (i + 1) * phsize);
    checkRange(number64(p, 8), number64(p, 32), offset);
  }
  const sections = readAt(fd, shoff, shsize * shnum, fileSize);
  for (let i = 0; i < shnum; i++) {
    const s = sections.subarray(i * shsize, (i + 1) * shsize);
    if (s.readUInt32LE(4) !== 8)
      checkRange(number64(s, 24), number64(s, 32), offset);
  }
  return offset;
};

/** Parse untrusted bytes only; this does not extract or execute an AppImage. */
export const inspectAppImageHeader = (path) => {
  const fd = openRegularInput(path);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxImageBytes) invalid();
    const offset = inspectElf(fd, stat.size);
    const superblock = readAt(fd, offset, 96, stat.size);
    if (superblock.toString("ascii", 0, 4) !== "hsqs") invalid();
    const size = number64(superblock, 40);
    if (size < 96) invalid();
    checkRange(offset, size, stat.size);
    return { offset, size };
  } finally {
    closeSync(fd);
  }
};
