import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const node24 = process.execPath;

test("global npm install runs koed help outside checkout without network", () => {
  const scratch = mkdtempSync(resolve(tmpdir(), "koed packed smoke "));
  try {
    const output = resolve(scratch, "build output");
    execFileSync(
      node24,
      [
        resolve(repoRoot, "scripts/build-public-server-package.mjs"),
        "--out-dir",
        output
      ],
      {
        cwd: repoRoot,
        stdio: "pipe"
      }
    );
    const tarball = resolve(output, "tarballs", "koed-labs-server.tgz");
    const prefix = resolve(scratch, "global prefix with spaces");
    const outside = resolve(scratch, "outside checkout");
    const requestLog = resolve(scratch, "network requests.log");
    const preload = resolve(scratch, "network-guard.mjs");
    mkdirSync(outside, { recursive: true });
    writeFileSync(requestLog, "");
    writeFileSync(
      preload,
      `import { appendFileSync } from "node:fs";\nconst originalFetch = globalThis.fetch;\nglobalThis.fetch = (...args) => { appendFileSync(${JSON.stringify(requestLog)}, String(args[0]) + "\\n"); return originalFetch(...args); };\n`
    );
    execFileSync(
      "npm",
      ["install", "--global", "--prefix", prefix, "--offline", tarball],
      {
        cwd: outside,
        env: {
          ...process.env,
          npm_config_offline: "true",
          npm_config_registry: "http://127.0.0.1:1"
        },
        stdio: "pipe"
      }
    );
    const executable = resolve(prefix, "bin", "koed");
    const cleanEnvironment = {
      PATH: `${resolve(prefix, "bin")}${delimiter}${dirname(node24)}${delimiter}${process.env.PATH ?? ""}`,
      HOME: resolve(scratch, "home"),
      TMPDIR: tmpdir(),
      NODE_OPTIONS: `--import="${preload}"`,
      npm_config_offline: "true",
      npm_config_registry: "http://127.0.0.1:1"
    };
    const runKoed = (args) =>
      spawnSync(executable, args, {
        cwd: outside,
        env: cleanEnvironment,
        encoding: "utf8"
      });
    const help = runKoed(["--help"]);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage: koed /);
    assert.ok(!help.stdout.includes(repoRoot));
    const systemNode = spawnSync("node", ["--version"], { encoding: "utf8" });
    if (!/^v24\./.test(systemNode.stdout.trim())) {
      const unsupported = spawnSync("node", [executable, "--help"], {
        cwd: outside,
        env: { ...cleanEnvironment, PATH: process.env.PATH ?? "" },
        encoding: "utf8"
      });
      assert.equal(unsupported.status, 1, unsupported.stderr);
      assert.match(unsupported.stderr, /requires Node\.js >=24 <25/);
    }
    const models = runKoed(["models", "status", "--json"]);
    assert.equal(models.status, 0, models.stderr);
    assert.doesNotThrow(() => JSON.parse(models.stdout));
    const runtime = runKoed(["runtime", "status", "--json"]);
    assert.ok([0, 1].includes(runtime.status), runtime.stderr);
    assert.doesNotThrow(() => JSON.parse(runtime.stdout));
    assert.equal(readFileSync(requestLog, "utf8"), "");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
