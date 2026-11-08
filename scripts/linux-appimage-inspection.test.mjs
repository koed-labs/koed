import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  inspectAppImageHeader,
  verifyAppImageChecksum
} from "./linux-appimage-inspection.mjs";
import { createHash } from "node:crypto";

// A minimal ELF64 AppImage header and SquashFS superblock, never executable.
const image = () => {
  const bytes = Buffer.alloc(416);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0x41, 0x49, 2]);
  bytes.writeUInt16LE(3, 16);
  bytes.writeUInt16LE(62, 18);
  bytes.writeUInt32LE(1, 20);
  bytes.writeBigUInt64LE(64n, 32);
  bytes.writeBigUInt64LE(192n, 40);
  bytes.writeUInt16LE(64, 52);
  bytes.writeUInt16LE(56, 54);
  bytes.writeUInt16LE(1, 56);
  bytes.writeUInt16LE(64, 58);
  bytes.writeUInt16LE(2, 60);
  bytes.writeBigUInt64LE(192n, 64 + 32);
  bytes.writeUInt32LE(1, 192 + 64 + 4);
  bytes.writeBigUInt64LE(120n, 192 + 64 + 24);
  bytes.writeBigUInt64LE(72n, 192 + 64 + 32);
  bytes.write("hsqs", 320);
  bytes.writeBigUInt64LE(96n, 320 + 40);
  return bytes;
};

const withImage = (bytes, action) => {
  mkdirSync("scratch", { recursive: true });
  const dir = mkdtempSync(resolve("scratch/appimage-header-"));
  try {
    const path = resolve(dir, "candidate.AppImage");
    writeFileSync(path, bytes);
    return action(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("finds SquashFS after bounded x64 ELF section table without executing image", () => {
  withImage(image(), (path) =>
    assert.deepEqual(inspectAppImageHeader(path), { offset: 320, size: 96 })
  );
});

test("rejects symlink AppImage and checksum paths", () => {
  withImage(image(), (path) => {
    const link = resolve(path, "../link");
    const checksum = resolve(path, "../checksum");
    symlinkSync(path, link);
    writeFileSync(checksum, "checksum");
    assert.throws(() => inspectAppImageHeader(link));
    assert.throws(() =>
      verifyAppImageChecksum({
        imagePath: link,
        checksumPath: checksum,
        assetName: "Koed-1.2.3-x86_64.AppImage"
      })
    );
    assert.throws(() =>
      verifyAppImageChecksum({
        imagePath: path,
        checksumPath: link,
        assetName: "Koed-1.2.3-x86_64.AppImage"
      })
    );
  });
});

test("verifies exact checksum filename and actual AppImage bytes", () => {
  const bytes = image();
  withImage(bytes, (path) => {
    const checksum = resolve(path, "../checksum");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const name = "Koed-1.2.3-x86_64.AppImage";
    writeFileSync(checksum, `${digest}  ${name}\n`);
    assert.doesNotThrow(() =>
      verifyAppImageChecksum({
        imagePath: path,
        checksumPath: checksum,
        assetName: name
      })
    );
    for (const line of [
      `${digest}  other.AppImage\n`,
      `${digest}  ${name}\nextra\n`,
      `${"0".repeat(64)}  ${name}\n`
    ]) {
      writeFileSync(checksum, line);
      assert.throws(() =>
        verifyAppImageChecksum({
          imagePath: path,
          checksumPath: checksum,
          assetName: name
        })
      );
    }
    writeFileSync(checksum, `${digest}  ${name}\n`);
    writeFileSync(path, Buffer.from("modified"));
    assert.throws(() =>
      verifyAppImageChecksum({
        imagePath: path,
        checksumPath: checksum,
        assetName: name
      })
    );
  });
});

for (const [name, damage] of [
  ["ELF magic", (b) => b.writeUInt8(0, 0)],
  ["AppImage type", (b) => b.writeUInt8(1, 10)],
  ["32-bit", (b) => b.writeUInt8(1, 4)],
  ["big endian", (b) => b.writeUInt8(2, 5)],
  ["architecture", (b) => b.writeUInt16LE(183, 18)],
  ["ELF type", (b) => b.writeUInt16LE(1, 16)],
  ["section table outside file", (b) => b.writeBigUInt64LE(400n, 40)],
  ["oversized section table", (b) => b.writeUInt16LE(65535, 60)],
  [
    "section overlapping filesystem",
    (b) => b.writeBigUInt64LE(300n, 192 + 64 + 32)
  ],
  ["segment overlapping filesystem", (b) => b.writeBigUInt64LE(400n, 64 + 32)],
  ["SquashFS magic", (b) => b.write("bad!", 320)],
  ["truncated SquashFS", (b) => b.writeBigUInt64LE(97n, 320 + 40)],
  ["oversized integer", (b) => b.writeBigUInt64LE(2n ** 63n, 40)]
]) {
  test(`rejects malformed ${name}`, () => {
    const bytes = image();
    damage(bytes);
    withImage(bytes, (path) =>
      assert.throws(() => inspectAppImageHeader(path))
    );
  });
}
