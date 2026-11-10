import assert from "node:assert/strict";
import test from "node:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import * as identity from "./reviewed-build-identity.mjs";
import {
  candidateFixture,
  runtimeIdentities
} from "./test-utils/release-candidate-fixture.mjs";

test("reviewed identity hashes independent build output and rejects colliding output bytes", () => {
  mkdirSync("scratch", { recursive: true });
  const root = mkdtempSync(resolve("scratch/build-identity-test-"));
  try {
    assert.equal(typeof identity.collectReviewedAssets, "function");
    mkdirSync(resolve(root, "first"));
    mkdirSync(resolve(root, "second"));
    writeFileSync(resolve(root, "first/file.txt"), "hello\n");
    assert.deepEqual(identity.collectReviewedAssets(root), [
      {
        name: "file.txt",
        sha256:
          "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03"
      }
    ]);
    writeFileSync(resolve(root, "second/file.txt"), "substitution");
    assert.throws(() => identity.collectReviewedAssets(root), /Conflicting/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("public inventory excludes nested catalog components and includes staged sidecars", () => {
  mkdirSync("scratch", { recursive: true });
  const root = mkdtempSync(resolve("scratch/public-inventory-"));
  try {
    for (const name of [
      "koed-component-catalog",
      "koed-server-app-runtime-linux-x64",
      "koed-server-app-runtime-macos-arm64",
      "koed-desktop-final-assets",
      "koed-desktop-linux-final-assets",
      "koed-native-runtime-linux-x64",
      "koed-linux-native-packages",
      "koed-macos-native-packages",
      "koed-private-frozen-macos-native-runtime",
      "koed-release-metadata"
    ])
      mkdirSync(resolve(root, name), { recursive: true });
    mkdirSync(
      resolve(root, "koed-component-catalog/components/base/node_modules/pkg"),
      { recursive: true }
    );
    writeFileSync(
      resolve(
        root,
        "koed-component-catalog/components/base/node_modules/pkg/private.js"
      ),
      "private"
    );
    writeFileSync(
      resolve(root, "koed-component-catalog/component-manifest-hashes.json"),
      "catalog"
    );
    for (const name of [
      "koed-distribution-1.2.3-linux-x64.json",
      "koed-server-app-runtime-1.2.3-linux-x64.provenance.json.sig",
      "koed-server-app-runtime-linux-x64-artifact-size-report.json"
    ])
      writeFileSync(
        resolve(root, "koed-server-app-runtime-linux-x64", name),
        name
      );
    writeFileSync(
      resolve(
        root,
        "koed-desktop-final-assets/desktop-artifact-size-report.json"
      ),
      "report"
    );
    writeFileSync(
      resolve(root, "koed-macos-native-packages/native-runtime-catalog.json"),
      "mac catalog"
    );
    writeFileSync(
      resolve(root, "koed-private-frozen-macos-native-runtime/frozen.tar.gz"),
      "private"
    );
    const names = identity
      .collectPublicReleaseAssets(root)
      .map((asset) => asset.name);
    assert.deepEqual(
      names.sort(),
      [
        "component-manifest-hashes.json",
        "desktop-artifact-size-report.json",
        "native-runtime-catalog.json",
        "koed-distribution-1.2.3-linux-x64.json",
        "koed-server-app-runtime-1.2.3-linux-x64.provenance.json.sig",
        "koed-server-app-runtime-linux-x64-artifact-size-report.json"
      ].sort()
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const approvedNames = [
  "koed-component-catalog",
  "koed-server-app-runtime-linux-x64",
  "koed-server-app-runtime-macos-arm64",
  "koed-desktop-final-assets",
  "koed-desktop-linux-final-assets",
  "koed-native-runtime-linux-x64",
  "koed-linux-native-packages",
  "koed-macos-native-packages",
  "koed-release-metadata",
  "koed-private-frozen-macos-native-runtime"
];
const buildInput = (fixture) => ({
  root: resolve(fixture.root, "reviewed"),
  repository: "org/repo",
  commit: "a".repeat(40),
  runId: 42,
  runAttempt: 1,
  version: "1.2.3",
  artifacts: approvedNames.map((name, index) => ({
    name,
    id: index + 1,
    digest: `sha256:${"b".repeat(64)}`,
    expired: false,
    workflow_run: { id: 42, head_sha: "a".repeat(40) }
  }))
});

const createIdentity = (fixture, input) => {
  for (const name of approvedNames)
    mkdirSync(resolve(input.root, name), { recursive: true });
  for (const name of readdirSync(fixture.assetsDir)) {
    const source =
      name === "component-manifest-hashes.json"
        ? "koed-component-catalog"
        : name.endsWith(".AppImage") ||
            name.startsWith("koed-desktop-linux-x64.")
          ? "koed-desktop-linux-final-assets"
          : "koed-server-app-runtime-linux-x64";
    copyFileSync(
      resolve(fixture.assetsDir, name),
      resolve(input.root, source, name)
    );
  }
  return identity.createReviewedBuildIdentity(input);
};

test("createReviewedBuildIdentity binds approved outputs to the current attempt and runtime matrix", () => {
  const f = candidateFixture();
  try {
    writeFileSync(
      resolve(f.assetsDir, "Koed-1.2.3-arm64.zip"),
      "protected zip"
    );
    writeFileSync(resolve(f.assetsDir, "Koed-1.2.3-x86_64.AppImage"), "image");
    writeFileSync(
      resolve(f.assetsDir, "koed-desktop-linux-x64.sha256"),
      "checksum"
    );
    writeFileSync(
      resolve(f.assetsDir, "koed-desktop-linux-x64.evidence.json"),
      "{}"
    );
    const firstAttempt = createIdentity(f, buildInput(f));
    const retryInput = buildInput(f);
    retryInput.runAttempt = 2;
    const retriedBuild = createIdentity(f, retryInput);

    assert.equal(firstAttempt.runAttempt, 1);
    assert.equal(retriedBuild.runAttempt, 2);
    assert.deepEqual(retriedBuild.runtimeIdentities, runtimeIdentities);
    assert.equal(retriedBuild.artifacts.length, approvedNames.length);
    assert.ok(
      retriedBuild.artifacts.some(
        (artifact) =>
          artifact.name === "koed-private-frozen-macos-native-runtime" &&
          artifact.id === approvedNames.length
      )
    );
    assert.ok(
      retriedBuild.artifacts.some(
        (artifact) => artifact.name === "koed-macos-native-packages"
      )
    );
    assert.deepEqual(retriedBuild.npm, f.identity.npm);
    assert.deepEqual(retriedBuild.linuxDesktop, {
      asset: "Koed-1.2.3-x86_64.AppImage",
      checksum: "koed-desktop-linux-x64.sha256",
      evidence: "koed-desktop-linux-x64.evidence.json",
      asarEntry: "resources/app.asar"
    });
  } finally {
    f.cleanup();
  }
});

for (const damage of [
  "repository",
  "commit",
  "run",
  "attempt",
  "missing-artifact",
  "duplicate-artifact",
  "expired-artifact",
  "artifact-commit",
  "artifact-run",
  "artifact-digest",
  "npm-name",
  "npm-version",
  "npm-integrity",
  "npm-inventory",
  "npm-bytes",
  "missing-zip",
  "duplicate-zip",
  "missing-linux-artifact",
  "duplicate-linux-artifact",
  "linux-artifact-run",
  "linux-artifact-commit",
  "missing-appimage",
  "duplicate-appimage",
  "missing-checksum",
  "missing-evidence"
])
  test(`createReviewedBuildIdentity rejects ${damage}`, () => {
    const f = candidateFixture();
    try {
      const input = buildInput(f);
      const zip = resolve(f.assetsDir, "Koed-1.2.3-arm64.zip");
      writeFileSync(zip, "protected zip");
      const image = resolve(f.assetsDir, "Koed-1.2.3-x86_64.AppImage");
      const checksum = resolve(f.assetsDir, "koed-desktop-linux-x64.sha256");
      const evidence = resolve(
        f.assetsDir,
        "koed-desktop-linux-x64.evidence.json"
      );
      writeFileSync(image, "image");
      writeFileSync(checksum, "checksum");
      writeFileSync(evidence, "{}");
      const linuxArtifact = input.artifacts.find(
        (a) => a.name === "koed-desktop-linux-final-assets"
      );
      if (damage === "missing-linux-artifact")
        input.artifacts = input.artifacts.filter((a) => a !== linuxArtifact);
      if (damage === "duplicate-linux-artifact")
        input.artifacts.push({ ...linuxArtifact });
      if (damage === "linux-artifact-run") linuxArtifact.workflow_run.id = 43;
      if (damage === "linux-artifact-commit")
        linuxArtifact.workflow_run.head_sha = "f".repeat(40);
      if (damage === "missing-appimage") rmSync(image);
      if (damage === "duplicate-appimage")
        writeFileSync(
          resolve(f.assetsDir, "Koed-other-x86_64.AppImage"),
          "other"
        );
      if (damage === "missing-checksum") rmSync(checksum);
      if (damage === "missing-evidence") rmSync(evidence);
      if (damage === "repository") input.repository = "not-a-repository";
      if (damage === "commit") input.commit = "f".repeat(40);
      if (damage === "run") input.runId = 43;
      if (damage === "attempt") input.runAttempt = 0;
      if (damage === "missing-artifact") input.artifacts.pop();
      if (damage === "duplicate-artifact")
        input.artifacts.push(input.artifacts[0]);
      if (damage === "expired-artifact") input.artifacts[0].expired = true;
      if (damage === "artifact-commit")
        input.artifacts[0].workflow_run.head_sha = "f".repeat(40);
      if (damage === "artifact-run") input.artifacts[0].workflow_run.id = 43;
      if (damage === "artifact-digest") input.artifacts[0].digest = "bad";
      if (damage === "missing-zip") rmSync(zip);
      if (damage === "duplicate-zip")
        writeFileSync(resolve(f.assetsDir, "Koed-other-arm64.zip"), "other");
      if (damage.startsWith("npm-")) {
        const value = structuredClone(f.identity);
        if (damage === "npm-name") value.packageName = "@other/server";
        if (damage === "npm-version") value.version = "9.0.0";
        if (damage === "npm-integrity") value.npm.integrity = "bad";
        if (damage === "npm-inventory") value.npm.inventorySha256 = "bad";
        if (damage === "npm-bytes") value.npm.bytes = 0;
        writeFileSync(
          resolve(f.assetsDir, "koed-labs-server-release-identity.json"),
          JSON.stringify(value)
        );
      }
      assert.throws(
        () => createIdentity(f, input),
        /identity|artifact|ZIP|AppImage|checksum/i
      );
    } finally {
      f.cleanup();
    }
  });
