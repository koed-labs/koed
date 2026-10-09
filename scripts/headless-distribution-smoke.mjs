#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const flags = new Map();
const supportedFlags = new Set([
  "--postgres-bin-dir",
  "--llama-server-bin",
  "--embedding-model",
  "--out-dir"
]);
for (let i = 2; i < process.argv.length; i += 2) {
  if (!supportedFlags.has(process.argv[i]) || !process.argv[i + 1])
    throw new Error(`Unknown or incomplete option: ${process.argv[i]}`);
  flags.set(process.argv[i], process.argv[i + 1]);
}
for (const flag of [
  "--postgres-bin-dir",
  "--llama-server-bin",
  "--embedding-model"
]) {
  if (!flags.get(flag) || !existsSync(resolve(flags.get(flag))))
    throw new Error(`Provide existing ${flag}`);
}
let scratch = flags.has("--out-dir")
  ? resolve(flags.get("--out-dir"))
  : mkdtempSync(resolve(tmpdir(), "koed headless signed flow "));
if (flags.has("--out-dir") && existsSync(scratch))
  throw new Error("Smoke output directory must not already exist.");
mkdirSync(scratch, { recursive: true });
scratch = realpathSync(scratch);
const run = (name, args, options = {}) => {
  const result = spawnSync(name, args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${name} ${args.join(" ")} failed (${result.status}): ${result.stderr}\n${result.stdout}`
    );
  return result.stdout;
};
const keys = generateKeyPairSync("ed25519");
const keyId = "headless-smoke-test-only";
const pem = keys.publicKey.export({ type: "spki", format: "pem" });
const keyFile = resolve(scratch, "test-only-private-key.pem");
writeFileSync(
  keyFile,
  keys.privateKey.export({ type: "pkcs8", format: "pem" }),
  { mode: 0o600 }
);
const release = resolve(scratch, "components");
run(
  process.execPath,
  [
    resolve(repoRoot, "scripts/build-koed-component-release.mjs"),
    "--out-dir",
    release,
    "--json"
  ],
  {
    env: {
      ...process.env,
      KOED_COMPONENT_SIGNING_KEY_ID: keyId,
      KOED_COMPONENT_SIGNING_PRIVATE_KEY_FILE: keyFile
    }
  }
);
// Build a fixture control plane from copied compiled output. Production source roots are never edited.
const fixtureRoot = resolve(scratch, "fixture");
mkdirSync(resolve(fixtureRoot, "scripts"), { recursive: true });
mkdirSync(resolve(fixtureRoot, "packages/koed-server"), { recursive: true });
for (const file of [
  "build-public-server-package.mjs",
  "package-release-identity.mjs"
])
  copyFileSync(
    resolve(repoRoot, "scripts", file),
    resolve(fixtureRoot, "scripts", file)
  );
copyFileSync(resolve(repoRoot, "LICENSE"), resolve(fixtureRoot, "LICENSE"));
copyFileSync(
  resolve(repoRoot, "packages/koed-server/package.json"),
  resolve(fixtureRoot, "packages/koed-server/package.json")
);
cpSync(
  resolve(repoRoot, "packages/koed-server/dist"),
  resolve(fixtureRoot, "packages/koed-server/dist"),
  { recursive: true }
);
symlinkSync(
  resolve(repoRoot, "node_modules"),
  resolve(fixtureRoot, "node_modules"),
  "dir"
);
symlinkSync(
  resolve(repoRoot, "packages/koed-server/node_modules"),
  resolve(fixtureRoot, "packages/koed-server/node_modules"),
  "dir"
);
writeFileSync(
  resolve(fixtureRoot, "packages/koed-server/dist/component-trust-roots.js"),
  `export const productionComponentTrustRoots = new Map([[${JSON.stringify(keyId)}, ${JSON.stringify(pem)}]]);\n`
);
const publicOutput = resolve(scratch, "public");
run(process.execPath, [
  resolve(fixtureRoot, "scripts/build-public-server-package.mjs"),
  "--out-dir",
  publicOutput
]);
const prefix = resolve(scratch, "npm prefix");
const outside = resolve(scratch, "outside checkout");
mkdirSync(outside, { recursive: true });
run(
  "npm",
  [
    "install",
    "--global",
    "--prefix",
    prefix,
    "--offline",
    "--ignore-scripts",
    resolve(publicOutput, "tarballs/koed-labs-server.tgz")
  ],
  { cwd: outside }
);
const executable = resolve(prefix, "bin/koed");
const home = resolve(scratch, "koed-home");
const env = {
  PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
  HOME: resolve(scratch, "user-home"),
  TMPDIR: tmpdir(),
  XDG_STATE_HOME: resolve(scratch, "user-state"),
  KOED_HOME: home,
  KOED_RUNTIME_MODE: "local-personal",
  KOED_DEPENDENCY_MODE: "bundled-local",
  KOED_TEAM_COLLABORATION_ENABLED: "false",
  KOED_AUTO_PORTS: "1",
  KOED_POSTGRES_BIN_DIR: resolve(flags.get("--postgres-bin-dir")),
  KOED_EMBEDDING_LLAMA_SERVER_BIN: resolve(flags.get("--llama-server-bin")),
  KOED_EMBEDDING_MODEL_PATH: resolve(flags.get("--embedding-model")),
  KOED_EMBEDDING_ACCELERATION: "cpu",
  npm_config_offline: "true",
  npm_config_registry: "http://127.0.0.1:1"
};
const koed = (args) => run(executable, args, { cwd: outside, env });
const manifest = JSON.parse(
  readFileSync(
    resolve(
      release,
      `koed-distribution-${JSON.parse(readFileSync(resolve(repoRoot, "packages/koed-server/package.json"))).version}-${process.platform === "darwin" ? "macos" : process.platform}-${process.arch}.json`
    )
  )
);
const base = manifest.components.base;
const productionOutput = resolve(scratch, "production-public");
run(process.execPath, [
  resolve(repoRoot, "scripts/build-public-server-package.mjs"),
  "--out-dir",
  productionOutput
]);
const denied = spawnSync(
  process.execPath,
  [
    resolve(productionOutput, "package/bin/koed.js"),
    "components",
    "install",
    "--component",
    "base",
    "--archive",
    resolve(release, base.archive),
    "--manifest",
    resolve(release, base.manifest),
    "--signature",
    resolve(release, base.signature),
    "--json"
  ],
  {
    cwd: outside,
    env: { ...env, KOED_HOME: resolve(scratch, "production-denial-home") },
    encoding: "utf8"
  }
);
if (denied.error) throw denied.error;
assert.equal(denied.status, 1);
assert.match(denied.stdout, /untrusted|unknown.*key|trust/i);
assert.equal(
  existsSync(
    resolve(scratch, "production-denial-home/runtime/components/current.json")
  ),
  false
);
assert.match(koed(["--help"]), /Usage: koed /);
for (const component of ["base", "privacy"]) {
  const artifact = manifest.components[component];
  run(
    executable,
    [
      "components",
      "install",
      "--component",
      component,
      "--archive",
      resolve(release, artifact.archive),
      "--manifest",
      resolve(release, artifact.manifest),
      "--signature",
      resolve(release, artifact.signature),
      "--json"
    ],
    {
      cwd: outside,
      env: {
        ...env,
        KOED_TEAM_COLLABORATION_ENABLED:
          component === "privacy" ? "true" : "false"
      }
    }
  );
}
const installed = JSON.parse(
  run(executable, ["components", "status", "--json"], {
    cwd: outside,
    env: { ...env, KOED_TEAM_COLLABORATION_ENABLED: "true" }
  })
);
assert.equal(installed.components.base, "active");
assert.equal(installed.components.privacy, "active");
let healthy = false;
try {
  const started = JSON.parse(koed(["start", "--daemon", "--json"]));
  assert.equal(started.ok, true);
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const result = spawnSync(executable, ["status", "--startup", "--json"], {
      cwd: outside,
      env,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024
    });
    if (result.status === 0) {
      const status = JSON.parse(result.stdout);
      if (status.ok === true && status.state === "healthy") {
        healthy = true;
        break;
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 2000));
  }
  assert.ok(
    healthy,
    `Runtime did not become ready; inspect ${home}/logs/supervisor.log`
  );
  const doctorResult = spawnSync(executable, ["doctor", "--json"], {
    cwd: outside,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  if (doctorResult.error) throw doctorResult.error;
  const doctor = JSON.parse(doctorResult.stdout);
  for (const id of [
    "api",
    "database",
    "workerQueues",
    "embeddingService",
    "privacyService",
    "localAiRuntime",
    "apiToken",
    "mcpServer",
    "deviceIdentity"
  ])
    assert.equal(
      doctor.checks.find((check) => check.id === id)?.state,
      "healthy",
      `doctor ${id}`
    );
  writeFileSync(
    resolve(scratch, "doctor.json"),
    `${JSON.stringify(doctor, null, 2)}\n`
  );
  const result = {
    ok: true,
    scope:
      "headless Node 24 / Base and Privacy installation / Personal startup",
    testKeyId: keyId,
    productionPublicationEnabled: false,
    scratch,
    nativeStartup: true,
    doctor: true,
    productionTestKeyRejected: true
  };
  writeFileSync(
    resolve(scratch, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  koed(["stop", "--json"]);
}
