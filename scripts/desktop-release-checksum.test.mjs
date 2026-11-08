import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import process from "node:process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  truncateSync,
  mkdirSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  writeDesktopReleaseChecksum,
  resolveDesktopReleaseApp,
  writeLinuxDesktopReleaseChecksum,
  verifyLinuxDesktopReleaseChecksum
} from "./desktop-release-checksum.mjs";
test("Linux checksum names and verifies exact AppImage; rejects tampering and ambiguity", (t) => {
  const root = fixture(t);
  const options = { releaseVersion: "1.2.3", releaseDirectory: root };
  const asset = join(root, "Koed-1.2.3-x86_64.AppImage");
  assert.throws(() => writeLinuxDesktopReleaseChecksum(options));
  assert.throws(
    () =>
      writeLinuxDesktopReleaseChecksum({
        ...options,
        releaseVersion: "../bad"
      }),
    /version/i
  );
  writeFileSync(asset, "appimage");
  const checksum = writeLinuxDesktopReleaseChecksum(options);
  assert.equal(
    readFileSync(checksum, "utf8"),
    `${createHash("sha256").update("appimage").digest("hex")}  Koed-1.2.3-x86_64.AppImage\n`
  );
  assert.doesNotThrow(() => verifyLinuxDesktopReleaseChecksum(options));
  const original = readFileSync(checksum, "utf8");
  writeFileSync(checksum, original + original);
  assert.throws(() => verifyLinuxDesktopReleaseChecksum(options));
  writeFileSync(checksum, original.replace("Koed-1.2.3", "Koed-1.2.4"));
  assert.throws(() => verifyLinuxDesktopReleaseChecksum(options));
  writeFileSync(checksum, original);
  writeFileSync(asset, "tampered");
  assert.throws(() => verifyLinuxDesktopReleaseChecksum(options));
});
test("Linux provisional size gate accepts 4 GiB and rejects larger or missing images", (t) => {
  const root = fixture(t);
  const asset = join(root, "Koed-1.2.3-x86_64.AppImage");
  const run = () =>
    spawnSync(
      process.execPath,
      ["scripts/desktop-release-checksum.mjs", "size-linux", root, "1.2.3"],
      { encoding: "utf8" }
    );
  assert.notEqual(run().status, 0);
  writeFileSync(asset, "x");
  truncateSync(asset, 4_294_967_296);
  assert.equal(run().status, 0);
  truncateSync(asset, 4_294_967_297);
  assert.notEqual(run().status, 0);
});
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "koed-checksum-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
test("hashes exactly versioned arm64 dmg and zip using basenames", (t) => {
  const root = fixture(t);
  for (const ext of ["dmg", "zip"])
    writeFileSync(join(root, `Koed-1.2.3-arm64.${ext}`), ext);
  const path = writeDesktopReleaseChecksum({
    releaseVersion: "1.2.3",
    releaseDirectory: root
  });
  assert.equal(
    readFileSync(path, "utf8"),
    ["dmg", "zip"]
      .map(
        (ext) =>
          `${createHash("sha256").update(ext).digest("hex")}  Koed-1.2.3-arm64.${ext}\n`
      )
      .join("")
  );
});
test("missing archives and unsafe versions fail", (t) => {
  const root = fixture(t);
  assert.throws(
    () =>
      writeDesktopReleaseChecksum({
        releaseVersion: "1.2.3",
        releaseDirectory: root
      }),
    /ENOENT/
  );
  assert.throws(
    () =>
      writeDesktopReleaseChecksum({
        releaseVersion: "../../bad",
        releaseDirectory: root
      }),
    /version/i
  );
});
for (const layout of ["mac", "mac-arm64"])
  test(`selects ${layout} app`, (t) => {
    const root = fixture(t);
    mkdirSync(join(root, layout, "Koed.app"), { recursive: true });
    assert.equal(
      resolveDesktopReleaseApp(root),
      join(root, layout, "Koed.app")
    );
  });
test("rejects missing or ambiguous app bundles", (t) => {
  const root = fixture(t);
  assert.throws(() => resolveDesktopReleaseApp(root), /exactly one/);
  for (const layout of ["mac", "mac-arm64"])
    mkdirSync(join(root, layout, "Koed.app"), { recursive: true });
  assert.throws(() => resolveDesktopReleaseApp(root), /exactly one/);
});
