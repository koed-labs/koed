import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadNativeFlock } from "./native-flock.js";

const root = resolve(import.meta.dirname, "../../..");
const scratch = resolve(root, "scratch");
const supported = process.platform === "darwin" || process.platform === "linux";
let dir: string;
let addon: string;
let probe: {
  probe(path: string, helper: string, control: boolean, high?: boolean): number;
  foreign(): object;
};
let failingClose: ReturnType<typeof loadNativeFlock>;
let helper: string;
let flock: ReturnType<typeof loadNativeFlock>;
const require = createRequire(import.meta.url);

describe.skipIf(!supported)("native flock (other platforms unverified)", () => {
  beforeAll(() => {
    mkdirSync(scratch, { recursive: true });
    dir = mkdtempSync(resolve(scratch, "flock-test-"));
    addon = resolve(dir, "flock.node");
    const candidates = process.env.NODE_INCLUDE_DIR
      ? [process.env.NODE_INCLUDE_DIR]
      : [
          resolve(dirname(process.execPath), "../include/node"),
          resolve(dirname(realpathSync(process.execPath)), "../include/node"),
          "/opt/homebrew/include/node",
          "/usr/local/include/node",
          "/usr/include/node"
        ];
    const include = candidates.find((path) =>
      existsSync(resolve(path, "node_api.h"))
    );
    if (!include)
      throw new Error(
        `Node headers not found; set NODE_INCLUDE_DIR (checked: ${candidates.join(", ")})`
      );
    const args =
      process.platform === "darwin"
        ? ["-bundle", "-undefined", "dynamic_lookup"]
        : ["-shared", "-fPIC"];
    execFileSync("cc", [
      ...args,
      `-I${include}`,
      "-DNAPI_VERSION=8",
      "-DNODE_GYP_MODULE_NAME=koed_flock",
      resolve(root, "packages/koed-server/native/flock.c"),
      "-o",
      addon
    ]);
    const failingAddon = resolve(dir, "failing-close.node");
    execFileSync("cc", [
      ...args,
      `-I${include}`,
      "-DNAPI_VERSION=8",
      "-DNODE_GYP_MODULE_NAME=koed_flock",
      resolve(root, "packages/koed-server/test/fixtures/flock-close-failure.c"),
      "-o",
      failingAddon
    ]);
    failingClose = loadNativeFlock(failingAddon);
    const probeSource = resolve(
      root,
      "packages/koed-server/test/fixtures/flock-exec-probe.c"
    );
    const probeAddon = resolve(dir, "probe.node");
    helper = resolve(dir, "probe-helper");
    execFileSync("cc", [
      ...args,
      `-I${include}`,
      "-DNODE_GYP_MODULE_NAME=probe",
      probeSource,
      "-o",
      probeAddon
    ]);
    execFileSync("cc", ["-DPROBE_HELPER", probeSource, "-o", helper]);
    probe = require(probeAddon) as typeof probe;
    flock = loadNativeFlock(addon);
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("keeps authority until release even when another same-inode descriptor closes", () => {
    const path = resolve(dir, "close.lock");
    const lock = flock.tryAcquire(path)!;
    const fd = openSync(path, "r");
    closeSync(fd);
    expect(flock.tryAcquire(path)).toBeNull();
    lock.release();
    lock.release();
    const next = flock.tryAcquire(path);
    expect(next).not.toBeNull();
    next!.release();
  });

  it("rejects foreign wrapped and detached release receivers", () => {
    const lock = flock.tryAcquire(resolve(dir, "receiver.lock"))!;
    expect(() => lock.release.call(probe.foreign())).toThrow(
      /Invalid flock handle/
    );
    expect(() => lock.release.call({})).toThrow(/Invalid flock handle/);
    expect(() => lock.release.call(undefined)).toThrow(/Invalid flock handle/);
    expect(flock.tryAcquire(resolve(dir, "receiver.lock"))).toBeNull();
    lock.release();
  });

  it("rejects unpaired surrogates without aliasing replacement character paths", () => {
    for (const suffix of ["\ud800", "\udfff", "\ud800x", "x\udfff"]) {
      expect(() => flock.tryAcquire(resolve(dir, suffix))).toThrow();
    }
    const valid = flock.tryAcquire(resolve(dir, "\ufffd-\ud83d\ude00"));
    expect(valid).not.toBeNull();
    valid!.release();
  });

  it("exposes syscall operation and errno for open failures", () => {
    try {
      flock.tryAcquire(resolve(dir, "missing-parent", "lock"));
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toMatchObject({
        operation: "open",
        code: "ENOENT",
        errno: expect.any(Number)
      });
    }
  });

  it("reports indeterminate close failure on subsequent releases", () => {
    const lock = failingClose.tryAcquire(resolve(dir, "close-failure.lock"))!;
    process.env.KOED_TEST_FLOCK_CLOSE_FAILURE = "closed";
    try {
      for (let i = 0; i < 2; i++) {
        expect(() => lock.release()).toThrow(
          expect.objectContaining({
            operation: "close",
            code: "EIO",
            errno: expect.any(Number),
            indeterminate: true
          })
        );
      }
    } finally {
      delete process.env.KOED_TEST_FLOCK_CLOSE_FAILURE;
    }
  });

  it("reports cleanup errors without losing the original failure or returning contention", () => {
    const script = `
      const assert = require('node:assert/strict');
      const errno = require('node:os').constants.errno;
      const [normalPath, failingPath, path, scenario] = process.argv.slice(1);
      const normal = require(normalPath), failing = require(failingPath);
      let held;
      if (scenario === 'contention') held = normal.tryAcquire(path);
      if (scenario === 'validation') require('node:fs').writeFileSync(path, '', { mode: 0o644 });
      if (['malloc', 'napi', 'fstat', 'flock'].includes(scenario)) process.env.KOED_TEST_FLOCK_FAILURE = scenario;
      process.env.KOED_TEST_FLOCK_CLOSE_FAILURE = 'open';
      let error;
      try { failing.tryAcquire(path); } catch (caught) { error = caught; }
      assert.ok(error, 'cleanup close failure must throw');
      assert.equal(error.cleanupCode, 'EIO');
      assert.equal(error.cleanupErrno, errno.EIO);
      assert.equal(error.indeterminate, true);
      if (scenario === 'fstat') { assert.equal(error.operation, 'fstat'); assert.equal(error.code, 'EBADF'); assert.equal(error.errno, errno.EBADF); }
      if (scenario === 'flock') { assert.equal(error.operation, 'flock'); assert.equal(error.code, 'ENOLCK'); assert.equal(error.errno, errno.ENOLCK); }
      if (scenario === 'malloc') assert.match(error.message, /Out of memory/);
      if (scenario === 'napi') assert.match(error.message, /N-API lock allocation failed/);
      if (scenario === 'validation') assert.match(error.message, /Unsafe flock file/);
      if (scenario === 'contention') { assert.equal(error.operation, 'flock'); assert.equal(error.errno, errno.EAGAIN); }
      if (scenario === 'malloc' || scenario === 'napi') assert.equal(normal.tryAcquire(path), null);
      if (held) held.release();
    `;
    for (const scenario of [
      "malloc",
      "napi",
      "fstat",
      "flock",
      "validation",
      "contention"
    ]) {
      execFileSync(process.execPath, [
        "-e",
        script,
        addon,
        resolve(dir, "failing-close.node"),
        resolve(dir, `${scenario}-cleanup.lock`),
        scenario
      ]);
    }
  });

  it("keeps contention after a close failure that leaves the descriptor open", () => {
    const script = `
      const assert = require('node:assert/strict');
      const [normalPath, failingPath, path] = process.argv.slice(1);
      const normal = require(normalPath), failing = require(failingPath);
      const lock = failing.tryAcquire(path);
      process.env.KOED_TEST_FLOCK_CLOSE_FAILURE = 'open';
      for (let i = 0; i < 2; i++) assert.throws(() => lock.release(), { operation: 'close', code: 'EIO', indeterminate: true });
      assert.equal(normal.tryAcquire(path), null);
    `;
    execFileSync(process.execPath, [
      "-e",
      script,
      addon,
      resolve(dir, "failing-close.node"),
      resolve(dir, "retained-close.lock")
    ]);
  });

  it("releases an unreachable handle through its finalizer", () => {
    const child = resolve(
      root,
      "packages/koed-server/test/fixtures/native-flock-child.cjs"
    );
    expect(
      execFileSync(
        process.execPath,
        ["--expose-gc", child, addon, resolve(dir, "gc.lock"), "gc"],
        { encoding: "utf8", timeout: 5000 }
      )
    ).toContain("finalized");
  });

  it("closes the owned descriptor across exec, unlike a non-CLOEXEC positive control", () => {
    const path = resolve(dir, "exec.lock");
    const lock = flock.tryAcquire(path)!;
    try {
      expect(probe.probe(path, helper, true)).toBe(1);
      expect(probe.probe(path, helper, false)).toBe(0);
    } finally {
      lock.release();
    }
  });

  it("detects inherited descriptors above 1023", () => {
    const path = resolve(dir, "high-exec.lock");
    const lock = flock.tryAcquire(path)!;
    try {
      expect(probe.probe(path, helper, true, true)).toBe(1);
    } finally {
      lock.release();
    }
  });

  it("rejects a FIFO without blocking", () => {
    const path = resolve(dir, "fifo");
    execFileSync("mkfifo", [path]);
    expect(() =>
      execFileSync(
        process.execPath,
        [
          "-e",
          "require(process.argv[1]).tryAcquire(process.argv[2])",
          addon,
          path
        ],
        { timeout: 2000, stdio: "pipe" }
      )
    ).toThrow(/Unsafe flock file/);
  });

  it("rejects malformed paths and suspicious files rather than reporting contention", () => {
    for (const path of ["", "relative", "/tmp/a\0b"])
      expect(() => flock.tryAcquire(path)).toThrow();
    const target = resolve(dir, "target");
    writeFileSync(target, "", { mode: 0o600 });
    const symlink = resolve(dir, "symlink");
    symlinkSync(target, symlink);
    expect(() => flock.tryAcquire(symlink)).toThrow();
    const hardlink = resolve(dir, "hardlink");
    linkSync(target, hardlink);
    expect(() => flock.tryAcquire(target)).toThrow();
    const wide = resolve(dir, "wide");
    writeFileSync(wide, "", { mode: 0o600 });
    chmodSync(wide, 0o644);
    expect(() => flock.tryAcquire(wide)).toThrow();
    expect(() => flock.tryAcquire(dir)).toThrow();
    expect(() => flock.tryAcquire(resolve(dir, "missing", "lock"))).toThrow();
    expect(() =>
      (require(addon) as typeof flock).tryAcquire(42 as never)
    ).toThrow();
  });

  it("retains contention while stopped and releases after SIGKILL", async () => {
    const path = resolve(dir, "child.lock");
    const child = spawn(
      process.execPath,
      [
        resolve(
          root,
          "packages/koed-server/test/fixtures/native-flock-child.cjs"
        ),
        addon,
        path
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    try {
      await new Promise<void>((resolveReady, reject) => {
        child.stdout.once("data", () => resolveReady());
        child.once("error", reject);
        child.once("exit", () =>
          reject(new Error("child exited before ready"))
        );
      });
      expect(flock.tryAcquire(path)).toBeNull();
      child.kill("SIGSTOP");
      expect(flock.tryAcquire(path)).toBeNull();
      const exited = new Promise<void>((done) =>
        child.once("exit", () => done())
      );
      child.kill("SIGKILL");
      await exited;
      const next = flock.tryAcquire(path);
      expect(next).not.toBeNull();
      next!.release();
    } finally {
      child.kill("SIGKILL");
    }
  });
});

it.skipIf(supported)(
  "native flock platform verification unavailable",
  () => {}
);
