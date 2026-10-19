import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  writeDesktopReleaseChecksum,
  resolveDesktopReleaseApp
} from "./desktop-release-checksum.mjs";
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
