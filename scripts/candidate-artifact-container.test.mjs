import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { makeZip } from "./candidate-zip-test-helper.mjs";
import { extractArtifactPayload } from "./candidate-artifact-container.mjs";

const setup = (t, entries) => {
  const base = resolve("scratch", "candidate-container-tests");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const archive = join(root, "artifact.zip");
  const output = join(root, "payload.zip");
  writeFileSync(archive, makeZip(entries));
  return { archive, output };
};

test("extracts only the fixed payload name and derives its digest", async (t) => {
  const { archive, output } = setup(t, [
    { name: "unsigned.zip", data: "contents", deflate: true }
  ]);
  const result = await extractArtifactPayload(archive, output, {
    maxBytes: 1024
  });
  assert.equal(readFileSync(output, "utf8"), "contents");
  assert.equal(
    result.sha256,
    createHash("sha256").update("contents").digest("hex")
  );
});

for (const [label, entries] of [
  [
    "extra entry",
    [
      { name: "unsigned.zip", data: "ok" },
      { name: "evil", data: "evil" }
    ]
  ],
  [
    "duplicate",
    [
      { name: "unsigned.zip", data: "ok" },
      { name: "unsigned.zip", data: "evil" }
    ]
  ],
  ["path traversal", [{ name: "../unsigned.zip", data: "evil" }]],
  ["symlink", [{ name: "unsigned.zip", data: "outside", mode: 0o120777 }]],
  [
    "forged size",
    [
      {
        name: "unsigned.zip",
        data: "x".repeat(200),
        deflate: true,
        declaredSize: 1
      }
    ]
  ]
]) {
  test(`rejects ${label}`, async (t) => {
    const { archive, output } = setup(t, entries);
    await assert.rejects(
      extractArtifactPayload(archive, output, { maxBytes: 1024 })
    );
  });
}

test("rejects payloads over the bound and an existing output path", async (t) => {
  const { archive, output } = setup(t, [
    { name: "unsigned.zip", data: "large payload" }
  ]);
  await assert.rejects(
    extractArtifactPayload(archive, output, { maxBytes: 4 }),
    /size|limit/i
  );
  writeFileSync(output, "existing");
  await assert.rejects(
    extractArtifactPayload(archive, output, { maxBytes: 1024 })
  );
  assert.equal(readFileSync(output, "utf8"), "existing");
});
