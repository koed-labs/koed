import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { writeRuntimeAssetManifest } from "./manifest-lib.mjs";
import { deterministicArchiveEntries } from "../deterministic-tar-gzip.mjs";
import { canonicalArtifactJson } from "../../packages/koed-server/src/artifact-canonical-json.mjs";

const frozenDigest = (root) => {
  const inventory = deterministicArchiveEntries(root).map((entry) => {
    const path = entry.relativePath.replace(/\/$/, "");
    const mode = entry.type === "symlink" ? 0o777 : entry.stat.mode & 0o777;
    if (entry.type === "directory") return { path, type: "directory", mode };
    if (entry.type === "symlink")
      return { path, type: "symlink", mode, target: readlinkSync(entry.path) };
    if (entry.type !== "file") throw new Error("Unexpected test fixture entry");
    const bytes = readFileSync(entry.path);
    return {
      path,
      type: "file",
      mode,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex")
    };
  });
  return createHash("sha256")
    .update(canonicalArtifactJson(inventory))
    .digest("hex");
};
const macho = Buffer.from("cffaedfe0c0000010000000002000000", "hex");
const machoLibrary = Buffer.from("cffaedfe0c0000010000000008000000", "hex");

const script = resolve("scripts/native-runtime/stage-macos-core.mjs");
const sources = JSON.parse(
  readFileSync("scripts/native-runtime/sources.macos-arm64.json", "utf8")
);
const fixture = () => {
  mkdirSync("scratch", { recursive: true });
  const root = mkdtempSync(resolve("scratch/macos-core-"));
  const input = resolve(root, "input");
  for (const path of [
    "postgres/bin/postgres",
    "postgres/bin/initdb",
    "postgres/bin/pg_ctl",
    "postgres/bin/psql",
    "postgres/bin/pg_dump",
    "postgres/bin/pg_restore",
    "postgres/lib/vector.so",
    "postgres/lib/pgcrypto.so",
    "llama.cpp/llama-server",
    "llama.cpp/metal/llama-server",
    "llama.cpp/metal/LICENSE",
    "third-party-licenses/openssl/LICENSE.txt",
    "third-party-licenses/postgres/COPYRIGHT",
    "third-party-licenses/pgvector/LICENSE"
  ]) {
    const file = resolve(input, path);
    mkdirSync(dirname(file), { recursive: true });
    const binary =
      path.startsWith("postgres/bin/") ||
      path.startsWith("postgres/lib/") ||
      path === "llama.cpp/metal/llama-server";
    writeFileSync(
      file,
      binary
        ? path.startsWith("postgres/lib/")
          ? machoLibrary
          : macho
        : path === "llama.cpp/llama-server"
          ? "#!/bin/sh\nexit 0\n"
          : path,
      {
        mode:
          path.includes("/bin/") || path.endsWith("llama-server")
            ? 0o755
            : 0o644
      }
    );
  }
  writeRuntimeAssetManifest({
    runtimeRoot: input,
    platform: "macos",
    architecture: "arm64"
  });
  writeFileSync(
    resolve(input, "provenance.json"),
    JSON.stringify({
      schemaVersion: 1,
      artifact: { platform: "macos", architecture: "arm64", version: "1.2.3" },
      source: { kind: "pinned-sources", manifest: sources }
    })
  );
  return { root, input, approved: frozenDigest(input) };
};
const run = (input, out, approved = frozenDigest(input)) =>
  spawnSync(
    process.execPath,
    [
      script,
      "--source-dir",
      input,
      "--out-dir",
      out,
      "--version",
      "1.2.3",
      "--frozen-inventory-sha256",
      approved
    ],
    { encoding: "utf8" }
  );

