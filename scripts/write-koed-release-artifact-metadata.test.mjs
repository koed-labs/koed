import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

const sha256 = (content) => createHash("sha256").update(content).digest("hex");

test.afterEach(() => {
  for (const path of temps.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

test("builds release metadata for standalone koed-server package targets", () => {
  const root = tempDir();
  const linux = resolve(root, "linux-x64");
  const manifestContent = `${JSON.stringify({
    schemaVersion: 1,
    id: "koed-server",
    version: "0.4.0",
    platform: "linux",
    architecture: "x64",
    packageKind: "app-runtime"
  })}\n`;
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
    manifestContent
  );
  writeFileSync(
    resolve(linux, "koed-server-app-runtime-0.4.0-linux-x64.provenance.json"),
    `${JSON.stringify({
      statement: {
        schemaVersion: 1,
        subject: {
          packageKind: "app-runtime",
          id: "koed-server",
          version: "0.4.0",
          platform: "linux",
          architecture: "x64",
          archiveName: "koed-server-0.4.0-linux-x64.tar.gz",
          archiveSha256: "a".repeat(64),
          manifestName: "koed-server-package-manifest.json",
          manifestSha256: sha256(manifestContent)
        }
      },
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
  const native = resolve(root, "native-runtime-linux-x64");
  mkdirSync(native, { recursive: true });
  writeFileSync(
    resolve(native, "koed-native-runtime-linux-x64-0.4.0.tar.gz"),
    "native archive\n"
  );
  writeFileSync(
    resolve(native, "koed-native-runtime-linux-x64-0.4.0.tar.gz.sha256"),
    `${"b".repeat(64)}  koed-native-runtime-linux-x64-0.4.0.tar.gz\n`
  );
  writeFileSync(
    resolve(native, "koed-native-runtime-linux-x64-0.4.0.provenance.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      artifact: {
        version: "0.4.0",
        platform: "linux",
        architecture: "x64"
      }
    })}\n`
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
  assert.equal(metadata.artifacts.desktop.version, "0.4.0");
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
  assert.equal(
    metadata.artifacts.nativeRuntime.targets[0].archive.sha256,
    "b".repeat(64)
  );
  assert.equal(
    metadata.artifacts.nativeRuntime.targets[0].archive.url,
    "https://github.com/koed/koed/releases/download/v0.4.0/koed-native-runtime-linux-x64-0.4.0.tar.gz"
  );
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

test("requires valid provenance for native runtime archives", () => {
  const root = tempDir();
  writeFileSync(
    resolve(root, "koed-native-runtime-linux-x64-0.4.0.tar.gz"),
    "archive\n"
  );
  writeFileSync(
    resolve(root, "koed-native-runtime-linux-x64-0.4.0.tar.gz.sha256"),
    `${"c".repeat(64)}  koed-native-runtime-linux-x64-0.4.0.tar.gz\n`
  );
  writeFileSync(
    resolve(root, "koed-native-runtime-linux-x64-0.4.0.provenance.json"),
    `${JSON.stringify({ schemaVersion: 1 })}\n`
  );

  assert.throws(
    () =>
      buildReleaseArtifactMetadata({
        version: "0.4.0",
        tag: "v0.4.0",
        repository: "koed/koed",
        artifactRoot: root
      }),
    /Invalid native-runtime provenance/
  );
});

test("rejects release artifacts whose versions do not match the product", () => {
  const root = tempDir();
  const native = resolve(root, "native-runtime-linux-x64");
  mkdirSync(native, { recursive: true });
  writeFileSync(
    resolve(native, "koed-native-runtime-linux-x64-0.3.9.tar.gz"),
    "archive\n"
  );
  writeFileSync(
    resolve(native, "koed-native-runtime-linux-x64-0.3.9.tar.gz.sha256"),
    `${"d".repeat(64)}  koed-native-runtime-linux-x64-0.3.9.tar.gz\n`
  );
  writeFileSync(
    resolve(native, "koed-native-runtime-linux-x64-0.3.9.provenance.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      artifact: {
        version: "0.3.9",
        platform: "linux",
        architecture: "x64"
      }
    })}\n`
  );

  assert.throws(
    () =>
      buildReleaseArtifactMetadata({
        version: "0.4.0",
        tag: "v0.4.0",
        repository: "koed/koed",
        artifactRoot: root
      }),
    /Native-runtime archive version mismatch: expected 0\.4\.0, received 0\.3\.9/
  );
});

test("binds flattened app-runtime sidecars to their exact targets", () => {
  const root = tempDir();
  for (const [platform, architecture, hash] of [
    ["linux", "x64", "d"],
    ["macos", "arm64", "e"]
  ]) {
    const archiveName = `koed-server-0.4.0-${platform}-${architecture}.tar.gz`;
    const manifestName = `koed-server-app-runtime-0.4.0-${platform}-${architecture}.manifest.json`;
    const provenanceName = `koed-server-app-runtime-0.4.0-${platform}-${architecture}.provenance.json`;
    const manifestContent = `${JSON.stringify({
      schemaVersion: 1,
      id: "koed-server",
      version: "0.4.0",
      platform,
      architecture,
      packageKind: "app-runtime"
    })}\n`;
    writeFileSync(resolve(root, archiveName), "archive\n");
    writeFileSync(
      resolve(root, `${archiveName}.sha256`),
      `${hash.repeat(64)}  ${archiveName}\n`
    );
    writeFileSync(resolve(root, manifestName), manifestContent);
    writeFileSync(
      resolve(root, provenanceName),
      `${JSON.stringify({
        statement: {
          schemaVersion: 1,
          subject: {
            packageKind: "app-runtime",
            id: "koed-server",
            version: "0.4.0",
            platform,
            architecture,
            archiveName,
            archiveSha256: hash.repeat(64),
            manifestName: "koed-server-package-manifest.json",
            manifestSha256: sha256(manifestContent)
          }
        },
        signature: {
          status: "unsigned-placeholder",
          algorithm: "ed25519"
        }
      })}\n`
    );
  }

  const metadata = buildReleaseArtifactMetadata({
    version: "0.4.0",
    tag: "v0.4.0",
    repository: "koed/koed",
    artifactRoot: root
  });
  const macos = metadata.artifacts.koedServerAppRuntime.targets.find(
    (target) => target.platform === "macos"
  );
  assert.equal(macos.architecture, "arm64");
  assert.match(macos.manifest.name, /macos-arm64/);
  assert.match(macos.provenance.name, /macos-arm64/);
  assert.equal(macos.provenance.signature.status, "unsigned-placeholder");
});

test("rejects swapped app-runtime provenance", () => {
  const root = tempDir();
  const archiveName = "koed-server-0.4.0-macos-arm64.tar.gz";
  writeFileSync(resolve(root, archiveName), "archive\n");
  writeFileSync(
    resolve(root, `${archiveName}.sha256`),
    `${"f".repeat(64)}  ${archiveName}\n`
  );
  writeFileSync(
    resolve(root, "koed-server-app-runtime-0.4.0-macos-arm64.manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "koed-server",
      version: "0.4.0",
      platform: "macos",
      architecture: "arm64",
      packageKind: "app-runtime"
    })
  );
  writeFileSync(
    resolve(root, "koed-server-app-runtime-0.4.0-macos-arm64.provenance.json"),
    JSON.stringify({
      statement: {
        schemaVersion: 1,
        subject: {
          id: "koed-server",
          packageKind: "app-runtime",
          version: "0.4.0",
          platform: "linux",
          architecture: "x64"
        }
      },
      signature: {
        status: "unsigned-placeholder",
        algorithm: "ed25519"
      }
    })
  );

  assert.throws(
    () =>
      buildReleaseArtifactMetadata({
        version: "0.4.0",
        tag: "v0.4.0",
        repository: "koed/koed",
        artifactRoot: root
      }),
    /provenance subject platform mismatch/
  );
});
