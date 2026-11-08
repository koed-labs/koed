import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { extractAppImageAsar } from "./linux-appimage-extractor.mjs";

const image = process.env.KOED_SQUASHFS_TEST_IMAGE;
const integration = {
  skip:
    !image &&
    "Set KOED_SQUASHFS_TEST_IMAGE to a locally built squashfs-tools image"
};

function fixture(kind) {
  mkdirSync("scratch", { recursive: true });
  const dir = mkdtempSync(resolve("scratch/squashfs-fixture-"));
  const root = resolve(dir, "root");
  mkdirSync(resolve(root, "resources"), { recursive: true });
  if (kind === "regular")
    writeFileSync(resolve(root, "resources/app.asar"), "asar bytes\0");
  if (kind === "symlink")
    symlinkSync("/etc/passwd", resolve(root, "resources/app.asar"));
  if (kind === "oversize")
    writeFileSync(resolve(root, "resources/app.asar"), Buffer.alloc(1025));
  if (kind === "fifo")
    execFileSync("mkfifo", [resolve(root, "resources/app.asar")]);
  execFileSync("docker", [
    "run",
    "--rm",
    "--platform",
    "linux/amd64",
    "--network",
    "none",
    "--volume",
    `${dir}:/work`,
    "--entrypoint",
    "mksquashfs",
    image,
    "/work/root",
    "/work/fs",
    "-noappend",
    "-processors",
    "1"
  ]);
  const header = Buffer.alloc(320);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0x41, 0x49, 2]);
  header.writeUInt16LE(3, 16);
  header.writeUInt16LE(62, 18);
  header.writeUInt32LE(1, 20);
  header.writeBigUInt64LE(64n, 32);
  header.writeBigUInt64LE(192n, 40);
  header.writeUInt16LE(64, 52);
  header.writeUInt16LE(56, 54);
  header.writeUInt16LE(1, 56);
  header.writeUInt16LE(64, 58);
  header.writeUInt16LE(2, 60);
  header.writeBigUInt64LE(192n, 96);
  const candidate = resolve(dir, "candidate");
  writeFileSync(
    candidate,
    Buffer.concat([header, readFileSync(resolve(dir, "fs"))])
  );
  return { dir, candidate };
}

test("rejects missing or unsafe trusted image references", () => {
  for (const image of [
    undefined,
    "",
    "--privileged",
    "image name",
    "image\nother"
  ]) {
    assert.throws(() => extractAppImageAsar({ imagePath: "/missing", image }));
  }
});

for (const kind of ["regular", "missing", "symlink", "fifo", "oversize"]) {
  test(`static extraction handles ${kind} ASAR`, integration, () => {
    const { dir, candidate } = fixture(kind);
    try {
      const run = () =>
        extractAppImageAsar({
          imagePath: candidate,
          image,
          maxAsarBytes: 1024
        });
      if (kind === "regular")
        assert.deepEqual(run(), Buffer.from("asar bytes\0"));
      else assert.throws(run);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