test("macOS core preserves frozen bytes and reproducibly packages Metal and licenses", () => {
  const { root, input } = fixture();
  try {
    const a = resolve(root, "a"),
      b = resolve(root, "b");
    const inspected = spawnSync(
      process.execPath,
      [script, "--source-dir", input, "--inspect-inventory"],
      { encoding: "utf8" }
    );
    assert.equal(inspected.status, 0, inspected.stderr);
    assert.equal(inspected.stdout.trim(), frozenDigest(input));
    const first = run(input, a),
      second = run(input, b);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    const report = JSON.parse(first.stdout);
    assert.deepEqual(report, JSON.parse(second.stdout));
    assert.match(
      report.archive,
      /^koed-native-core-[a-f0-9]{64}-macos-arm64\.tar\.gz$/
    );
    const bytes = readFileSync(resolve(a, report.archive));
    assert.deepEqual(bytes, readFileSync(resolve(b, report.archive)));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      report.sha256
    );
    assert.equal(bytes.length, report.archiveBytes);
    assert.deepEqual(
      readFileSync(resolve(a, "koed-runtime/llama.cpp/metal/llama-server")),
      readFileSync(resolve(input, "llama.cpp/metal/llama-server"))
    );
    assert.deepEqual(
      readFileSync(
        resolve(a, "koed-runtime/third-party-licenses/openssl/LICENSE.txt")
      ),
      readFileSync(resolve(input, "third-party-licenses/openssl/LICENSE.txt"))
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("freeze evidence contains canonical full inventory only with matching independent approval", () => {
  const { root, input, approved } = fixture();
  try {
    const evidence = resolve(root, "inventory.json");
    const emit = (digest) =>
      spawnSync(
        process.execPath,
        [
          script,
          "--source-dir",
          input,
          "--write-inventory",
          evidence,
          "--frozen-inventory-sha256",
          digest
        ],
        { encoding: "utf8" }
      );
    const rejected = emit("0".repeat(64));
    assert.notEqual(rejected.status, 0);
    assert.equal(emit(approved).status, 0);
    const bytes = readFileSync(evidence, "utf8");
    const inventory = JSON.parse(bytes);
    assert.equal(bytes, `${canonicalArtifactJson(inventory)}\n`);
    assert.equal(
      createHash("sha256")
        .update(canonicalArtifactJson(inventory))
        .digest("hex"),
      approved
    );
    assert.ok(inventory.some((entry) => entry.path === "provenance.json"));
    assert.notEqual(
      emit(approved).status,
      0,
      "evidence must not be overwritten"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staging rejects empty and nested Metal directories before packaging", () => {
  for (const path of ["postgres/share/unrelated", "llama.cpp/metal/nested"]) {
    const { root, input } = fixture();
    try {
      mkdirSync(resolve(input, path), { recursive: true });
      const result = run(input, resolve(root, "out"));
      assert.notEqual(result.status, 0, path);
      assert.match(result.stderr, /unexpected.*(?:directory|payload)/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("packaging and canonicalization changes alter recipe identity", () => {
  const { root, input, approved } = fixture();
  try {
    const copy = resolve(root, "code");
    for (const name of [
      "scripts/native-runtime/stage-macos-core.mjs",
      "scripts/native-runtime/macos-inventory.mjs",
      "scripts/native-runtime/core-artifact.mjs",
      "scripts/native-runtime/manifest-lib.mjs",
      "scripts/deterministic-tar-gzip.mjs",
      "packages/koed-server/src/artifact-canonical-json.mjs",
      "config/release-artifact-size-policy.json"
    ]) {
      const destination = resolve(copy, name);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(resolve(name), destination);
    }
    const isolated = resolve(
      copy,
      "scripts/native-runtime/stage-macos-core.mjs"
    );
    const stage = (name) => {
      const result = spawnSync(
        process.execPath,
        [
          isolated,
          "--source-dir",
          input,
          "--out-dir",
          resolve(root, name),
          "--version",
          "1.2.3",
          "--frozen-inventory-sha256",
          approved
        ],
        { encoding: "utf8" }
      );
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout).recipeId;
    };
    let previous = stage("one");
    for (const [index, path] of [
      "scripts/deterministic-tar-gzip.mjs",
      "packages/koed-server/src/artifact-canonical-json.mjs"
    ].entries()) {
      const file = resolve(copy, path);
      writeFileSync(
        file,
        `${readFileSync(file, "utf8")}\n// changed identity-affecting implementation\n`
      );
      const current = stage(`changed-${index}`);
      assert.notEqual(current, previous, path);
      previous = current;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staging requires the frozen inventory digest", () => {
  const { root, input } = fixture();
  try {
    const result = spawnSync(
      process.execPath,
      [
        script,
        "--source-dir",
        input,
        "--out-dir",
        resolve(root, "out"),
        "--version",
        "1.2.3"
      ],
      { encoding: "utf8" }
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /frozen-inventory-sha256/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Desktop inventory rejects an unapproved core manifest in the source tree", () => {
  const { root, input, approved } = fixture();
  try {
    writeFileSync(resolve(input, "native-core-manifest.json"), "unapproved");
    const result = run(input, resolve(root, "out"), approved);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unexpected payload/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staging rejects altered payload with regenerated local asset manifest", () => {
  const { root, input, approved } = fixture();
  try {
    writeFileSync(
      resolve(input, "llama.cpp/metal/llama-server"),
      Buffer.concat([macho, Buffer.from("tampered")])
    );
    writeRuntimeAssetManifest({
      runtimeRoot: input,
      platform: "macos",
      architecture: "arm64"
    });
    const result = run(input, resolve(root, "out"), approved);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /approved.*inventory/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staging rejects changed or empty licenses", () => {
  const { root, input, approved } = fixture();
  try {
    const path = resolve(input, "third-party-licenses/openssl/LICENSE.txt");
    writeFileSync(path, "substituted");
    assert.notEqual(run(input, resolve(root, "changed"), approved).status, 0);
    writeFileSync(path, "");
    const empty = run(input, resolve(root, "empty"));
    assert.notEqual(empty.status, 0);
    assert.match(empty.stderr, /license/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staging rejects foreign binaries and unexpected executables inside allowed directories", () => {
  for (const [name, content] of [
    ["postgres/lib/foreign.so", Buffer.from("7f454c4600000000", "hex")],
    ["llama.cpp/metal/bad.dll", Buffer.from("MZ foreign")],
    ["postgres/bin/unknown", Buffer.from("#!/bin/sh\ntrue\n")],
    ["postgres/bin/hidden-arm64", macho],
    [
      "postgres/lib/hidden.so",
      Buffer.from("cffaedfe0c0000010000000002000000", "hex")
    ]
  ]) {
    const { root, input } = fixture();
    try {
      writeFileSync(resolve(input, name), content, { mode: 0o755 });
      writeRuntimeAssetManifest({
        runtimeRoot: input,
        platform: "macos",
        architecture: "arm64"
      });
      const result = run(input, resolve(root, "out"));
      assert.notEqual(result.status, 0, name);
      assert.match(result.stderr, /macOS|foreign|executable/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("macOS core rejects unexpected non-executable files inside allowed roots", () => {
  for (const name of [
    "postgres/share/unexpected.sh",
    "postgres/share/postgresql/unknown.txt",
    "postgres/lib/notes.txt",
    "llama.cpp/metal/notes.txt",
    "third-party-licenses/extra/payload.txt"
  ]) {
    const { root, input } = fixture();
    try {
      const file = resolve(input, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "unrelated data\n", { mode: 0o644 });
      writeRuntimeAssetManifest({
        runtimeRoot: input,
        platform: "macos",
        architecture: "arm64"
      });
      const result = run(input, resolve(root, "out"));
      assert.notEqual(result.status, 0, name);
      assert.match(result.stderr, /unexpected.*(?:file|payload)/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("macOS core accepts expected PostgreSQL data and retained license layout", () => {
  const { root, input } = fixture();
  try {
    for (const [name, content] of [
      ["postgres/share/postgres.bki", "data"],
      ["postgres/share/postgresql/postgres.bki", "data"],
      ["postgres/share/postgresql/extension/vector.control", "data"],
      ["postgres/share/postgresql/extension/vector--0.8.3.sql", "data"],
      ["postgres/share/postgresql/timezone/Europe/London", "TZif data"],
      ["postgres/share/postgresql/timezonesets/Default", "data"],
      ["postgres/share/postgresql/tsearch_data/english.stop", "data"],
      ["postgres/share/man/man1/psql.1", "manual"],
      ["postgres/lib/pkgconfig/libpq.pc", "data"],
      ["third-party-licenses/postgres__src__LICENSE", "license"]
    ]) {
      const file = resolve(input, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    const scripts = [
      "postgres/lib/pgxs/config/install-sh",
      "postgres/lib/pgxs/config/missing"
    ];
    for (const path of scripts) {
      const file = resolve(input, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
    writeFileSync(resolve(input, "postgres/bin/pg_createsubscriber"), macho, {
      mode: 0o755
    });
    writeRuntimeAssetManifest({
      runtimeRoot: input,
      platform: "macos",
      architecture: "arm64"
    });
    const result = run(input, resolve(root, "out"));
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("macOS core rejects foreign executable aliases", () => {
  const { root, input } = fixture();
  try {
    symlinkSync("postgres", resolve(input, "postgres/bin/hidden"));
    writeRuntimeAssetManifest({
      runtimeRoot: input,
      platform: "macos",
      architecture: "arm64"
    });
    const result = run(input, resolve(root, "out"));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /(?:macOS.*executable|unexpected.*payload)/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("macOS core refuses output through symlinked parent into frozen source", () => {
  const { root, input, approved } = fixture();
  try {
    symlinkSync(resolve(input, "postgres"), resolve(root, "alias"));
    const result = run(input, resolve(root, "alias/nested-output"), approved);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /output.*source/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("macOS core refuses output inside frozen source", () => {
  const { root, input } = fixture();
  try {
    const result = run(input, resolve(input, "postgres/nested-output"));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /output.*source/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("macOS core rejects missing source licenses and foreign platform payload", () => {
  const { root, input } = fixture();
  try {
    rmSync(resolve(input, "third-party-licenses/openssl/LICENSE.txt"));
    assert.notEqual(run(input, resolve(root, "missing-license")).status, 0);
    writeFileSync(
      resolve(input, "third-party-licenses/openssl/LICENSE.txt"),
      "license"
    );
    mkdirSync(resolve(input, "llama.cpp/cuda"));
    writeFileSync(resolve(input, "llama.cpp/cuda/llama-server"), "foreign");
    writeRuntimeAssetManifest({
      runtimeRoot: input,
      platform: "macos",
      architecture: "arm64"
    });
    const result = run(input, resolve(root, "foreign"));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unexpected payload/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("macOS core rejects changed frozen asset and unpinned provenance", () => {
  const { root, input } = fixture();
  try {
    writeFileSync(
      resolve(input, "llama.cpp/metal/llama-server"),
      Buffer.concat([macho, Buffer.from("changed")])
    );
    const changed = run(input, resolve(root, "bad"));
    assert.notEqual(changed.status, 0);
    assert.match(changed.stderr, /Frozen runtime asset changed/);
    writeFileSync(
      resolve(input, "provenance.json"),
      JSON.stringify({ source: { kind: "verified-runtime-source" } })
    );
    const unpinned = run(input, resolve(root, "bad2"));
    assert.notEqual(unpinned.status, 0);
    assert.match(unpinned.stderr, /pinned macOS build provenance/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
