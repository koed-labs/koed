import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createPackageReleaseIdentity } from "./package-release-identity.mjs";

test("records npm integrity and stable inventory digest for immutable package bytes", () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-package-identity-"));
  try {
    const packageRoot = resolve(root, "package");
    mkdirSync(resolve(packageRoot, "bin"), { recursive: true });
    writeFileSync(resolve(packageRoot, "bin/koed.js"), "launcher\n");
    writeFileSync(
      resolve(packageRoot, "package.json"),
      '{"name":"@koed-labs/server","version":"1.2.3"}\n'
    );
    const tarball = resolve(root, "package.tgz");
    writeFileSync(tarball, "immutable npm bytes");
    const first = createPackageReleaseIdentity({
      packageRoot,
      tarball,
      version: "1.2.3"
    });
    const second = createPackageReleaseIdentity({
      packageRoot,
      tarball,
      version: "1.2.3"
    });
    assert.equal(first.npm.integrity, second.npm.integrity);
    assert.equal(first.npm.inventorySha256, second.npm.inventorySha256);
    assert.match(first.npm.integrity, /^sha512-[A-Za-z0-9+/]+=*$/);
    assert.match(first.npm.inventorySha256, /^[a-f0-9]{64}$/);
    assert.equal(first.packageName, "@koed-labs/server");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
