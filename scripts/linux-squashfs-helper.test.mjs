import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  linkSync,
  symlinkSync
} from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const image = process.env.KOED_SQUASHFS_DEV_IMAGE;

test(
  "bounded helper reads only unique regular ASAR from raw SquashFS",
  {
    skip:
      !image &&
      "Set KOED_SQUASHFS_DEV_IMAGE to an image with gcc, libsquashfs-dev and squashfs-tools"
  },
  () => {
    mkdirSync("scratch", { recursive: true });
    const dir = mkdtempSync(resolve("scratch/sqfs-helper-"));
    const run = (args) =>
      spawnSync(
        "docker",
        [
          "run",
          "--rm",
          "--platform",
          "linux/amd64",
          "--network",
          "none",
          "--memory",
          "512m",
          "--pids-limit",
          "64",
          "-v",
          `${dir}:/work`,
          "--entrypoint",
          "/work/helper",
          image,
          ...args
        ],
        { timeout: 30000 }
      );
    const docker = (args) =>
      execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "--platform",
          "linux/amd64",
          "--network",
          "none",
          "-v",
          `${dir}:/work`,
          ...args
        ],
        { stdio: "ignore", timeout: 30000 }
      );
    const root = resolve(dir, "root");
    try {
      writeFileSync(
        resolve(dir, "helper.c"),
        readFileSync("scripts/linux-squashfs-helper.c")
      );
      docker([
        "--entrypoint",
        "gcc",
        image,
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "/work/helper.c",
        "-lsquashfs",
        "-o",
        "/work/helper"
      ]);
      const make = () =>
        docker([
          "--entrypoint",
          "mksquashfs",
          image,
          "/work/root",
          "/work/fs",
          "-noappend",
          "-processors",
          "1",
          "-noI",
          "-noD",
          "-noF"
        ]);
      mkdirSync(resolve(root, "resources"), { recursive: true });
      writeFileSync(resolve(root, "resources/app.asar"), "asar bytes\0");
      make();
      let result = run(["/work/fs", "1024"]);
      assert.equal(result.status, 0, result.stderr.toString());
      assert.deepEqual(result.stdout, Buffer.from("asar bytes\0"));
      docker([
        "--entrypoint",
        "mksquashfs",
        image,
        "/work/root",
        "/work/fs",
        "-noappend",
        "-processors",
        "1"
      ]);
      result = run(["/work/fs", "1024"]);
      assert.equal(result.status, 0, result.stderr.toString());
      assert.deepEqual(result.stdout, Buffer.from("asar bytes\0"));
      result = run(["/work/fs", "5"]);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout.length, 0);
      linkSync(resolve(root, "resources/app.asar"), resolve(root, "other"));
      make();
      result = run(["/work/fs", "1024"]);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout.length, 0);
      rmSync(resolve(root, "other"));
      rmSync(resolve(root, "resources/app.asar"));
      symlinkSync("/etc/passwd", resolve(root, "resources/app.asar"));
      make();
      result = run(["/work/fs", "1024"]);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout.length, 0);
      rmSync(resolve(root, "resources/app.asar"));
      writeFileSync(resolve(root, "resources/app.asar"), "asar bytes\0");
      writeFileSync(resolve(root, "resources/zzz.asar"), "other");
      make();
      const fs = readFileSync(resolve(dir, "fs"));
      const pos = fs.indexOf(Buffer.from("zzz.asar"));
      assert.notEqual(pos, -1);
      Buffer.from("app.asar").copy(fs, pos);
      writeFileSync(resolve(dir, "fs"), fs);
      result = run(["/work/fs", "1024"]);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout.length, 0);
      writeFileSync(resolve(dir, "fs"), fs.subarray(0, 96));
      result = run(["/work/fs", "1024"]);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout.length, 0);
      make();
      result = run(["/work/fs", "0"]);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout.length, 0);
      rmSync(resolve(root, "resources/zzz.asar"));
      let deep = root;
      for (let i = 0; i < 66; i++) {
        deep = resolve(deep, "d");
        mkdirSync(deep);
      }
      make();
      result = run(["/work/fs", "1024"]);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
);
