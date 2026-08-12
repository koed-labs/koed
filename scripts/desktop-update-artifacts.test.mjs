import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { blake2b } from "@noble/hashes/blake2.js";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { validateDesktopUpdateArtifacts } from "./desktop-update-artifacts-lib.mjs";
import {
  parseByteRanges,
  startDesktopUpdateFeed
} from "./serve-desktop-update-feed.mjs";
import {
  INTERNAL_UPDATE_URL,
  PUBLIC_UPDATE_URL,
  selectDesktopUpdateFeed,
  writeDesktopUpdateConfig
} from "./prepare-desktop-update-config.mjs";
import { validateDesktopUpdateFeedSelection } from "./validate-desktop-update-feed-selection.mjs";
import {
  assertPublicMacosReleaseEnvironment,
  buildElectronBuilderCommand
} from "./package-desktop-update-artifacts.mjs";

function digest(buffer) {
  return createHash("sha512").update(buffer).digest("base64");
}

function blockMap(buffer) {
  return gzipSync(
    JSON.stringify({
      version: "2",
      files: [
        {
          name: "file",
          offset: 0,
          checksums: [
            Buffer.from(blake2b(buffer, { dkLen: 18 })).toString("base64")
          ],
          sizes: [buffer.byteLength]
        }
      ]
    })
  );
}

function makeFixture(version = "1.2.3") {
  const root = mkdtempSync(join(tmpdir(), "koed-update-fixture-"));
  const zip = Buffer.from(`zip-${version}`);
  const files = {
    [`Koed-${version}-arm64.zip`]: zip,
    [`Koed-${version}-arm64.dmg`]: Buffer.from(`dmg-${version}`),
    [`Koed-${version}-arm64.zip.blockmap`]: null,
    [`Koed-${version}-arm64.dmg.blockmap`]: null
  };
  files[`Koed-${version}-arm64.zip.blockmap`] = blockMap(
    files[`Koed-${version}-arm64.zip`]
  );
  files[`Koed-${version}-arm64.dmg.blockmap`] = blockMap(
    files[`Koed-${version}-arm64.dmg`]
  );
  for (const [name, body] of Object.entries(files))
    writeFileSync(join(root, name), body);
  const zipName = `Koed-${version}-arm64.zip`;
  const dmgName = `Koed-${version}-arm64.dmg`;
  const dmg = files[dmgName];
  writeFileSync(
    join(root, "latest-mac.yml"),
    [
      `version: ${version}`,
      "files:",
      `  - url: ${zipName}`,
      `    sha512: ${digest(zip)}`,
      `    size: ${zip.byteLength}`,
      `  - url: ${dmgName}`,
      `    sha512: ${digest(dmg)}`,
      `    size: ${dmg.byteLength}`,
      `path: ${zipName}`,
      `sha512: ${digest(zip)}`,
      "releaseDate: 2026-08-09T00:00:00.000Z",
      ""
    ].join("\n")
  );
  return { root, version, files };
}

