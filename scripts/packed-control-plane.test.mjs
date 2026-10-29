import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { buildComponentReleaseSet } from "./component-release-lib.mjs";
import { canonicalComponentManifestBytes } from "./koed-server-package-lib.mjs";
import {
  requiredComponentIdentities,
  writeComponentManifestCatalog
} from "./component-manifest-catalog.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const node24 = process.execPath;

test("global npm control plane admits only pinned components without checkout imports or network", () => {
  mkdirSync(resolve(repoRoot, "scratch"), { recursive: true });
  const scratch = mkdtempSync(resolve(repoRoot, "scratch/koed packed smoke "));
  try {
    const version = JSON.parse(
      readFileSync(
        resolve(repoRoot, "packages/koed-server/package.json"),
        "utf8"
      )
    ).version;
    const componentsRoot = resolve(scratch, "component-inputs");
    const assetsDir = resolve(scratch, "component-assets");
    for (const component of ["base", "privacy", "privacy-cpu"]) {
      mkdirSync(resolve(componentsRoot, component), { recursive: true });
      writeFileSync(
        resolve(componentsRoot, component, "ready.js"),
        "export {};\n"
      );
    }
    for (const target of [
      requiredComponentIdentities[0].target,
      requiredComponentIdentities.find(
        (entry) => entry.target.platform === "macos"
      ).target
    ])
      buildComponentReleaseSet({
        componentsRoot,
        outDir: assetsDir,
        version,
        target,
        runtimes: [
          {
            kind: "node",
            runtimeRange: ">=24 <25",
            nodeRange: ">=24 <25",
            modulesAbi: process.versions.modules
          }
        ],
        requiredFiles: { base: ["ready.js"], privacy: ["ready.js"] }
      });
    const catalogPath = resolve(assetsDir, "component-manifest-hashes.json");
    writeComponentManifestCatalog({
      manifestsDir: assetsDir,
      outputPath: catalogPath,
      version
    });
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
        stdio: "pipe",
        env: { ...process.env, KOED_COMPONENT_MANIFEST_CATALOG: catalogPath }
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
      `import { appendFileSync } from "node:fs";\nimport { registerHooks } from "node:module";\nregisterHooks({ resolve(specifier, context, nextResolve) { const result = nextResolve(specifier, context); if (result.url.startsWith(${JSON.stringify(pathToFileURL(`${repoRoot}/`).href)}) && !result.url.startsWith(${JSON.stringify(pathToFileURL(`${prefix}/`).href)})) throw new Error("Checkout import forbidden: " + result.url); return result; } });\nconst originalFetch = globalThis.fetch;\nglobalThis.fetch = (...args) => { appendFileSync(${JSON.stringify(requestLog)}, String(args[0]) + "\\n"); throw new Error("Network forbidden during packaged acceptance"); };\n`
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
    const runKoed = (args, home = "koed-home") =>
      spawnSync(executable, args, {
        cwd: outside,
        env: { ...cleanEnvironment, KOED_HOME: resolve(scratch, home) },
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
    const platform = process.platform === "darwin" ? "macos" : process.platform;
    const archive = resolve(
      assetsDir,
      `koed-base-${version}-${platform}-${process.arch}.tar.gz`
    );
    const manifest = `${archive}.manifest.json`;
    const installArgs = [
      "components",
      "install",
      "--component",
      "base",
      "--version",
      version,
      "--archive",
      archive,
      "--manifest",
      manifest,
      "--stage-only",
      "--json"
    ];
    const installed = runKoed(installArgs);
    assert.equal(installed.status, 0, installed.stderr + installed.stdout);
    assert.equal(JSON.parse(installed.stdout).state, "staged");
    const reused = runKoed(installArgs);
    assert.equal(reused.status, 0, reused.stderr + reused.stdout);
    const originalManifest = readFileSync(manifest);
    writeFileSync(
      manifest,
      JSON.stringify(JSON.parse(originalManifest), null, 2)
    );
    const noncanonical = runKoed(installArgs, "noncanonical-home");
    assert.notEqual(noncanonical.status, 0);
    assert.match(
      noncanonical.stderr + noncanonical.stdout,
      /canonical|manifest.*pin/i
    );
    const wrongPin = JSON.parse(originalManifest);
    wrongPin.archive.sha256 = "f".repeat(64);
    writeFileSync(manifest, canonicalComponentManifestBytes(wrongPin));
    const canonicalMismatch = runKoed(installArgs, "canonical-wrong-pin-home");
    assert.notEqual(canonicalMismatch.status, 0);
    assert.match(
      canonicalMismatch.stderr + canonicalMismatch.stdout,
      /manifest pin mismatch/i
    );
    writeFileSync(manifest, originalManifest);
    const originalArchive = readFileSync(archive);
    writeFileSync(archive, Buffer.alloc(originalArchive.length));
    const corruptArchive = runKoed(installArgs, "corrupt-archive-home");
    assert.notEqual(corruptArchive.status, 0);
    assert.match(
      corruptArchive.stderr + corruptArchive.stdout,
      /digest|sha256|archive/i
    );
    writeFileSync(archive, originalArchive);
    const validStore = runKoed(["components", "status", "--json"]);
    assert.equal(validStore.status, 0, validStore.stderr);
    assert.equal(JSON.parse(validStore.stdout).components.base, "staged");
    const storedFile = readdirSync(resolve(scratch, "koed-home"), {
      recursive: true
    }).find((name) => name.endsWith("/ready.js"));
    assert.ok(storedFile, "component file stored under isolated KOED_HOME");
    writeFileSync(resolve(scratch, "koed-home", storedFile), "tampered\n");
    const corruptStore = runKoed(["components", "status", "--json"]);
    assert.equal(corruptStore.status, 0, corruptStore.stderr);
    assert.equal(JSON.parse(corruptStore.stdout).components.base, "missing");
    assert.equal(JSON.parse(corruptStore.stdout).activeGeneration, null);
    assert.equal(readFileSync(requestLog, "utf8"), "");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
