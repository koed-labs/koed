#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { validatedElectronRuntime } from "./koed-component-runtime-policy.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (
    !new Set([
      "--release-dir",
      "--electron-bin",
      "--privacy-transformers-cache"
    ]).has(name) ||
    !value
  )
    throw new Error(`Unknown or incomplete option: ${name}`);
  options.set(name, value);
}
const releaseDir = resolve(options.get("--release-dir") ?? "");
if (!options.has("--release-dir"))
  throw new Error(
    "Provide --release-dir with the assembled component release."
  );
const releaseRelative = relative(repoRoot, releaseDir);
if (
  !isAbsolute(releaseRelative) &&
  !releaseRelative.startsWith(`..${sep}`) &&
  releaseRelative !== ".."
)
  throw new Error("The assembled release must be outside the source checkout.");
const electronBin = resolve(
  options.get("--electron-bin") ??
    resolve(
      repoRoot,
      "apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
    )
);
const distributionPath = readdirSync(releaseDir)
  .filter((name) => /^koed-distribution-.*\.json$/.test(name))
  .map((name) => resolve(releaseDir, name));
assert.equal(distributionPath.length, 1, "expected one distribution manifest");
const distribution = JSON.parse(readFileSync(distributionPath[0], "utf8"));
for (const component of ["base", "privacy"]) {
  const artifact = distribution.components[component];
  const manifest = JSON.parse(
    readFileSync(resolve(releaseDir, artifact.manifest), "utf8")
  );
  assert.ok(
    manifest.runtimes.some(
      (runtime) =>
        runtime.kind === "node" &&
        runtime.runtimeRange === ">=24 <25" &&
        runtime.modulesAbi === "137"
    ),
    `${component} is missing the Node 24.14.0 compatibility record`
  );
  assert.ok(
    manifest.runtimes.some(
      (runtime) =>
        runtime.kind === "electron" &&
        runtime.runtimeRange === `=${validatedElectronRuntime.version}` &&
        runtime.nodeRange === `=${validatedElectronRuntime.nodeVersion}` &&
        runtime.modulesAbi === validatedElectronRuntime.modulesAbi &&
        runtime.minimumNapi === validatedElectronRuntime.napiVersion
    ),
    `${component} is missing the measured Electron compatibility record`
  );
}

const nativeSmoke = String.raw`
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = process.argv[2];
const base = createRequire(path.join(root, 'components/base/package.json'));
const privacy = createRequire(path.join(root, 'components/privacy/package.json'));
(async () => {
  const argon2 = base('argon2');
  const hash = await argon2.hash('compatibility-fixture', { type: argon2.argon2id });
  assert.equal(await argon2.verify(hash, 'compatibility-fixture'), true);
  assert.equal(await argon2.verify(hash, 'wrong-fixture'), false);
  const sharp = privacy('sharp');
  const png = await sharp({ create: { width: 2, height: 3, channels: 4, background: '#336699' } }).png().toBuffer();
  assert.deepEqual(await sharp(png).metadata().then(({width,height}) => [width,height]), [2,3]);
  const onnx = privacy('onnxruntime-node');
  assert.equal(typeof onnx.InferenceSession.create, 'function');
  const msgpackr = base('msgpackr');
  const value = { id: 7, name: 'native-addon-fixture', values: [1, 2, 3] };
  const packr = new msgpackr.Packr({ useRecords: false });
  assert.deepEqual(packr.unpack(packr.pack(value)), value);
  const pty = base('node-pty');
  const terminal = pty.spawn('/bin/sh', ['-c', 'printf koed-pty-ok; exit 7'], { name: 'xterm-color', cols: 80, rows: 24, cwd: path.dirname(root), env: process.env });
  let output = '';
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { terminal.kill(); reject(new Error('PTY timeout')); }, 5000);
    terminal.onData((chunk) => { output += chunk; });
    terminal.onExit((event) => { clearTimeout(timeout); resolve(event); });
  });
  assert.match(output, /koed-pty-ok/);
  assert.equal(result.exitCode, 7);
  console.log(JSON.stringify({ok:true,checks:['argon2 hash/verify','sharp image encode/decode','onnxruntime addon load','msgpackr pack/unpack','node-pty terminal IO/exit']}));
})().catch((error) => { console.error(error); process.exitCode = 1; });
`;
const scratch = mkdtempSync(resolve(tmpdir(), "koed-component-runtime-"));
const nativeSmokePath = resolve(scratch, "native-smoke.cjs");
writeFileSync(nativeSmokePath, nativeSmoke);
const run = (executable, args, env = process.env) => {
  const result = spawnSync(executable, args, {
    cwd: scratch,
    encoding: "utf8",
    env,
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${executable} ${args.join(" ")} failed (${result.status}): ${result.stderr}\n${result.stdout}`
    );
  return JSON.parse(result.stdout.trim());
};

let completed = false;
try {
  const electronIdentity = run(
    electronBin,
    [
      "-p",
      "JSON.stringify({electron:process.versions.electron,node:process.versions.node,modules:process.versions.modules,napi:Number(process.versions.napi),platform:process.platform,arch:process.arch})"
    ],
    { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
  );
  assert.deepEqual(
    {
      version: electronIdentity.electron,
      nodeVersion: electronIdentity.node,
      modulesAbi: electronIdentity.modules,
      napiVersion: electronIdentity.napi
    },
    validatedElectronRuntime
  );
  const nodeResult = run(process.execPath, [nativeSmokePath, releaseDir]);
  const electronResult = run(electronBin, [nativeSmokePath, releaseDir], {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1"
  });
  const nodeIdentity = {
    node: process.versions.node,
    modules: process.versions.modules,
    napi: Number(process.versions.napi),
    platform: process.platform,
    arch: process.arch
  };
  let inference;
  if (options.has("--privacy-transformers-cache")) {
    const cache = resolve(options.get("--privacy-transformers-cache"));
    const validator = resolve(
      repoRoot,
      "scripts/validate-packaged-privacy-runtime.mjs"
    );
    const args = [
      validator,
      "--runtime-root",
      resolve(releaseDir, "components/privacy"),
      "--transformers-cache",
      cache,
      "--provider",
      "cpu"
    ];
    inference = {
      node: run(process.execPath, args),
      electron: run(electronBin, args, {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1"
      })
    };
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        releaseDir,
        archives: Object.fromEntries(
          Object.entries(distribution.components).map(
            ([component, artifact]) => [
              component,
              {
                name: artifact.archive,
                sha256: artifact.archiveSha256,
                manifestSha256: artifact.manifestSha256
              }
            ]
          )
        ),
        nodeIdentity,
        electronIdentity,
        node: nodeResult,
        electron: electronResult,
        privacyInference:
          inference ?? "skipped; provide --privacy-transformers-cache"
      },
      null,
      2
    )
  );
  completed = true;
} catch (error) {
  console.error(`Compatibility smoke diagnostics are preserved at ${scratch}`);
  throw error;
} finally {
  if (completed) rmSync(scratch, { recursive: true, force: true });
}
