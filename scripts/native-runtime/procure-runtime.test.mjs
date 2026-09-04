import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  llamaLauncher,
  pgvectorBuildArgs,
  stageFlattenedRuntimeFiles
} from "./procure-runtime.mjs";

const executable = (path, body) => {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
};

const fixture = () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-llama-launcher-"));
  const launcher = resolve(root, "llama-server");
  writeFileSync(launcher, llamaLauncher, { mode: 0o755 });
  chmodSync(launcher, 0o755);
  return { root, launcher };
};

test("staging preserves shared-library aliases as relative symlinks", () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-llama-staging-"));
  try {
    const source = resolve(root, "source");
    const target = resolve(root, "target");
    mkdirSync(source, { recursive: true });
    mkdirSync(target, { recursive: true });
    const library = resolve(source, "libllama.so.0.1.2");
    writeFileSync(library, "native-library");
    symlinkSync("libllama.so.0.1.2", resolve(source, "libllama.so.0"));
    symlinkSync("libllama.so.0", resolve(source, "libllama.so"));

    stageFlattenedRuntimeFiles(
      [
        resolve(source, "libllama.so"),
        resolve(source, "libllama.so.0"),
        library
      ],
      target
    );

    assert.equal(
      lstatSync(resolve(target, "libllama.so")).isSymbolicLink(),
      true
    );
    assert.equal(
      lstatSync(resolve(target, "libllama.so.0")).isSymbolicLink(),
      true
    );
    assert.equal(
      lstatSync(resolve(target, "libllama.so.0.1.2")).isFile(),
      true
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pgvector builds do not target the cache runner CPU", () => {
  assert.deepEqual(pgvectorBuildArgs("/runtime/postgres/bin/pg_config"), [
    "PG_CONFIG=/runtime/postgres/bin/pg_config",
    "OPTFLAGS="
  ]);
});

test("macOS-style Metal payload also supports explicit CPU mode", () => {
  const { root, launcher } = fixture();
  try {
    executable(
      resolve(root, "metal", "llama-server"),
      'printf "metal:%s" "$*"'
    );
    const output = execFileSync(launcher, ["--n-gpu-layers", "0"], {
      env: { ...process.env, KOED_LLAMA_SERVER_BACKEND: "cpu" },
      encoding: "utf8"
    });
    assert.equal(output, "metal:--n-gpu-layers 0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("automatic selection probes CUDA and otherwise uses CPU", () => {
  const { root, launcher } = fixture();
  try {
    executable(resolve(root, "cpu", "llama-server"), 'printf "cpu:%s" "$*"');
    executable(
      resolve(root, "cuda", "llama-server"),
      'if [ "${1:-}" = "--list-devices" ]; then echo "  CUDA0: fixture"; else printf "cuda:%s" "$*"; fi'
    );
    const output = execFileSync(launcher, ["--embedding"], {
      env: { ...process.env, KOED_LLAMA_SERVER_BACKEND: "auto" },
      encoding: "utf8"
    });
    assert.equal(output, "cuda:--embedding");

    executable(
      resolve(root, "cuda", "llama-server"),
      'if [ "${1:-}" = "--list-devices" ]; then echo "no devices"; else exit 1; fi'
    );
    const fallback = execFileSync(launcher, ["--embedding"], {
      env: { ...process.env, KOED_LLAMA_SERVER_BACKEND: "auto" },
      encoding: "utf8"
    });
    assert.equal(fallback, "cpu:--embedding");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("forced unavailable backend exits without falling back", () => {
  const { root, launcher } = fixture();
  try {
    executable(resolve(root, "cpu", "llama-server"), 'printf "cpu:%s" "$*"');
    const result = spawnSync(launcher, ["--embedding"], {
      env: { ...process.env, KOED_LLAMA_SERVER_BACKEND: "cuda" },
      encoding: "utf8"
    });
    assert.equal(result.status, 69);
    assert.match(result.stderr, /backend 'cuda' is not installed/);
    assert.equal(result.stdout, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
