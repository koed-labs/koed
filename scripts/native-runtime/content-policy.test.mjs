import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import {
  inspectNativeRuntimeContents,
  pruneNativeRuntimeBuildArtifacts,
  stripNativeRuntimeBinaries
} from "./content-policy.mjs";

const write = (path, content = "fixture") => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

test("prunes build-only native files and preserves nested licences", () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-native-content-"));
  try {
    write(resolve(root, "postgres/include/server/postgres.h"));
    write(resolve(root, "postgres/src/LICENSE"), "licence text");
    write(resolve(root, "postgres/lib/libpq.a"));
    write(resolve(root, "postgres/bin/postgres"));

    const result = pruneNativeRuntimeBuildArtifacts(root);

    assert.equal(existsSync(resolve(root, "postgres/include")), false);
    assert.equal(existsSync(resolve(root, "postgres/src")), false);
    assert.equal(existsSync(resolve(root, "postgres/lib/libpq.a")), false);
    assert.equal(existsSync(resolve(root, "postgres/bin/postgres")), true);
    assert.deepEqual(result.preservedLicences, [
      "third-party-licenses/postgres__src__LICENSE"
    ]);
    assert.equal(
      readFileSync(
        resolve(root, "third-party-licenses/postgres__src__LICENSE"),
        "utf8"
      ),
      "licence text"
    );
    assert.deepEqual(inspectNativeRuntimeContents(root), {
      ok: true,
      forbidden: [],
      duplicateCudaLibraries: []
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strips each detected Linux binary with the reviewed mode", () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-native-content-"));
  try {
    const elf = resolve(root, "llama.cpp/cpu/llama-server");
    write(elf, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    const calls = [];

    const result = stripNativeRuntimeBinaries({
      runtimeRoot: root,
      platform: "linux",
      spawnSync: (command, args) => {
        calls.push({ command, args });
        return { status: 0, stdout: "", stderr: "" };
      }
    });

    assert.deepEqual(calls, [
      { command: "strip", args: ["--strip-unneeded", realpathSync(elf)] }
    ]);
    assert.deepEqual(result.stripped, ["llama.cpp/cpu/llama-server"]);
    assert.deepEqual(result.signed, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ad-hoc signs each detected macOS binary after stripping", () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-native-content-"));
  try {
    const macho = resolve(root, "postgres/bin/initdb");
    write(macho, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
    const calls = [];

    const result = stripNativeRuntimeBinaries({
      runtimeRoot: root,
      platform: "darwin",
      spawnSync: (command, args) => {
        calls.push({ command, args });
        return { status: 0, stdout: "", stderr: "" };
      }
    });

    assert.deepEqual(calls, [
      { command: "/usr/bin/strip", args: ["-x", realpathSync(macho)] },
      {
        command: "/usr/bin/codesign",
        args: ["--force", "--sign", "-", realpathSync(macho)]
      }
    ]);
    assert.deepEqual(result.stripped, ["postgres/bin/initdb"]);
    assert.deepEqual(result.signed, ["postgres/bin/initdb"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports forbidden remnants and duplicate CUDA redistributables", () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-native-content-"));
  try {
    write(resolve(root, "llama.cpp/tests/cuda.cu"));
    mkdirSync(resolve(root, "postgres/include"), { recursive: true });
    write(resolve(root, "llama.cpp/cuda/libcudart.so.12"), "same");
    write(resolve(root, "llama.cpp/cuda/libcudart.so.12.4"), "same");

    const result = inspectNativeRuntimeContents(root);

    assert.equal(result.ok, false);
    assert.deepEqual(result.forbidden, [
      "llama.cpp/tests",
      "llama.cpp/tests/cuda.cu",
      "postgres/include"
    ]);
    assert.deepEqual(result.duplicateCudaLibraries[0]?.paths, [
      "llama.cpp/cuda/libcudart.so.12",
      "llama.cpp/cuda/libcudart.so.12.4"
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
