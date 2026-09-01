import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import {
  assertChangesetReleasePolicy,
  assertProductPackageVersions,
  internalWorkspacePackageNames,
  productReleasePackagePath,
  synchronizedProductPackagePaths,
  syncProductPackageVersions
} from "./product-release-version-lib.mjs";

const writeJson = (root, relativePath, value) => {
  const target = resolve(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
};

const fixture = () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-release-version-"));
  writeJson(root, productReleasePackagePath, {
    name: "@koed/koed",
    version: "1.4.0"
  });
  for (const [, relativePath] of synchronizedProductPackagePaths) {
    writeJson(root, relativePath, { name: relativePath, version: "1.3.2" });
  }
  writeJson(root, "apps/api/package.json", {
    name: "@koed/api",
    version: "0.1.0"
  });
  writeJson(root, ".changeset/config.json", {
    ignore: internalWorkspacePackageNames
  });
  return root;
};

test("synchronizes product artifacts without rewriting internal packages", () => {
  const root = fixture();
  try {
    const before = readFileSync(resolve(root, "apps/api/package.json"), "utf8");
    const result = syncProductPackageVersions(root);

    assert.equal(result.version, "1.4.0");
    assert.equal(result.changed.length, synchronizedProductPackagePaths.length);
    assert.equal(assertProductPackageVersions(root), "1.4.0");
    assert.equal(
      readFileSync(resolve(root, "apps/api/package.json"), "utf8"),
      before
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports actionable product-version drift", () => {
  const root = fixture();
  try {
    assert.throws(
      () => assertProductPackageVersions(root),
      /Desktop package.*expected 1\.4\.0[\s\S]*pnpm release:version/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects an incomplete Changesets internal-package policy", () => {
  const root = fixture();
  try {
    writeJson(root, ".changeset/config.json", { ignore: ["@koed/api"] });
    assert.throws(
      () => assertChangesetReleasePolicy(root),
      /@koed\/embedding-service/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts the single product release-unit policy", () => {
  const root = fixture();
  try {
    assert.equal(assertChangesetReleasePolicy(root), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
