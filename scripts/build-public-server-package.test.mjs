import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { requiredComponentIdentities } from "./component-manifest-catalog.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const node24 = process.execPath;

test("public package builder accepts pnpm argument separators", () => {
  const help = execFileSync(
    node24,
    [
      resolve(repoRoot, "scripts/build-public-server-package.mjs"),
      "--",
      "--help"
    ],
    { cwd: repoRoot, encoding: "utf8" }
  );
  assert.match(help, /Usage: node scripts\/build-public-server-package\.mjs/);
});

test("assembled public package has only koed bin and self-contained control plane", () => {
  mkdirSync(resolve(repoRoot, "scratch"), { recursive: true });
  const scratch = realpathSync(
    mkdtempSync(resolve(repoRoot, "scratch", "koed public package "))
  );
  try {
    const version = JSON.parse(
      readFileSync(
        resolve(repoRoot, "packages/koed-server/package.json"),
        "utf8"
      )
    ).version;
    const catalog = {
      schemaVersion: 2,
      productVersion: version,
      entries: requiredComponentIdentities.map((identity) => ({
        ...identity,
        manifestSha256: "a".repeat(64)
      }))
    };
    const catalogPath = resolve(scratch, "catalog.json");
    writeFileSync(catalogPath, JSON.stringify(catalog));
    execFileSync(
      node24,
      [
        resolve(repoRoot, "scripts/build-public-server-package.mjs"),
        "--",
        "--out-dir",
        scratch
      ],
      {
        cwd: repoRoot,
        stdio: "pipe",
        env: { ...process.env, KOED_COMPONENT_MANIFEST_CATALOG: catalogPath }
      }
    );
    const packageDir = resolve(scratch, "package");
    const manifest = JSON.parse(
      readFileSync(resolve(packageDir, "package.json"), "utf8")
    );
    assert.equal(manifest.name, "@koed-labs/server");
    assert.equal(
      execFileSync(node24, [resolve(packageDir, "bin/koed.js"), "--version"], {
        cwd: scratch,
        encoding: "utf8"
      }),
      `${version}\n`
    );
    const embedded = execFileSync(
      node24,
      [
        "--input-type=module",
        "-e",
        `console.log(JSON.stringify((await import(${JSON.stringify(resolve(packageDir, "vendor/component-manifest-catalog.js"))})).productionComponentManifestCatalog))`
      ],
      { cwd: scratch, encoding: "utf8" }
    );
    assert.deepEqual(JSON.parse(embedded), catalog);
    assert.equal(manifest.private, false);
    assert.deepEqual(manifest.bin, { koed: "bin/koed.js" });
    assert.deepEqual(manifest.engines, { node: ">=24 <25" });
    assert.deepEqual(manifest.dependencies ?? {}, {});
    assert.equal(manifest.scripts, undefined);
    assert.ok(!manifest.files.includes("dist/component-trust-roots.js"));
    assert.ok(readFileSync(resolve(packageDir, "LICENSE"), "utf8").length > 0);
    assert.ok(
      readFileSync(resolve(packageDir, "third-party-notices.json"), "utf8")
        .length > 0
    );
    assert.ok(
      readFileSync(resolve(packageDir, "bin/koed.js"), "utf8").includes(
        "vendor/control-plane.js"
      )
    );
    for (const args of [
      ["runtime", "install", "--help"],
      ["upstream", "enroll", "--help"],
      ["setup", "codex", "--help"],
      ["personal-sync", "recovery-kit", "verify", "--help"]
    ]) {
      const help = execFileSync(
        node24,
        [resolve(packageDir, "bin/koed.js"), ...args],
        {
          cwd: scratch,
          encoding: "utf8",
          env: { ...process.env, KOED_HOME: resolve(scratch, "isolated-home") }
        }
      );
      assert.ok(help.includes(`Usage: koed ${args.slice(0, -1).join(" ")}`));
    }
    const components = JSON.parse(
      execFileSync(
        node24,
        [resolve(packageDir, "bin/koed.js"), "components", "status", "--json"],
        {
          cwd: scratch,
          encoding: "utf8",
          env: { ...process.env, KOED_HOME: resolve(scratch, "isolated-home") }
        }
      )
    );
    assert.equal(components.components.base, "missing");
    const legacyRevocation = spawnSync(
      node24,
      [
        resolve(packageDir, "bin/koed.js"),
        "personal-sync",
        "device",
        "revoke",
        "--group-id",
        "group",
        "--device-id",
        "device",
        "--json"
      ],
      {
        cwd: scratch,
        encoding: "utf8",
        env: { ...process.env, KOED_HOME: resolve(scratch, "isolated-home") }
      }
    );
    assert.equal(legacyRevocation.status, 1, legacyRevocation.stderr);
    assert.equal(
      JSON.parse(legacyRevocation.stdout).error,
      "--statement-fd is required."
    );
    const helperEnv = {
      ...process.env,
      KOED_HOME: resolve(scratch, "isolated-home")
    };
    const secretCli = resolve(packageDir, "vendor/cli.js");
    execFileSync(
      node24,
      [secretCli, "secret-provider", "put", "smoke-reference"],
      { env: helperEnv, input: "fixture-secret" }
    );
    assert.equal(
      execFileSync(
        node24,
        [secretCli, "secret-provider", "get", "smoke-reference"],
        { env: helperEnv, encoding: "utf8" }
      ),
      "fixture-secret"
    );
    const privacyEntry = resolve(scratch, "privacy-entry.mjs");
    writeFileSync(
      privacyEntry,
      "process.stdout.write(process.env.KOED_PRIVACY_TRANSFORMERS_CACHE);"
    );
    assert.equal(
      execFileSync(
        node24,
        [
          resolve(packageDir, "vendor/privacy-service-bootstrap.js"),
          privacyEntry,
          resolve(scratch, "cache")
        ],
        { encoding: "utf8" }
      ),
      resolve(scratch, "cache")
    );
    const tarball = resolve(scratch, "tarballs", "koed-labs-server.tgz");
    assert.equal(
      readdirSync(resolve(scratch, "tarballs")).filter((name) =>
        name.endsWith(".tgz")
      ).length,
      1
    );
    const packedFiles = execFileSync("tar", ["-tzf", tarball], {
      encoding: "utf8"
    }).split("\n");
    assert.ok(packedFiles.some((file) => file.endsWith("/bin/koed.js")));
    for (const helper of [
      "README.md",
      "vendor/cli.js",
      "vendor/privacy-service-bootstrap.js",
      "vendor/component-manifest-catalog.js"
    ]) {
      assert.ok(
        packedFiles.includes(`package/${helper}`),
        `missing packaged helper: ${helper}`
      );
    }
    assert.ok(
      packedFiles.some((file) => file.endsWith("/vendor/control-plane.js"))
    );
    assert.ok(packedFiles.every((file) => !file.includes("node_modules/")));
    assert.ok(
      packedFiles.every((file) => !file.includes("component-trust-roots"))
    );
    const inspectTree = (directory) => {
      for (const entry of readdirSync(directory)) {
        const path = resolve(directory, entry);
        const info = lstatSync(path);
        assert.equal(
          info.isSymbolicLink(),
          false,
          `unexpected symlink: ${path}`
        );
        if (info.isDirectory()) inspectTree(path);
      }
    };
    inspectTree(packageDir);
    for (const relative of [
      "package.json",
      "bin/koed.js",
      "vendor/control-plane.js",
      "LICENSE",
      "third-party-notices.json"
    ]) {
      const text = readFileSync(resolve(packageDir, relative), "utf8");
      assert.doesNotMatch(text, /workspace:\*|file:\/\//);
      assert.doesNotMatch(text, /\/Users\/[^\s"']+\/agents\/koed/);
    }
    const packageText = JSON.stringify(manifest);
    assert.doesNotMatch(packageText, /koed-server|workspace:|file:/);
    assert.ok(!manifest.bin["koed-server"]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
