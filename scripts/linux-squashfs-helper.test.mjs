import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  linkSync,
  symlinkSync,
  chmodSync
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
    chmodSync(dir, 0o755);
    const run = (args) => {
      const name = `koed-sqfs-test-${randomUUID()}`;
      const call = (args) => {
        const result = spawnSync("docker", args, {
          timeout: 30000,
          maxBuffer: 2 * 1024 * 1024
        });
        if (result.error || result.signal || result.status !== 0)
          throw new Error(
            `Docker ${args[0]} failed: ${result.error || result.stderr?.toString()}`
          );
        return result.stdout;
      };
      try {
        call([
          "create",
          "--name",
          name,
          "--platform",
          "linux/amd64",
          "--network",
          "none",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--user",
          "65534:65534",
          "--memory",
          "512m",
          "--cpus",
          "1",
          "--pids-limit",
          "64",
          "--log-driver",
          "local",
          "--log-opt",
          "max-size=2m",
          "--log-opt",
          "max-file=1",
          "--log-opt",
          "compress=false",
          "--mount",
          `type=bind,src=${dir},dst=/work,readonly`,
          "--entrypoint",
          "/work/helper",
          image,
          ...args
        ]);
        call(["start", name]);
        const status = call(["wait", name]).toString().trim();
        assert.match(status, /^(0|1)$/);
        const logs = spawnSync("docker", ["logs", name], {
          timeout: 30000,
          maxBuffer: 2 * 1024 * 1024
        });
        if (logs.error || logs.signal || logs.status !== 0)
          throw new Error(`Docker logs failed: ${logs.error}`);
        return {
          status: Number(status),
          stdout: logs.stdout,
          stderr: logs.stderr
        };
      } finally {
        const cleanup = spawnSync("docker", ["rm", "-f", name], {
          timeout: 10000
        });
        if (cleanup.error || cleanup.signal || cleanup.status !== 0)
          throw new Error(
            `Docker cleanup failed for ${name}: ${cleanup.error || cleanup.stderr?.toString()}`
          );
      }
    };
    const rejects = (result) => {
      assert.equal(result.status, 1);
      assert.equal(result.stdout.length, 0);
      assert.equal(result.stderr.toString(), "SquashFS inspection failed.\n");
    };
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
      result = run(["/work/fs", "11"]);
      assert.equal(result.status, 0, result.stderr.toString());
      assert.deepEqual(result.stdout, Buffer.from("asar bytes\0"));
      result = run(["/work/fs", "10"]);
      rejects(result);
      result = run(["/work/fs", "5"]);
      rejects(result);
      linkSync(resolve(root, "resources/app.asar"), resolve(root, "other"));
      make();
      result = run(["/work/fs", "1024"]);
      rejects(result);
      rmSync(resolve(root, "other"));
      rmSync(resolve(root, "resources/app.asar"));
      symlinkSync("/etc/passwd", resolve(root, "resources/app.asar"));
      make();
      result = run(["/work/fs", "1024"]);
      rejects(result);
      rmSync(resolve(root, "resources/app.asar"));
      writeFileSync(resolve(root, "resources/app.asar"), "asar bytes\0");
      writeFileSync(resolve(root, "resources/zzz.asar"), "other");
      make();
      const fs = readFileSync(resolve(dir, "fs"));
      const appPos = fs.indexOf(Buffer.from("app.asar"));
      assert.notEqual(appPos, -1);
      assert.equal(fs.indexOf(Buffer.from("app.asar"), appPos + 1), -1);
      const wrongType = Buffer.from(fs);
      assert.equal(wrongType.readUInt16LE(appPos - 4), 2);
      wrongType.writeUInt16LE(1, appPos - 4);
      writeFileSync(resolve(dir, "fs"), wrongType);
      result = run(["/work/fs", "1024"]);
      rejects(result);
      const pos = fs.indexOf(Buffer.from("zzz.asar"));
      assert.notEqual(pos, -1);
      assert.equal(fs.indexOf(Buffer.from("zzz.asar"), pos + 1), -1);
      assert.equal(fs.readUInt16LE(pos - 4), 2);
      Buffer.from("app.asar").copy(fs, pos);
      writeFileSync(resolve(dir, "fs"), fs);
      result = run(["/work/fs", "1024"]);
      rejects(result);
      writeFileSync(resolve(dir, "fs"), fs.subarray(0, 96));
      result = run(["/work/fs", "1024"]);
      rejects(result);
      make();
      result = run(["/work/fs", "0"]);
      rejects(result);
      rmSync(resolve(root, "resources/zzz.asar"));
      let deep = root;
      for (let i = 0; i < 66; i++) {
        deep = resolve(deep, "d");
        mkdirSync(deep);
      }
      make();
      result = run(["/work/fs", "1024"]);
      rejects(result);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
);
