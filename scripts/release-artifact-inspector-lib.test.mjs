import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  evaluateArtifactPolicy,
  inspectArchive,
  inspectTree
} from "./release-artifact-inspector-lib.mjs";

const roots = [];
const permissivePolicy = {
  maxDuplicateRatio: 1,
  maxManifestBytes: Number.MAX_SAFE_INTEGER
};
test.afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const fixture = () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-artifact-inspector-"));
  roots.push(root);
  for (const alias of ["one", "two", "three"]) {
    const dir = resolve(
      root,
      "node_modules",
      ".pnpm",
      alias,
      "node_modules",
      "native-provider",
      "linux-x64"
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "provider.so"), "synthetic-native-payload");
  }
  writeFileSync(
    resolve(root, "koed-server-package-manifest.json"),
    JSON.stringify({ schemaVersion: 1 })
  );
  return root;
};

const tarHeader = (path, size, type = "0", linkname = "") => {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, "utf8");
  const octal = (offset, length, value) =>
    header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset);
  octal(100, 8, type === "5" ? 0o755 : 0o644);
  octal(108, 8, 0);
  octal(116, 8, 0);
  octal(124, 12, size);
  octal(136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1);
  header.write(linkname, 157, 100, "utf8");
  header.write("ustar", 257, 6);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  octal(148, 8, checksum);
  return header;
};

const pad = (content) =>
  content.length % 512 === 0
    ? content
    : Buffer.concat([content, Buffer.alloc(512 - (content.length % 512))]);

const elf = (machine) => {
  const header = Buffer.alloc(64);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  header.writeUInt16LE(machine, 18);
  return header;
};

const machO = (cpu) => {
  const header = Buffer.alloc(64);
  header.set([0xcf, 0xfa, 0xed, 0xfe]);
  header.writeUInt32LE(cpu, 4);
  return header;
};

const pe = (machine) => {
  const header = Buffer.alloc(256);
  header.write("MZ", 0, "ascii");
  header.writeUInt32LE(0x80, 0x3c);
  header.set([0x50, 0x45, 0, 0], 0x80);
  header.writeUInt16LE(machine, 0x84);
  return header;
};

test("detects triplicated pnpm-style native payloads deterministically", async () => {
  const root = fixture();
  const first = await inspectTree({
    path: root,
    platform: "linux",
    architecture: "x64"
  });
  const second = await inspectTree({
    path: root,
    platform: "linux",
    architecture: "x64"
  });
  assert.deepEqual(second, first);
  assert.equal(first.bytes.duplicateContent, 48);
  assert.equal(first.bytes.duplicateRatio > 0, true);
  assert.equal(
    first.largestFiles.filter((file) => file.path.endsWith("provider.so"))
      .length,
    3
  );
});

test("permits in-package relative symlinks and rejects unsafe targets", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-artifact-symlink-"));
  roots.push(root);
  writeFileSync(resolve(root, "library.so.1"), "native-library");
  symlinkSync("library.so.1", resolve(root, "library.so"));

  const safe = await inspectTree({
    path: root,
    platform: "linux",
    architecture: "x64"
  });
  assert.deepEqual(safe.findings.unsafeSymlinks, []);
  assert.equal(evaluateArtifactPolicy(safe, permissivePolicy).ok, true);

  symlinkSync("../../outside", resolve(root, "unsafe.so"));
  const unsafe = await inspectTree({
    path: root,
    platform: "linux",
    architecture: "x64"
  });
  assert.deepEqual(unsafe.findings.unsafeSymlinks, ["unsafe.so"]);
  assert.match(
    evaluateArtifactPolicy(unsafe, permissivePolicy).errors.join("\n"),
    /unsafeSymlinks/
  );
});

test("archive inspection resolves relative symlink targets", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-artifact-symlink-archive-"));
  roots.push(root);
  const archive = resolve(root, "fixture.tar.gz");
  const payload = Buffer.from("native-library");
  const tar = Buffer.concat([
    tarHeader("fixture/", 0, "5"),
    tarHeader("fixture/library.so.1", payload.length),
    pad(payload),
    tarHeader("fixture/library.so", 0, "2", "library.so.1"),
    Buffer.alloc(1024)
  ]);
  writeFileSync(archive, gzipSync(tar, { mtime: 0 }));

  const report = await inspectArchive({
    path: archive,
    platform: "linux",
    architecture: "x64"
  });
  assert.deepEqual(report.findings.unsafeSymlinks, []);
  assert.equal(evaluateArtifactPolicy(report, permissivePolicy).ok, true);
});

test("uses the checked-in policy and immutable baseline", async () => {
  const root = fixture();
  const report = await inspectTree({
    path: root,
    platform: "linux",
    architecture: "x64"
  });
  const policy = JSON.parse(
    readFileSync(resolve("config/release-artifact-size-policy.json"), "utf8")
  );
  const baseline = JSON.parse(
    readFileSync(
      resolve("config/release-artifact-baseline-v0.6.2.json"),
      "utf8"
    )
  );
  assert.equal(baseline.immutable, true);
  assert.equal(baseline.release, "v0.6.2");
  assert.equal(evaluateArtifactPolicy(report, policy).ok, false);
});

