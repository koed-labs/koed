import assert from "node:assert/strict";
import test from "node:test";
import { validatePublishedReleaseAssets } from "./validate-published-release-assets.mjs";

const url = (name) =>
  `https://github.com/koed/koed/releases/download/v1.0.0/${name}`;
const draftUrl = (name) =>
  `https://github.com/koed/koed/releases/download/untagged-7161980e343013b6be41/${name}`;
const metadata = () => ({
  schemaVersion: 1,
  release: { version: "1.0.0", tag: "v1.0.0" },
  artifacts: {
    koedServerAppRuntime: {
      targets: [
        {
          version: "1.0.0",
          platform: "linux",
          architecture: "x64",
          archive: { name: "server.tar.gz", url: url("server.tar.gz") },
          checksum: {
            name: "server.tar.gz.sha256",
            url: url("server.tar.gz.sha256")
          },
          manifest: {
            name: "server.manifest.json",
            url: url("server.manifest.json")
          },
          provenance: {
            name: "server.provenance.json",
            url: url("server.provenance.json"),
            signature: { status: "unsigned-placeholder" }
          }
        }
      ]
    },
    nativeRuntime: { targets: [] }
  }
});
const release = () => ({
  tag_name: "v1.0.0",
  draft: true,
  assets: [
    "server.tar.gz",
    "server.tar.gz.sha256",
    "server.manifest.json",
    "server.provenance.json"
  ].map((name) => ({
    name,
    state: "uploaded",
    size: 10,
    browser_download_url: draftUrl(name)
  }))
});

test("binds canonical metadata URLs to complete temporary draft assets", () => {
  const result = validatePublishedReleaseAssets({
    metadata: metadata(),
    release: release()
  });
  assert.equal(result.ok, true);
  assert.equal(result.verified.length, 4);
});

test("accepts canonical asset URLs returned without a temporary draft target", () => {
  const canonicalRelease = release();
  for (const asset of canonicalRelease.assets) {
    asset.browser_download_url = url(asset.name);
  }
  const result = validatePublishedReleaseAssets({
    metadata: metadata(),
    release: canonicalRelease
  });
  assert.equal(result.ok, true);
});

test("rejects missing, incomplete, and mismatched published assets", () => {
  const missing = release();
  missing.assets.pop();
  assert.throws(
    () =>
      validatePublishedReleaseAssets({
        metadata: metadata(),
        release: missing
      }),
    /missing/
  );

  const incomplete = release();
  incomplete.assets[0].size = 0;
  assert.throws(
    () =>
      validatePublishedReleaseAssets({
        metadata: metadata(),
        release: incomplete
      }),
    /incomplete/
  );

  const mismatched = release();
  mismatched.assets[0].browser_download_url = "https://example.test/wrong";
  assert.throws(
    () =>
      validatePublishedReleaseAssets({
        metadata: metadata(),
        release: mismatched
      }),
    /URL mismatch/
  );

  const wrongRelease = release();
  wrongRelease.assets[0].browser_download_url = url(
    wrongRelease.assets[0].name
  ).replace("/v1.0.0/", "/v0.9.0/");
  assert.throws(
    () =>
      validatePublishedReleaseAssets({
        metadata: metadata(),
        release: wrongRelease
      }),
    /URL mismatch/
  );
});
