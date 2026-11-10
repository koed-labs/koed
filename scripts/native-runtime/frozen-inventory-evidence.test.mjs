import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { readFrozenInventoryEvidence } from "./frozen-inventory-evidence.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inventory = [
  { path: "file", type: "file", mode: 420, bytes: 1, sha256: hash("x") }
];
const json = JSON.stringify(
  inventory.map(({ bytes, mode, path, sha256, type }) => ({
    bytes,
    mode,
    path,
    sha256,
    type
  }))
);
const fixture = () => {
  mkdirSync("scratch", { recursive: true });
  const root = mkdtempSync(resolve("scratch/frozen-evidence-"));
  writeFileSync(resolve(root, "approved-macos-inventory.json"), `${json}\n`);
  writeFileSync(
    resolve(root, "koed-native-runtime-macos-arm64-1.2.3.tar.gz"),
    "frozen archive"
  );
  execFileSync(
    "zip",
    [
      "-q",
      "artifact.zip",
      "approved-macos-inventory.json",
      "koed-native-runtime-macos-arm64-1.2.3.tar.gz"
    ],
    { cwd: root }
  );
  const path = resolve(root, "artifact.zip");
  return {
    root,
    path,
    digest: `sha256:${hash(readFileSync(path))}`,
    approvedSha256: hash(json)
  };
};

const rezip = (f, names) => {
  rmSync(f.path);
  execFileSync("zip", ["-qy", "artifact.zip", ...names], { cwd: f.root });
  f.digest = `sha256:${hash(readFileSync(f.path))}`;
};
const check = (f) =>
  readFrozenInventoryEvidence({
    archivePath: f.path,
    artifactDigest: f.digest,
    approvedSha256: f.approvedSha256,
    version: "1.2.3"
  });

test("reads canonical approved evidence only from authenticated frozen artifact bytes", async () => {
  const f = fixture();
  try {
    assert.deepEqual(await check(f), inventory);
    await assert.rejects(
      readFrozenInventoryEvidence({
        archivePath: f.path,
        artifactDigest: f.digest,
        approvedSha256: f.approvedSha256,
        version: "1.2.4"
      }),
      /entry|missing/i
    );
    await assert.rejects(
      readFrozenInventoryEvidence({
        archivePath: f.path,
        artifactDigest: `sha256:${"0".repeat(64)}`,
        approvedSha256: f.approvedSha256
      }),
      /digest/i
    );
    await assert.rejects(
      readFrozenInventoryEvidence({
        archivePath: f.path,
        artifactDigest: f.digest,
        approvedSha256: "0".repeat(64),
        version: "1.2.3"
      }),
      /approved|digest/i
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("pathname replacement after hashing cannot change parsed evidence", async () => {
  const f = fixture();
  const original = fs.createReadStream;
  let replaced = false;
  try {
    fs.writeFileSync(
      resolve(f.root, "replacement.zip"),
      "not the authenticated ZIP"
    );
    fs.createReadStream = (...args) => {
      const stream = original(...args);
      stream.once("end", () => {
        if (!replaced) {
          fs.renameSync(resolve(f.root, "replacement.zip"), f.path);
          replaced = true;
        }
      });
      return stream;
    };
    syncBuiltinESMExports();
    try {
      assert.deepEqual(await check(f), inventory);
    } catch (error) {
      assert.match(error.message, /changed/i);
    }
    assert.equal(replaced, true);
  } finally {
    fs.createReadStream = original;
    syncBuiltinESMExports();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("in-place ZIP modification after hashing is rejected", async () => {
  const f = fixture();
  const original = fs.createReadStream;
  let changed = false;
  try {
    fs.createReadStream = (...args) => {
      const stream = original(...args);
      stream.once("end", () => {
        if (!changed) {
          const bytes = readFileSync(f.path);
          bytes[10] ^= 1;
          writeFileSync(f.path, bytes);
          changed = true;
        }
      });
      return stream;
    };
    syncBuiltinESMExports();
    await assert.rejects(check(f));
    assert.equal(changed, true);
  } finally {
    fs.createReadStream = original;
    syncBuiltinESMExports();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("enforces compressed artifact and expanded evidence bounds", async () => {
  const f = fixture();
  try {
    writeFileSync(
      resolve(f.root, "approved-macos-inventory.json"),
      Buffer.alloc(16 * 1024 * 1024 + 1)
    );
    rezip(f, [
      "approved-macos-inventory.json",
      "koed-native-runtime-macos-arm64-1.2.3.tar.gz"
    ]);
    await assert.rejects(check(f), /size limit/i);
    truncateSync(f.path, 4 * 1024 ** 3 + 1);
    await assert.rejects(check(f), /size limit/i);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("rejects unexpected entries, missing entries, symlinks, and noncanonical evidence even with recomputed ZIP digest", async () => {
  const frozen = "koed-native-runtime-macos-arm64-1.2.3.tar.gz";
  const evidence = "approved-macos-inventory.json";
  for (const kind of ["extra", "missing", "symlink", "noncanonical"]) {
    const f = fixture();
    try {
      if (kind === "extra") writeFileSync(resolve(f.root, "extra"), "x");
      if (kind === "symlink") {
        rmSync(resolve(f.root, evidence));
        symlinkSync(frozen, resolve(f.root, evidence));
      }
      if (kind === "noncanonical")
        writeFileSync(
          resolve(f.root, evidence),
          JSON.stringify(inventory, null, 2)
        );
      rezip(
        f,
        kind === "missing"
          ? [evidence]
          : kind === "extra"
            ? [evidence, frozen, "extra"]
            : [evidence, frozen]
      );
      await assert.rejects(check(f), /entry|missing|canonical|evidence/i, kind);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});
