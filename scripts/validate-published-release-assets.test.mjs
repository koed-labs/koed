import assert from "node:assert/strict";
import test from "node:test";
import { validatePublishedReleaseAssets } from "./validate-published-release-assets.mjs";

const url = (name) =>
  `https://github.com/koed/koed/releases/download/v1.0.0/${name}`;
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
    browser_download_url: url(name)
  }))
});

test("binds every metadata URL to a complete draft asset", () => {
  const result = validatePublishedReleaseAssets({
    metadata: metadata(),
    release: release()
  });
  assert.equal(result.ok, true);
  assert.equal(result.verified.length, 4);
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
});