test("validates a coherent one-build updater set", () => {
  const fixture = makeFixture();
  try {
    const result = validateDesktopUpdateArtifacts({
      root: fixture.root,
      expectedVersion: fixture.version
    });
    assert.equal(result.version, fixture.version);
    assert.equal(result.trust, "internal-ad-hoc-or-unsigned");
    assert.deepEqual(result.artifacts, [
      "latest-mac.yml",
      `Koed-${fixture.version}-arm64.zip`,
      `Koed-${fixture.version}-arm64.dmg`,
      `Koed-${fixture.version}-arm64.zip.blockmap`,
      `Koed-${fixture.version}-arm64.dmg.blockmap`
    ]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects missing blockmaps and stale candidate artifacts", () => {
  const fixture = makeFixture();
  try {
    rmSync(join(fixture.root, `Koed-${fixture.version}-arm64.zip.blockmap`));
    assert.throws(
      () => validateDesktopUpdateArtifacts({ root: fixture.root }),
      /Manifest references missing artifact/
    );
    writeFileSync(
      join(fixture.root, `Koed-${fixture.version}-arm64.zip.blockmap`),
      blockMap(fixture.files[`Koed-${fixture.version}-arm64.zip`])
    );
    writeFileSync(join(fixture.root, `Koed-9.9.9-arm64.dmg`), "stale");
    assert.throws(
      () => validateDesktopUpdateArtifacts({ root: fixture.root }),
      /not belonging to version/
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects manifest version mismatch and unsafe referenced paths", () => {
  const fixture = makeFixture();
  try {
    assert.throws(
      () =>
        validateDesktopUpdateArtifacts({
          root: fixture.root,
          expectedVersion: "9.9.9"
        }),
      /does not match candidate version/
    );
    const manifestPath = join(fixture.root, "latest-mac.yml");
    const manifest = readFileSync(manifestPath, "utf8").replace(
      `path: Koed-${fixture.version}-arm64.zip`,
      "path: ../Koed-1.2.3-arm64.zip"
    );
    writeFileSync(manifestPath, manifest);
    assert.throws(
      () => validateDesktopUpdateArtifacts({ root: fixture.root }),
      /must not contain a directory/
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("serves only validated candidate artifacts on loopback", async () => {
  const fixture = makeFixture();
  const { server, info } = await startDesktopUpdateFeed({
    root: fixture.root,
    prefix: "/stable",
    port: 0
  });
  try {
    const manifest = await fetch(`${info.feed_url}latest-mac.yml`);
    assert.equal(manifest.status, 200);
    assert.match(await manifest.text(), /version: 1\.2\.3/);
    const zip = await fetch(`${info.feed_url}Koed-1.2.3-arm64.zip`);
    assert.equal(zip.status, 200);
    assert.equal(await zip.text(), "zip-1.2.3");
    const head = await fetch(`${info.feed_url}Koed-1.2.3-arm64.zip`, {
      method: "HEAD"
    });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.equal(head.headers.get("accept-ranges"), "bytes");
    assert.equal(head.headers.get("content-length"), "9");
    const suffix = await fetch(`${info.feed_url}Koed-1.2.3-arm64.zip`, {
      headers: { range: "bytes=-4" }
    });
    assert.equal(suffix.status, 206);
    assert.equal(await suffix.text(), ".2.3");
    const openEnded = await fetch(`${info.feed_url}Koed-1.2.3-arm64.zip`, {
      headers: { range: "bytes=4-" }
    });
    assert.equal(openEnded.status, 206);
    assert.equal(await openEnded.text(), "1.2.3");
    const multiple = await fetch(`${info.feed_url}Koed-1.2.3-arm64.zip`, {
      headers: { range: "bytes=0-1,4-5" }
    });
    assert.equal(multiple.status, 206);
    assert.match(
      multiple.headers.get("content-type"),
      /^multipart\/byteranges/
    );
    assert.match(await multiple.text(), /Content-Range: bytes 0-1\/9/);
    const invalid = await fetch(`${info.feed_url}Koed-1.2.3-arm64.zip`, {
      headers: { range: "bytes=99-" }
    });
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers.get("content-range"), "bytes */9");
    const traversal = await fetch(`${info.feed_url}%2e%2e%2fsecret`);
    assert.equal(traversal.status, 404);
    const unknown = await fetch(`${info.feed_url}notes.txt`);
    assert.equal(unknown.status, 404);
    const health = await fetch(info.health_url);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ready, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("parses suffix, open-ended, and invalid byte ranges deterministically", () => {
  assert.deepEqual(parseByteRanges("bytes=-3", 10), [{ start: 7, end: 9 }]);
  assert.deepEqual(parseByteRanges("bytes=4-", 10), [{ start: 4, end: 9 }]);
  assert.deepEqual(parseByteRanges("bytes=99-", 10), []);
  assert.deepEqual(parseByteRanges("units=0-1", 10), []);
});

test("rejects symlink roots and symlinked candidate artifacts", () => {
  const fixture = makeFixture();
  const parent = mkdtempSync(join(tmpdir(), "koed-update-links-"));
  const rootLink = join(parent, "root-link");
  const external = join(parent, "external.dmg");
  try {
    symlinkSync(fixture.root, rootLink);
    assert.throws(
      () => validateDesktopUpdateArtifacts({ root: rootLink }),
      /root must not be a symbolic link/
    );
    writeFileSync(external, "outside");
    unlinkSync(join(fixture.root, `Koed-${fixture.version}-arm64.dmg`));
    symlinkSync(
      external,
      join(fixture.root, `Koed-${fixture.version}-arm64.dmg`)
    );
    assert.throws(
      () => validateDesktopUpdateArtifacts({ root: fixture.root }),
      /must not be a symbolic link/
    );
    assert.equal(
      lstatSync(
        join(fixture.root, `Koed-${fixture.version}-arm64.dmg`)
      ).isSymbolicLink(),
      true
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("rejects same-version blockmaps whose bytes do not describe the package", () => {
  const fixture = makeFixture();
  try {
    writeFileSync(
      join(fixture.root, `Koed-${fixture.version}-arm64.zip.blockmap`),
      blockMap(Buffer.from("another-build"))
    );
    assert.throws(
      () => validateDesktopUpdateArtifacts({ root: fixture.root }),
      /Blockmap (?:bytes do not match|chunk bounds)/
    );
    writeFileSync(
      join(fixture.root, `Koed-${fixture.version}-arm64.zip.blockmap`),
      Buffer.from("arbitrary")
    );
    assert.throws(
      () => validateDesktopUpdateArtifacts({ root: fixture.root }),
      /Unable to decode/
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("enforces explicit internal/public feed selection and app-update.yml inspection", () => {
  assert.equal(
    selectDesktopUpdateFeed({ mode: "internal" }),
    INTERNAL_UPDATE_URL
  );
  assert.throws(
    () => selectDesktopUpdateFeed({ mode: "public", url: PUBLIC_UPDATE_URL }),
    /explicit approval/
  );
  assert.equal(
    selectDesktopUpdateFeed({
      mode: "public",
      url: PUBLIC_UPDATE_URL,
      allowPublicTarget: true
    }),
    PUBLIC_UPDATE_URL
  );
  const root = mkdtempSync(join(tmpdir(), "koed-update-config-"));
  const source = join(root, "builder.yml");
  const internal = join(root, "internal.yml");
  const publicConfig = join(root, "public.yml");
  const app = join(root, "Koed.app");
  try {
    writeFileSync(
      source,
      "publish:\n  provider: generic\n  url: http://127.0.0.1:0/koed-internal/stable/\n  channel: latest\n"
    );
    writeDesktopUpdateConfig({ mode: "internal", source, out: internal });
    writeDesktopUpdateConfig({
      mode: "public",
      source,
      out: publicConfig,
      url: PUBLIC_UPDATE_URL,
      allowPublicTarget: true
    });
    assert.match(readFileSync(internal, "utf8"), /127\.0\.0\.1/);
    assert.match(readFileSync(publicConfig, "utf8"), /updates\.koed\.ai/);
    assert.match(readFileSync(publicConfig, "utf8"), /notarize: true/);
    const resources = join(app, "Contents", "Resources");
    mkdirSync(resources, { recursive: true });
    writeFileSync(
      join(resources, "app-update.yml"),
      `provider: generic\nurl: ${INTERNAL_UPDATE_URL}\nchannel: latest\n`
    );
    assert.equal(
      validateDesktopUpdateFeedSelection({ app, mode: "internal" }).url,
      INTERNAL_UPDATE_URL
    );
    assert.throws(
      () => validateDesktopUpdateFeedSelection({ app, mode: "public" }),
      /does not match public/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow packaging helper passes the supported electron-builder config flag", () => {
  assert.deepEqual(buildElectronBuilderCommand("electron-builder.public.yml"), [
    "exec",
    "electron-builder",
    "--config",
    "electron-builder.public.yml",
    "--mac",
    "dir",
    "dmg",
    "zip"
  ]);
});

test("public packaging fails closed without signing and notarization credentials", () => {
  assert.throws(
    () => assertPublicMacosReleaseEnvironment({}),
    /CSC_LINK, CSC_KEY_PASSWORD/
  );
  assert.throws(
    () =>
      assertPublicMacosReleaseEnvironment({
        CSC_LINK: "certificate",
        CSC_KEY_PASSWORD: "password"
      }),
    /complete Apple API key, Apple ID, or notarytool keychain/
  );
  assert.doesNotThrow(() =>
    assertPublicMacosReleaseEnvironment({
      CSC_LINK: "certificate",
      CSC_KEY_PASSWORD: "password",
      APPLE_ID: "release@example.com",
      APPLE_APP_SPECIFIC_PASSWORD: "password",
      APPLE_TEAM_ID: "TEAMID"
    })
  );
});
