import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveKoedServerPaths } from "./paths.js";
import {
  upstreamEnrollmentLockTarget,
  withUpstreamEnrollmentLock
} from "./upstream-enrollment-lock.js";

const temps: string[] = [];

const waitFor = async (condition: () => boolean): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for child-process lock state.");
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
};

afterEach(() => {
  for (const path of temps.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("upstream enrollment mutation lock", () => {
  it("serializes mutation phases across processes", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-enrollment-lock-"));
    temps.push(root);
    const paths = resolveKoedServerPaths({
      KOED_HOME: root,
      KOED_REPO_ROOT: root
    });
    const target = upstreamEnrollmentLockTarget(paths, "team-vps");
    const attemptedPath = resolve(root, "child-attempted");
    const acquiredPath = resolve(root, "child-acquired");
    let childExit: Promise<number | null> | undefined;

    await withUpstreamEnrollmentLock(paths, "team-vps", async () => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          `const fs = require("node:fs");
const lockfile = require("proper-lockfile");
const [target, attempted, acquired] = process.argv.slice(1);
fs.writeFileSync(attempted, "attempted");
lockfile.lock(target, {
  realpath: false,
  stale: 30000,
  update: 10000,
  retries: { retries: 100, factor: 1, minTimeout: 25, maxTimeout: 100 }
}).then(async (release) => {
  fs.writeFileSync(acquired, "acquired");
  await release();
}).catch(() => process.exitCode = 1);`,
          target,
          attemptedPath,
          acquiredPath
        ],
        { cwd: resolve(import.meta.dirname, ".."), stdio: "ignore" }
      );
      childExit = new Promise((resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("exit", resolveExit);
      });

      await waitFor(() => existsSync(attemptedPath));
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      expect(existsSync(acquiredPath)).toBe(false);
    });

    await expect(childExit).resolves.toBe(0);
    expect(existsSync(acquiredPath)).toBe(true);
  });
});
