import {
  mkdtempSync,
  realpathSync,
  rmSync,
  chmodSync,
  symlinkSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  tryAcquireOwnershipLock,
  type OwnershipLockAddon
} from "./ownership-lock.js";

const require = createRequire(import.meta.url);
const addonPath = process.env.KOED_OWNERSHIP_LOCK_TEST_ADDON;
const directories: string[] = [];
const directory = () => {
  const path = mkdtempSync(join(realpathSync(tmpdir()), "koed-lock-"));
  directories.push(path);
  return path;
};
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe("ownership lock release failures", () => {
  it("does not retry a release with an indeterminate result", () => {
    let calls = 0;
    const lock = tryAcquireOwnershipLock(
      {
        tryAcquireOwnershipLock: () => 1,
        releaseOwnershipLock: () => {
          calls++;
          throw new Error("close failed");
        }
      },
      "/private/test"
    );
    expect(() => lock!.release()).toThrow("close failed");
    expect(() => lock!.release()).toThrow(
      "Ownership lock release result is indeterminate."
    );
    expect(calls).toBe(1);
  });
});

describe.skipIf(process.platform !== "darwin" || !addonPath)(
  "ownership lock",
  () => {
    let addon: OwnershipLockAddon;
    beforeAll(() => {
      if (!addonPath)
        throw new Error("KOED_OWNERSHIP_LOCK_TEST_ADDON is required");
      addon = require(addonPath) as OwnershipLockAddon;
      expect(typeof addon.tryAcquireOwnershipLock).toBe("function");
      expect(typeof addon.releaseOwnershipLock).toBe("function");
    });
    it("excludes another owner until explicit release", () => {
      const path = directory();
      const first = tryAcquireOwnershipLock(addon, path);
      expect(first).not.toBeNull();
      expect(tryAcquireOwnershipLock(addon, path)).toBeNull();
      first!.release();
      const second = tryAcquireOwnershipLock(addon, path);
      expect(second).not.toBeNull();
      second!.release();
    });
    it("rejects insecure directories and symlink lock files", () => {
      const path = directory();
      chmodSync(path, 0o755);
      expect(() => tryAcquireOwnershipLock(addon, path)).toThrow(
        "Ownership lock directory is not private and local."
      );
      chmodSync(path, 0o700);
      symlinkSync("missing", join(path, "runtime-ownership.lock"));
      expect(() => tryAcquireOwnershipLock(addon, path)).toThrow(
        "Cannot open ownership lock file."
      );
    });
    it("releases locks when their Node environment exits", async () => {
      const path = directory();
      const { Worker } = await import("node:worker_threads");
      const worker = new Worker(
        `const { parentPort, workerData } = require('node:worker_threads'); const addon = require(workerData.addon); const handle = addon.tryAcquireOwnershipLock(workerData.path); if (handle === null) throw new Error('worker did not acquire lock'); parentPort.postMessage('ready');`,
        { eval: true, workerData: { addon: addonPath, path } }
      );
      await new Promise<void>((resolve, reject) => {
        worker.once("message", () => resolve());
        worker.once("error", reject);
      });
      await worker.terminate();
      const lock = tryAcquireOwnershipLock(addon, path);
      expect(lock).not.toBeNull();
      lock!.release();
    });
    it("keeps XPC constructors usable after another environment exits", async () => {
      const script = `const { Worker } = require('node:worker_threads'); const assert = require('node:assert'); const addon = require(process.argv[1]); const w = new Worker("require(require('node:worker_threads').workerData);", {eval:true, workerData:process.argv[1]}); w.on('exit', code => { assert.equal(code, 0); assert.throws(() => addon.connect(1, 2), /Invalid Background Agent connection arguments/); });`;
      const child = spawn(process.execPath, ["-e", script, addonPath!], {
        stdio: "pipe"
      });
      const errors: Buffer[] = [];
      child.stderr.on("data", (data: Buffer) => errors.push(data));
      const result = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      expect(result, Buffer.concat(errors).toString()).toEqual({
        code: 0,
        signal: null
      });
    });
    it("releases after owner process death", async () => {
      const path = directory();
      const script = `const a = require(process.argv[1]); const h = a.tryAcquireOwnershipLock(process.argv[2]); if (!h) process.exit(2); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`;
      const child = spawn(process.execPath, ["-e", script, addonPath!, path], {
        stdio: ["ignore", "pipe", "pipe"]
      });
      try {
        await new Promise<void>((resolve, reject) => {
          child.stdout.once("data", () => resolve());
          child.once("error", reject);
          child.once("exit", (code) =>
            reject(new Error(`child exited: ${code}`))
          );
        });
        expect(tryAcquireOwnershipLock(addon, path)).toBeNull();
        child.kill("SIGKILL");
        await new Promise<void>((resolve) =>
          child.once("exit", () => resolve())
        );
        const lock = tryAcquireOwnershipLock(addon, path);
        expect(lock).not.toBeNull();
        lock!.release();
      } finally {
        child.kill("SIGKILL");
      }
    });
  }
);
