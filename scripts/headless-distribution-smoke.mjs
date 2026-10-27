#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { verifyHeadlessLifecycle } from "./headless-lifecycle.mjs";
import {
  buildComponentManifestCatalog,
  componentCatalogKey,
  requiredComponentIdentities
} from "./component-manifest-catalog.mjs";
import { canonicalComponentManifestBytes } from "./koed-server-package-lib.mjs";
import {
  PINNED_PRIVACY_MODEL_FILES,
  PINNED_PRIVACY_MODEL_ID,
  PINNED_PRIVACY_MODEL_REVISION
} from "../packages/shared/dist/index.js";

const repoRoot = resolve(import.meta.dirname, "..");
const flags = new Map();
const supportedFlags = new Set([
  "--postgres-bin-dir",
  "--llama-server-bin",
  "--embedding-model",
  "--privacy-transformers-cache",
  "--out-dir"
]);
const switches = new Set(["--team", "--install-models"]);
for (let i = 2; i < process.argv.length; ) {
  if (switches.has(process.argv[i])) {
    flags.set(process.argv[i], "true");
    i += 1;
    continue;
  }
  if (!supportedFlags.has(process.argv[i]) || !process.argv[i + 1])
    throw new Error(`Unknown or incomplete option: ${process.argv[i]}`);
  flags.set(process.argv[i], process.argv[i + 1]);
  i += 2;
}
const requiredInputs = ["--postgres-bin-dir", "--llama-server-bin"];
if (!flags.has("--install-models")) requiredInputs.push("--embedding-model");
if (
  flags.has("--install-models") &&
  (flags.has("--embedding-model") || flags.has("--privacy-transformers-cache"))
)
  throw new Error(
    "Use --install-models or preinstalled model inputs, not both."
  );
for (const flag of requiredInputs) {
  if (!flags.get(flag) || !existsSync(resolve(flags.get(flag))))
    throw new Error(`Provide existing ${flag}`);
}
mkdirSync(resolve(repoRoot, "scratch"), { recursive: true });
let scratch = flags.has("--out-dir")
  ? resolve(flags.get("--out-dir"))
  : mkdtempSync(resolve(repoRoot, "scratch", "koed headless pin flow "));
if (flags.has("--out-dir") && existsSync(scratch))
  throw new Error("Smoke output directory must not already exist.");