test("reports compressed and expanded archive composition", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-artifact-archive-"));
  roots.push(root);
  const payload = Buffer.from("synthetic-native-payload");
  const manifest = Buffer.from('{"schemaVersion":1}');
  const blocks = [tarHeader("fixture/", 0, "5")];
  for (const alias of ["one", "two", "three"]) {
    const path = `fixture/node_modules/.pnpm/${alias}/node_modules/native-provider/linux-x64/provider.so`;
    blocks.push(tarHeader(path, payload.length), pad(payload));
  }
  blocks.push(
    tarHeader("fixture/koed-server-package-manifest.json", manifest.length),
    pad(manifest),
    Buffer.alloc(1024)
  );
  const archive = resolve(root, "fixture.tar.gz");
  writeFileSync(archive, gzipSync(Buffer.concat(blocks)));

  const report = await inspectArchive({
    path: archive,
    platform: "linux",
    architecture: "x64"
  });
  assert.equal(report.bytes.archive > 0, true);
  assert.equal(report.bytes.manifest, manifest.length);
  assert.equal(report.entryCounts.file, 4);
  assert.equal(report.bytes.duplicateContent, payload.length * 2);
});

test("detects foreign native targets from binary headers without path tokens", async () => {
  for (const [name, content, platform, architecture] of [
    ["binding.node", elf(183), "linux", "x64"],
    ["libfoo.dylib", machO(0x01000007), "macos", "arm64"],
    ["plugin.dll", pe(0xaa64), "windows", "x64"]
  ]) {
    const root = mkdtempSync(resolve(tmpdir(), "koed-native-target-"));
    roots.push(root);
    writeFileSync(resolve(root, name), content);

    const report = await inspectTree({ path: root, platform, architecture });

    assert.deepEqual(report.findings.foreignPlatformNativeFiles, [name]);
    assert.match(
      evaluateArtifactPolicy(report, permissivePolicy).errors.join("\n"),
      /foreignPlatformNativeFiles/
    );
  }
});

test("detects a neutral-path foreign native target in a streamed archive", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-native-archive-target-"));
  roots.push(root);
  const content = elf(183);
  const path = "fixture/node_modules/provider/binding.node";
  const archive = resolve(root, "fixture.tar.gz");
  writeFileSync(
    archive,
    gzipSync(
      Buffer.concat([
        tarHeader(path, content.length),
        pad(content),
        Buffer.alloc(1024)
      ])
    )
  );

  const report = await inspectArchive({
    path: archive,
    platform: "linux",
    architecture: "x64"
  });

  assert.deepEqual(report.findings.foreignPlatformNativeFiles, [path]);
  assert.match(
    evaluateArtifactPolicy(report, permissivePolicy).errors.join("\n"),
    /foreignPlatformNativeFiles/
  );
});

test("detects checkout paths split across streamed archive chunks", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-checkout-leak-"));
  roots.push(root);
  const content = Buffer.concat([
    Buffer.alloc(15_348, 0x61),
    Buffer.from("/Users/alice/checkout")
  ]);
  const path = "fixture/config.json";
  const archive = resolve(root, "fixture.tar.gz");
  writeFileSync(
    archive,
    gzipSync(
      Buffer.concat([
        tarHeader(path, content.length),
        pad(content),
        Buffer.alloc(1024)
      ])
    )
  );

  const report = await inspectArchive({
    path: archive,
    platform: "linux",
    architecture: "x64"
  });

  assert.deepEqual(report.findings.sourceCheckoutLeaks, [path]);
  assert.match(
    evaluateArtifactPolicy(report, permissivePolicy).errors.join("\n"),
    /sourceCheckoutLeaks/
  );
});

test("attributes native-runtime components and enforces immutable growth", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-native-inspector-"));
  roots.push(root);
  for (const [path, content] of [
    ["koed-runtime/postgres/bin/postgres", "postgres"],
    ["koed-runtime/postgres/lib/vector.so", "vector"],
    ["koed-runtime/llama.cpp/cpu/llama-server", "cpu"],
    ["koed-runtime/llama.cpp/cuda/llama-server", "cuda"],
    ["koed-runtime/llama.cpp/cuda/libcublas.so.12", "redistributable"],
    ["koed-runtime/runtime-asset-manifest.json", "manifest"],
    ["koed-runtime/provenance.json", "provenance"]
  ]) {
    const target = resolve(root, path);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  const report = await inspectTree({
    path: root,
    platform: "linux",
    architecture: "x64"
  });
  assert.deepEqual(
    new Set(report.nativeRuntimeComponents.map((entry) => entry.name)),
    new Set([
      "postgresql",
      "pgvector",
      "llama.cpp-cpu",
      "llama.cpp-cuda",
      "cuda-redistributable-libraries",
      "manifests-and-provenance"
    ])
  );

  const policy = JSON.parse(
    readFileSync(resolve("config/release-artifact-size-policy.json"), "utf8")
  );
  const oversized = {
    ...report,
    source: "koed-native-runtime-linux-x64-0.7.0.tar.gz",
    bytes: { ...report.bytes, archive: 200 }
  };
  const baseline = {
    artifacts: { "koed-native-runtime-linux-x64-0.6.2.tar.gz": 100 }
  };
  const result = evaluateArtifactPolicy(oversized, policy, baseline);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /growth gate/);

  const standalone = {
    ...report,
    source: "koed-server-0.7.0-macos-arm64.tar.gz",
    target: { platform: "macos", architecture: "arm64" },
    bytes: { ...report.bytes, archive: 75 }
  };
  const standaloneResult = evaluateArtifactPolicy(standalone, policy, {
    artifacts: { "koed-server-0.6.2-macos-arm64.tar.gz": 100 }
  });
  assert.equal(standaloneResult.ok, false);
  assert.match(standaloneResult.errors.join("\n"), /reduction gate/);
});
