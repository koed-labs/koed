import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
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
  if (kind === "hardlink") {
    writeFileSync(resolve(root, "resources/app.asar"), "asar bytes\0");
    linkSync(resolve(root, "resources/app.asar"), resolve(root, "other"));
  }
  if (kind === "parent-symlink") {
    rmSync(resolve(root, "resources"), { recursive: true });
    mkdirSync(resolve(root, "elsewhere"));
    writeFileSync(resolve(root, "elsewhere/app.asar"), "asar bytes\0");
    symlinkSync("elsewhere", resolve(root, "resources"));
  }
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

test("requires digest matching the candidate snapshot", integration, () => {
  const { dir, candidate } = fixture("regular");
  try {
    for (const expectedSha256 of [undefined, "0".repeat(64)]) {
      assert.throws(
        () =>
          extractAppImageAsar({ imagePath: candidate, image, expectedSha256 }),
        /digest/i
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "uses digest-bound snapshot when original changes before Docker starts",
  integration,
  () => {
    const { dir, candidate } = fixture("regular");
    const digest = createHash("sha256")
      .update(readFileSync(candidate))
      .digest("hex");
    const docker = execFileSync("which", ["docker"], {
      encoding: "utf8"
    }).trim();
    const bin = resolve(dir, "bin");
    mkdirSync(bin);
    const wrapper = resolve(bin, "docker");
    writeFileSync(
      wrapper,
      `#!/bin/sh\nif [ "$1" = run ]; then printf corrupted > "${candidate}"; fi\nexec "${docker}" "$@"\n`
    );
    chmodSync(wrapper, 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      assert.throws(
        () =>
          extractAppImageAsar({
            imagePath: candidate,
            image,
            expectedSha256: digest
          }),
        /cannot verify SquashFS directory uniqueness/
      );
      assert.equal(readFileSync(candidate, "utf8"), "corrupted");
    } finally {
      process.env.PATH = path;
      rmSync(dir, { recursive: true, force: true });
    }
  }
);

test("reports Docker cleanup failure", integration, () => {
  const { dir, candidate } = fixture("regular");
  const docker = execFileSync("which", ["docker"], { encoding: "utf8" }).trim();
  const bin = resolve(dir, "bin");
  mkdirSync(bin);
  const wrapper = resolve(bin, "docker");
  writeFileSync(
    wrapper,
    `#!/bin/sh\nif [ "$1" = rm ]; then "${docker}" "$@" >/dev/null 2>&1; exit 42; fi\nexec "${docker}" "$@"\n`
  );
  chmodSync(wrapper, 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    assert.throws(
      () =>
        extractAppImageAsar({
          imagePath: candidate,
          image,
          expectedSha256: createHash("sha256")
            .update(readFileSync(candidate))
            .digest("hex")
        }),
      (error) =>
        error instanceof AggregateError &&
        /cleanup/i.test(error.message) &&
        error.errors.some((cause) =>
          /cannot verify SquashFS directory uniqueness/.test(cause.message)
        )
    );
  } finally {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const kind of [
  "regular",
  "missing",
  "symlink",
  "fifo",
  "oversize",
  "hardlink",
  "parent-symlink"
]) {
  test(`static extraction handles ${kind} ASAR`, integration, () => {
    const { dir, candidate } = fixture(kind);
    try {
      const run = () =>
        extractAppImageAsar({
          imagePath: candidate,
          image,
          expectedSha256: createHash("sha256")
            .update(readFileSync(candidate))
            .digest("hex"),
          maxAsarBytes: 1024
        });
      if (kind === "regular" || kind === "hardlink")
        assert.throws(run, /cannot verify SquashFS directory uniqueness/);
      else assert.throws(run);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