mkdirSync(scratch, { recursive: true });
scratch = realpathSync(scratch);
if (
  flags.has("--team") &&
  !flags.has("--install-models") &&
  (!flags.has("--privacy-transformers-cache") ||
    !existsSync(resolve(flags.get("--privacy-transformers-cache"))))
) {
  throw new Error(
    "Team smoke requires --privacy-transformers-cache with the pinned model files."
  );
}
const run = (name, args, options = {}, allowNonzeroExit = false) => {
  const result = spawnSync(name, args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowNonzeroExit)
    throw new Error(
      `${name} ${args.join(" ")} failed (${result.status}): ${result.stderr}\n${result.stdout}`
    );
  return result.stdout;
};
const release = resolve(scratch, "components");
const builtRelease = JSON.parse(
  run(process.execPath, [
    resolve(repoRoot, "scripts/build-koed-component-release.mjs"),
    "--out-dir",
    release,
    "--json"
  ])
);
const manifest = JSON.parse(
  readFileSync(builtRelease.distributionManifest, "utf8")
);
const fixturePins = buildComponentManifestCatalog({
  version: manifest.version,
  manifests: Object.values(manifest.components).map((entry) =>
    readFileSync(resolve(release, entry.manifest))
  ),
  required: ["base", "privacy"].map((component) => ({
    component,
    target: manifest.target
  }))
});
// Other targets are deliberately unusable fixture entries, not release evidence.
const catalog = {
  ...fixturePins,
  entries: requiredComponentIdentities.map(
    (identity) =>
      fixturePins.entries.find(
        (entry) => componentCatalogKey(entry) === componentCatalogKey(identity)
      ) ?? { ...identity, manifestSha256: "0".repeat(64) }
  )
};
const catalogPath = resolve(scratch, "fixture-catalog.json");
writeFileSync(catalogPath, canonicalComponentManifestBytes(catalog));
// Build a fixture control plane from copied compiled output. Production source roots are never edited.
const fixtureRoot = resolve(scratch, "fixture");
mkdirSync(resolve(fixtureRoot, "scripts"), { recursive: true });
mkdirSync(resolve(fixtureRoot, "packages/koed-server"), { recursive: true });
cpSync(resolve(repoRoot, "scripts"), resolve(fixtureRoot, "scripts"), {
  recursive: true,
  filter: (path) =>
    statSync(path).isDirectory() ||
    (path.endsWith(".mjs") && !path.endsWith(".test.mjs"))
});
mkdirSync(resolve(fixtureRoot, "packages/koed-server/src"), {
  recursive: true
});
copyFileSync(
  resolve(repoRoot, "packages/koed-server/src/artifact-canonical-json.mjs"),
  resolve(fixtureRoot, "packages/koed-server/src/artifact-canonical-json.mjs")
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
const publicOutput = resolve(scratch, "public");
run(
  process.execPath,
  [
    resolve(fixtureRoot, "scripts/build-public-server-package.mjs"),
    "--out-dir",
    publicOutput
  ],
  { env: { ...process.env, KOED_COMPONENT_MANIFEST_CATALOG: catalogPath } }
);
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
if (flags.has("--team") && !flags.has("--install-models")) {
  const modelSource = resolve(flags.get("--privacy-transformers-cache"));
  cpSync(modelSource, resolve(home, "models/privacy/transformers-cache"), {
    recursive: true
  });
  for (const file of PINNED_PRIVACY_MODEL_FILES) {
    const blob = resolve(home, "models/privacy/blobs/sha256", file.sha256);
    mkdirSync(dirname(blob), { recursive: true });
    linkSync(
      resolve(
        home,
        "models/privacy/transformers-cache",
        PINNED_PRIVACY_MODEL_ID,
        PINNED_PRIVACY_MODEL_REVISION,
        file.path
      ),
      blob
    );
  }
}
const env = {
  PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
  HOME: resolve(scratch, "user-home"),
  CODEX_HOME: resolve(scratch, "codex-home"),
  CLAUDE_CONFIG_DIR: resolve(scratch, "claude-home"),
  PI_CODEROOT: resolve(scratch, "pi-home"),
  PI_CONFIG_DIR: resolve(scratch, "pi-config"),
  TMPDIR: tmpdir(),
  XDG_STATE_HOME: resolve(scratch, "user-state"),
  KOED_HOME: home,
  KOED_RUNTIME_MODE: "local-personal",
  KOED_DEPENDENCY_MODE: "bundled-local",
  KOED_TEAM_COLLABORATION_ENABLED: flags.has("--team") ? "true" : "false",
  KOED_AUTO_PORTS: "1",
  KOED_POSTGRES_BIN_DIR: resolve(flags.get("--postgres-bin-dir")),
  KOED_EMBEDDING_LLAMA_SERVER_BIN: resolve(flags.get("--llama-server-bin")),
  ...(flags.has("--embedding-model")
    ? { KOED_EMBEDDING_MODEL_PATH: resolve(flags.get("--embedding-model")) }
    : {}),
  KOED_EMBEDDING_ACCELERATION: "cpu",
  MEMORY_CODEX_TRANSCRIPT_WATCHER_ENABLED: "false",
  MEMORY_CLAUDE_TRANSCRIPT_WATCHER_ENABLED: "false",
  MEMORY_PI_TRANSCRIPT_WATCHER_ENABLED: "false",
  npm_config_offline: "true",
  npm_config_registry: "http://127.0.0.1:1"
};
// Doctor's overall exit includes optional AI Client diagnostics. Gate the same
// explicit core checks below rather than promoting diagnostics into requirements.
const koed = (args) =>
  run(executable, args, { cwd: outside, env }, args[0] === "doctor");
const base = manifest.components.base;
const tamperedManifest = JSON.parse(
  readFileSync(resolve(release, base.manifest), "utf8")
);
tamperedManifest.files[0].sha256 = "0".repeat(64);
const tamperedManifestPath = resolve(scratch, "tampered.manifest.json");
writeFileSync(
  tamperedManifestPath,
  canonicalComponentManifestBytes(tamperedManifest)
);
const tamperedArchiveRoot = resolve(scratch, "tampered-archive");
mkdirSync(tamperedArchiveRoot);
const tamperedArchivePath = resolve(tamperedArchiveRoot, base.archive);
const archiveBytes = readFileSync(resolve(release, base.archive));
archiveBytes[archiveBytes.length - 1] ^= 1;
writeFileSync(tamperedArchivePath, archiveBytes);
for (const [kind, archive, componentManifest, errorPattern] of [
  [
    "manifest",
    resolve(release, base.archive),
    tamperedManifestPath,
    /component manifest pin mismatch/
  ],
  [
    "archive",
    tamperedArchivePath,
    resolve(release, base.manifest),
    /component archive SHA-256 mismatch/
  ]
]) {
  const denialHome = resolve(scratch, `${kind}-denial-home`);
  const denied = spawnSync(
    executable,
    [
      "components",
      "install",
      "--component",
      "base",
      "--archive",
      archive,
      "--manifest",
      componentManifest,
      "--json"
    ],
    { cwd: outside, env: { ...env, KOED_HOME: denialHome }, encoding: "utf8" }
  );
  if (denied.error) throw denied.error;
  assert.equal(denied.status, 1);
  assert.match(denied.stdout + denied.stderr, errorPattern);
  assert.equal(
    existsSync(resolve(denialHome, "runtime/components/current.json")),
    false
  );
}
assert.match(koed(["--help"]), /Usage: koed /);
// TLS credentials authenticate only this loopback fixture server, never components.
const tlsKey = resolve(scratch, "fixture-tls-key.pem");
const tlsCertificate = resolve(scratch, "fixture-tls-cert.pem");
run("openssl", [
  "req",
  "-x509",
  "-newkey",
  "rsa:2048",
  "-nodes",
  "-days",
  "1",
  "-subj",
  "/CN=localhost",
  "-addext",
  "subjectAltName=DNS:localhost",
  "-keyout",
  tlsKey,
  "-out",
  tlsCertificate
]);
const artifactServer = spawn(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    `
  import { createServer } from "node:https";
  import { createReadStream, readFileSync, statSync } from "node:fs";
  import { resolve } from "node:path";
  const files = new Map(${JSON.stringify(
    Object.values(manifest.components)
      .flatMap((entry) => [entry.archive, entry.manifest])
      .map((name) => [`/${name}`, resolve(release, name)])
  )});
  const server = createServer({ key: readFileSync(${JSON.stringify(tlsKey)}), cert: readFileSync(${JSON.stringify(tlsCertificate)}) }, (request, response) => {
    const file = files.get(request.url);
    if (!file) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "content-length": statSync(file).size });
    createReadStream(file).pipe(response);
  });
  server.listen(0, "127.0.0.1", () => process.send(server.address().port));
`
  ],
  { stdio: ["ignore", "ignore", "inherit", "ipc"] }
);
try {
  const port = await new Promise((resolvePort, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Fixture HTTPS server startup timed out.")),
      10_000
    );
    artifactServer.once("message", (port) => {
      clearTimeout(timeout);
      resolvePort(port);
    });
    artifactServer.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    artifactServer.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Fixture HTTPS server exited (${code}).`));
    });
  });
  const onlineHome = resolve(scratch, "online-home");
  for (const component of ["base", "privacy"]) {
    const artifact = manifest.components[component];
    run(
      executable,
      [
        "components",
        "install",
        "--component",
        component,
        "--archive-url",
        `https://localhost:${port}/${artifact.archive}`,
        "--manifest-url",
        `https://localhost:${port}/${artifact.manifest}`,
        "--json"
      ],
      {
        cwd: outside,
        env: {
          ...env,
          KOED_HOME: onlineHome,
          NODE_EXTRA_CA_CERTS: tlsCertificate,
          KOED_TEAM_COLLABORATION_ENABLED:
            component === "privacy" ? "true" : "false"
        }
      }
    );
  }
  const online = JSON.parse(
    run(executable, ["components", "status", "--json"], {
      cwd: outside,
      env: {
        ...env,
        KOED_HOME: onlineHome,
        KOED_TEAM_COLLABORATION_ENABLED: "true"
      }
    })
  );
  assert.equal(online.components.base, "active");
  assert.equal(online.components.privacy, "active");
} finally {
  artifactServer.kill();
}
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
// Some bootstrap commands create KOED_HOME before the supervisor's first-boot
// initializer can apply its private directory mode. The host-bound identity
// verifier correctly rejects a world-readable home, so normalize only this
// disposable test home before starting services.
chmodSync(home, 0o700);
if (flags.has("--install-models")) {
  for (const kind of flags.has("--team")
    ? ["embedding", "privacy"]
    : ["embedding"])
    writeFileSync(
      resolve(scratch, `model-install-${kind}.json`),
      koed(["models", "install", "--kind", kind, "--json"])
    );
}
const runtimeStatePath = resolve(home, "run/koed-server.json");
const waitForHealthy = async () => {
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
      if (status.ok === true && status.state === "healthy")
        return JSON.parse(readFileSync(runtimeStatePath, "utf8"));
    }
    const supervisorLog = resolve(home, "logs/supervisor.log");
    if (
      existsSync(supervisorLog) &&
      readFileSync(supervisorLog, "utf8").includes(
        '"milestone":"startup_failed"'
      )
    ) {
      throw new Error(
        `Runtime startup failed; inspect ${supervisorLog}\n${readFileSync(supervisorLog, "utf8").slice(-8_000)}`
      );
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 2000));
  }
  assert.fail(
    `Runtime did not become ready; inspect ${home}/logs/supervisor.log`
  );
};
const waitForStopped = async (pid) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    let running = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      running = false;
    }
    if (!running && !existsSync(runtimeStatePath)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  return false;
};
const cycles = await verifyHeadlessLifecycle({
  command: koed,
  waitForHealthy,
  waitForStopped,
  recordDoctor(phase, doctor) {
    writeFileSync(
      resolve(scratch, `doctor-${phase}.json`),
      `${JSON.stringify(doctor, null, 2)}\n`
    );
  }
});
const result = {
  ok: true,
  scope: `Node 24 / Base and Privacy installation / ${flags.has("--team") ? "Team" : "Personal"} startup and restart`,
  platform: process.platform,
  architecture: process.arch,
  nodeVersion: process.version,
  runtime: process.execPath,
  fixtureOnlyCatalog: true,
  manifestPins: fixturePins.entries,
  onlineInstallation: true,
  offlineInstallation: true,
  manifestTamperRejected: true,
  archiveTamperRejected: true,
  productionPublicationEnabled: false,
  freshModelInstall: flags.has("--install-models"),
  scratch,
  nativeStartup: true,
  doctor: true,
  restart: true,
  shutdown: true,
  supervisors: cycles
};
writeFileSync(
  resolve(scratch, "result.json"),
  `${JSON.stringify(result, null, 2)}\n`
);
console.log(JSON.stringify(result, null, 2));
