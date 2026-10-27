import assert from "node:assert/strict";
import test from "node:test";
import {
  chmodSync,
  closeSync,
  existsSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { decideAssetAction } from "./ensure-release-assets.mjs";

test("existing same-byte asset is idempotent and mismatched asset never overwrites", () => {
  const digest = "a".repeat(64);
  assert.deepEqual(
    decideAssetAction({ expectedSha256: digest, actualSha256: digest }),
    { action: "skip" }
  );
  assert.deepEqual(
    decideAssetAction({ expectedSha256: digest, actualSha256: "b".repeat(64) }),
    { action: "block" }
  );
  assert.deepEqual(
    decideAssetAction({ expectedSha256: digest, actualSha256: null }),
    { action: "upload" }
  );
});

test("uploads an absent draft asset without replacing anything", () => {
  const dir = mkdtempSync(join(tmpdir(), "koed-asset-upload-test-"));
  try {
    const asset = join(dir, "asset.bin");
    const marker = join(dir, "uploaded");
    writeFileSync(asset, "expected");
    const gh = join(dir, "gh");
    writeFileSync(
      gh,
      `#!${process.execPath}\nconst a=process.argv.slice(2);\nif(a[0]==='api') console.log(JSON.stringify({tag_name:'v1.2.3',draft:true,assets:[]}));\nelse if(a[0]==='release'&&a[1]==='upload') require('node:fs').writeFileSync(process.env.TEST_UPLOAD, 'uploaded');\nelse process.exitCode=9;\n`
    );
    chmodSync(gh, 0o755);
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/ensure-release-assets.mjs"), "v1.2.3", asset],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          GITHUB_REPOSITORY: "test/repo",
          TEST_UPLOAD: marker
        }
      }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(marker), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects failed or mismatched downloads without uploading", () => {
  const dir = mkdtempSync(join(tmpdir(), "koed-asset-failure-test-"));
  try {
    const asset = join(dir, "asset.bin");
    writeFileSync(asset, "expected");
    const gh = join(dir, "gh");
    writeFileSync(
      gh,
      `#!${process.execPath}\nconst a=process.argv.slice(2);\nif(a[1]?.includes('/releases/tags/')) console.log(JSON.stringify({tag_name:'v1.2.3',draft:true,assets:[{name:'asset.bin',id:1}]}));\nelse if(a.includes('--header')) { process.stdout.write('wrong'); if(process.env.TEST_FAIL === '1') process.exitCode=7; }\nelse { require('node:fs').writeFileSync(process.env.TEST_UPLOAD, 'unexpected'); }\n`
    );
    chmodSync(gh, 0o755);
    for (const fail of ["0", "1"]) {
      const result = spawnSync(
        process.execPath,
        [resolve("scripts/ensure-release-assets.mjs"), "v1.2.3", asset],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            GITHUB_REPOSITORY: "test/repo",
            TEST_FAIL: fail,
            TEST_UPLOAD: join(dir, "uploaded")
          }
        }
      );
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        fail === "1"
          ? /gh asset download failed/
          : /Existing release asset differs/
      );
    }
    assert.equal(existsSync(join(dir, "uploaded")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "verifies a draft asset larger than the old subprocess buffer without uploading",
  { timeout: 120_000 },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "koed-large-asset-test-"));
    try {
      const asset = join(dir, "large.bin");
      const fd = openSync(asset, "w");
      ftruncateSync(fd, 1024 * 1024 * 1024 + 1);
      closeSync(fd);
      const gh = join(dir, "gh");
      writeFileSync(
        gh,
        `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nif (args[1]?.includes('/releases/tags/')) console.log(JSON.stringify({tag_name:'v1.2.3',draft:true,assets:[{name:'large.bin',id:1}]}));\nelse if (args.includes('--header')) fs.createReadStream(process.env.TEST_ASSET).pipe(process.stdout);\nelse process.exit(8);\n`
      );
      chmodSync(gh, 0o755);
      const result = spawnSync(
        process.execPath,
        [resolve("scripts/ensure-release-assets.mjs"), "v1.2.3", asset],
        {
          encoding: "utf8",
          timeout: 110_000,
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            GITHUB_REPOSITORY: "test/repo",
            TEST_ASSET: asset
          }
        }
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Verified existing asset large\.bin/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
);
