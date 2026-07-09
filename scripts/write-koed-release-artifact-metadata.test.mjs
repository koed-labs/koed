import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { buildReleaseArtifactMetadata } from "./write-koed-release-artifact-metadata.mjs";

const temps = [];

const tempDir = () => {
  const dir = mkdtempSync(resolve(tmpdir(), "koed-release-metadata-test-"));
  temps.push(dir);
  return dir;
};

test.afterEach(() => {
  for (const path of temps.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

test("builds release metadata for standalone koed-server package targets", () => {
  const root = tempDir();
  const linux = resolve(root, "linux-x64");
  mkdirSync(linux, { recursive: true });
  writeFileSync(
    resolve(linux, "koed-server-0.4.0-linux-x64.tar.gz"),
    "archive\n"
  );
  writeFileSync(
    resolve(linux, "koed-server-0.4.0-linux-x64.tar.gz.sha256"),
    `${"a".repeat(64)}  koed-server-0.4.0-linux-x64.tar.gz\n`
  );
  writeFileSync(
    resolve(linux, "koed-server-app-runtime-0.4.0-linux-x64.manifest.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      id: "koed-server",
      version: "0.4.0",
      platform: "linux",
      architecture: "x64",
      packageKind: "app-runtime"
    })}\n`
  );
  writeFileSync(
    resolve(linux, "koed-server-app-runtime-0.4.0-linux-x64.provenance.json"),
    `${JSON.stringify({
      statement: { schemaVersion: 1 },
      signature: { status: "signed", algorithm: "ed25519", value: "sig" }
    })}\n`
  );
  writeFileSync(
    resolve(
      linux,
      "koed-server-app-runtime-0.4.0-linux-x64.provenance.json.sig"
    ),
    "sig\n"
  );

  const metadata = buildReleaseArtifactMetadata({
    version: "0.4.0",
    tag: "v0.4.0",
    repository: "koed/koed",
    artifactRoot: root
  });

  assert.equal(metadata.release.tag, "v0.4.0");
  assert.equal(
    metadata.artifacts.koedServerAppRuntime.targets[0].archive.url,
    "https://github.com/koed/koed/releases/download/v0.4.0/koed-server-0.4.0-linux-x64.tar.gz"
  );
  assert.equal(
    metadata.artifacts.koedServerAppRuntime.targets[0].archive.sha256,
    "a".repeat(64)
  );
  assert.equal(metadata.artifacts.desktop.kind, "desktop");
  assert.equal(
    metadata.artifacts.koedServerAppRuntime.targets[0].provenance.name,
    "koed-server-app-runtime-0.4.0-linux-x64.provenance.json"
  );
  assert.equal(
    metadata.artifacts.koedServerAppRuntime.targets[0].provenance.signature
      .algorithm,
    "ed25519"
  );
  assert.equal(metadata.artifacts.koedServerAppRuntime.kind, "app-runtime");
  assert.equal(metadata.artifacts.nativeRuntime.kind, "native-runtime");
  assert.equal(metadata.artifacts.models.kind, "models");
  assert.match(
    metadata.artifacts.koedServerAppRuntime.description,
    /exclude native runtime assets, model files, and Python runtime files/
  );
});

test("requires SHA-256 sidecars for koed-server archives", () => {
  const root = tempDir();
  writeFileSync(
    resolve(root, "koed-server-0.4.0-linux-x64.tar.gz"),
    "archive\n"
  );

  assert.throws(
    () =>
      buildReleaseArtifactMetadata({
        version: "0.4.0",
        tag: "v0.4.0",
        repository: "koed/koed",
        artifactRoot: root
      }),
    /Missing SHA-256 sidecar/
  );
});
