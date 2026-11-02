import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { runScenario, corruptFrame } from "./prototype.mjs";

test("tamper preserves frame type and changes ciphertext, not base64 padding", () => {
  const bytes = Buffer.from([0, 3, 7, 8, 9]);
  const text = bytes.toString("base64");
  const changed = corruptFrame(text);
  assert.equal(typeof changed, "string");
  const decoded = Buffer.from(changed, "base64");
  assert.deepEqual(decoded.subarray(0, 2), bytes.subarray(0, 2));
  assert.notDeepEqual(decoded.subarray(2), bytes.subarray(2));
  assert.ok(
    corruptFrame(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    ) instanceof ArrayBuffer
  );
});

test(
  "process group cleanup kills descendants after leader exits",
  { timeout: 10000 },
  async () => {
    const { stopChild } = await import("./prototype.mjs");
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const { spawn } = require('node:child_process'); const c = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' }); console.log(c.pid); setTimeout(() => process.exit(0), 200);`
      ],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] }
    );
    const pid = Number(
      await new Promise((resolve) =>
        child.stdout.once("data", (data) => resolve(data.toString().trim()))
      )
    );
    await new Promise((resolve) => child.once("exit", resolve));
    try {
      await stopChild(child, true);
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
);

test(
  "Wrangler startup failure cleans up surviving process group",
  { timeout: 12000 },
  () => {
    const dir = mkdtempSync(resolve("../../scratch/paseo-cleanup-"));
    const script = resolve(dir, "node_modules/wrangler/bin/wrangler.js");
    const pidFile = resolve(dir, "pid");
    mkdirSync(resolve(dir, "node_modules/wrangler/bin"), { recursive: true });
    writeFileSync(resolve(dir, "empty.env"), "");
    writeFileSync(
      script,
      `const { spawn } = require('node:child_process'); const fs = require('node:fs'); const c = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' }); fs.writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setTimeout(() => process.exit(1), 300);`
    );
    let pid;
    try {
      const module = new URL("./prototype.mjs", import.meta.url).href;
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { launch } from '${module}'; await launch(12345);`
        ],
        { cwd: dir, encoding: "utf8", timeout: 10000 }
      );
      assert.match(result.stderr, /Wrangler startup failed/);
      pid = Number(readFileSync(pidFile, "utf8"));
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    } finally {
      if (pid)
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  }
);

test("Docker rejects remote endpoint before starting relay", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import { runScenario } from './prototype.mjs'; await runScenario();"
    ],
    {
      env: {
        ...process.env,
        DOCKER_HOST: "tcp://example.com:2375",
        PASEO_RELAY_RUNTIME: "docker"
      },
      encoding: "utf8",
      timeout: 10000
    }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /local Unix socket/);
});

test("missing Docker executable reports startup failure without an unhandled spawn error", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import { runScenario } from './prototype.mjs'; await runScenario();"
    ],
    {
      env: { ...process.env, PATH: "", PASEO_RELAY_RUNTIME: "docker" },
      encoding: "utf8",
      timeout: 10000
    }
  );
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ENOENT/);
  assert.doesNotMatch(result.stderr, /Unhandled 'error' event/);
});

test(
  "real v2 relay protects independent bidirectional traffic and rejects attacks",
  { timeout: 90000 },
  async () => {
    const result = await runScenario();
    assert.deepEqual(result.messages, [
      "alpha request",
      "alpha response",
      "beta request",
      "beta response"
    ]);
    assert.equal(result.mode, "protected");
    assert.equal(result.wrongKeyRejected, true);
    assert.equal(result.tamperRejected, true);
    assert.equal(result.replayRejected, true);
    assert.equal(result.legacyClientRejected, true);
    assert.equal(result.legacyDaemonRejected, true);
  }
);
