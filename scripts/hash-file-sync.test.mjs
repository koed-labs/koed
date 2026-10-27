import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { hashFileSync } from "./release-candidate-verification.mjs";

test("hashFileSync matches one-shot digests across chunk boundaries", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "koed-hash-"));
  try {
    const path = resolve(dir, "asset");
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 7, "koed");
    writeFileSync(path, bytes);
    assert.equal(
      hashFileSync(path),
      createHash("sha256").update(bytes).digest("hex")
    );
    assert.equal(
      hashFileSync(path, "sha512", "base64"),
      createHash("sha512").update(bytes).digest("base64")
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hashFileSync hashes a sparse file larger than 1 GiB", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "koed-hash-"));
  try {
    const path = resolve(dir, "sparse");
    writeFileSync(path, "");
    truncateSync(path, 1024 ** 3 + 1);
    assert.match(hashFileSync(path), /^[a-f0-9]{64}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
