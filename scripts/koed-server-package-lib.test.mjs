import assert from "node:assert/strict";
import {
  readFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import {
  buildPackageManifest,
  buildPackageProvenance,
  sha256File,
  validatePackageRoot,
  writePackageManifest
} from "./koed-server-package-lib.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const temps = [];

const tempDir = () => {
  const dir = mkdtempSync(resolve(tmpdir(), "koed-server-package-test-"));
  temps.push(dir);
  return dir;
};

const writeFile = (path, content = "test\n") => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

const writeExecutable = (path) => {
  writeFile(path, "#!/usr/bin/env sh\nexit 0\n");
  chmodSync(path, 0o755);
};

const createPackageRoot = () => {
  const root = tempDir();
  const runtime = resolve(root, "koed-runtime");
  for (const file of [
    "api/dist/index.js",
    "api/dist/browser-approval/index.html",
    "api/dist/browser-approval/assets/index-abc12345.js",
    "api/dist/browser-approval/assets/index-abc12345.css",
    "worker/dist/index.js",
    "embedding-service/dist/index.js",
    "mcp-server/dist/cli.js",
    "mcp-server/dist/capture-hook.js",
    "api/node_modules/@koed/db/dist/index.js"
  ]) {
    writeFile(resolve(runtime, file));
  }
  writeFile(
    resolve(runtime, "api/node_modules/@koed/db/drizzle/meta/_journal.json"),
    JSON.stringify({ version: "7", entries: [{ when: 20260708000000 }] })
  );
  writeFile(resolve(root, "README.txt"), "Standalone koed-server package\n");
  writeExecutable(resolve(root, "bin", "koed-server"));
  writeFile(resolve(root, "koed-server", "dist", "cli.js"));
  return root;
};

const writeManifest = (root) => {
  const manifest = buildPackageManifest({
    packageRoot: root,
    repoRoot,
    platform: "linux",
    architecture: "x64",
    version: "0.2.0"
  });
  writePackageManifest(root, manifest);
  return manifest;
};

test.afterEach(() => {
  for (const path of temps.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

test("validates a standalone koed-server package root", () => {
  const root = createPackageRoot();
  const manifest = writeManifest(root);

  const result = validatePackageRoot(root);

  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(manifest.id, "koed-server");
  assert.equal(manifest.koedRuntime.path, "koed-runtime");
  assert.deepEqual(manifest.models, {
    embedding: "qwen3-0.6b",
    reranker: "qwen3-reranker-0.6b"
  });
  assert.equal(
    manifest.database.migrationSet.latestMigrationTimestamp,
    20260708000000
  );
});

test("builds provenance for package archive and manifest hashes", () => {
  const root = createPackageRoot();
  const manifest = writeManifest(root);
  const archive = resolve(tempDir(), "koed-server-0.2.0-linux-x64.tar.gz");
  writeFile(archive, "archive\n");
  const manifestPath = resolve(root, "koed-server-package-manifest.json");

  const provenance = buildPackageProvenance({
    archivePath: archive,
    manifestPath,
    manifest,
    createdAt: "2026-01-01T00:00:00.000Z"
  });

  assert.equal(provenance.statement.schemaVersion, 1);
  assert.equal(provenance.statement.subject.archiveSha256, sha256File(archive));
  assert.equal(
    provenance.statement.subject.manifestSha256,
    sha256File(manifestPath)
  );
  assert.equal(provenance.signature.status, "unsigned-placeholder");
  assert.match(readFileSync(manifestPath, "utf8"), /"provenance"/);
});

test("omits pnpm workspace self-symlinks from manifest validation", () => {
  const root = createPackageRoot();
  const selfLink = resolve(
    root,
    "koed-runtime",
    "api",
    "node_modules",
    ".pnpm",
    "node_modules",
    "@koed",
    "api"
  );
  mkdirSync(dirname(selfLink), { recursive: true });
  symlinkSync("../../../../../../../../../../apps/api", selfLink);
  const manifest = writeManifest(root);

  const result = validatePackageRoot(root);

  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(
    manifest.files.some((entry) =>
      entry.path.endsWith(
        "koed-runtime/api/node_modules/.pnpm/node_modules/@koed/api"
      )
    ),
    false
  );
  assert.equal(
    result.files.includes(
      "koed-runtime/api/node_modules/.pnpm/node_modules/@koed/api"
    ),
    false
  );
});

test("reports missing required runtime files", () => {
  const root = createPackageRoot();
  rmSync(
    resolve(root, "koed-runtime", "mcp-server", "dist", "capture-hook.js")
  );
  writeManifest(root);

  const result = validatePackageRoot(root);

  assert.equal(result.ok, false);
  assert.match(
    result.errors.join("\n"),
    /koed-runtime\/mcp-server\/dist\/capture-hook\.js/
  );
});

test("requires packaged API browser approval assets", () => {
  const root = createPackageRoot();
  rmSync(
    resolve(root, "koed-runtime", "api", "dist", "browser-approval", "assets"),
    { recursive: true }
  );
  writeManifest(root);

  const result = validatePackageRoot(root);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /browser-approval\/assets/);
});

test("rejects retired Explorer, native runtime, model, and Python leftovers", () => {
  const root = createPackageRoot();
  writeFile(resolve(root, "koed-runtime", "explorer-dist", "index.html"));
  writeFile(resolve(root, "koed-server", "dist", "explorer-static-server.js"));
  writeFile(resolve(root, "koed-runtime", "postgres", "bin", "initdb"));
  writeFile(resolve(root, "koed-runtime", "llama.cpp", "llama-server"));
  writeFile(resolve(root, "koed-runtime", "models", "model.gguf"));
  writeFile(resolve(root, "koed-runtime", "embedding-service", "app.py"));
  writeFile(
    resolve(root, "koed-runtime", "embedding-service", ".venv", "pyvenv.cfg")
  );
  writeManifest(root);

  const result = validatePackageRoot(root);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /koed-runtime\/explorer-dist/);
  assert.match(
    result.errors.join("\n"),
    /koed-server\/dist\/explorer-static-server\.js/
  );
  assert.match(
    result.errors.join("\n"),
    /Excluded file is present: koed-runtime\/postgres/
  );
  assert.match(
    result.errors.join("\n"),
    /Excluded file is present: koed-runtime\/llama\.cpp/
  );
  assert.match(result.errors.join("\n"), /model\.gguf/);
  assert.match(result.errors.join("\n"), /embedding-service\/app\.py/);
  assert.match(result.errors.join("\n"), /embedding-service\/\.venv/);
});

test("reports manifest file checksum mismatches", () => {
  const root = createPackageRoot();
  writeManifest(root);
  writeFile(resolve(root, "README.txt"), "changed\n");

  const result = validatePackageRoot(root);

  assert.equal(result.ok, false);
  assert.match(
    result.errors.join("\n"),
    /Manifest file SHA-256 mismatch: README\.txt/
  );
  assert.match(
    result.errors.join("\n"),
    /Package manifest sha256 does not match package files/
  );
});
