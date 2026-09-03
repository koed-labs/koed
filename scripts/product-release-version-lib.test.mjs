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
  assertReleaseWorkflowVersionPropagation,
  internalWorkspacePackageNames,
  productReleasePackagePath,
  synchronizedProductPackagePaths,
  syncProductPackageVersions
} from "./product-release-version-lib.mjs";
import {
  assertKoedReleaseVersion,
  isKoedReleaseVersion
} from "../packages/koed/release-version.mjs";

const writeJson = (root, relativePath, value) => {
  const target = resolve(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
};

const writeText = (root, relativePath, value) => {
  const target = resolve(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, value);
};

const validReleaseWorkflow = [
  "jobs:",
  "  release:",
  "    outputs:",
  "      version: ${{ steps.product.outputs.version }}",
  "    steps:",
  "      - name: Create release pull request",
  "        uses: changesets/action@fixture",
  "        with:",
  "          version: pnpm release:version",
  "      - name: Read product version",
  "        id: product",
  "        run: |",
  '          version="$(node -e "require(\'./packages/koed/package.json\')")"',
  '          echo "version=${version}" >> "${GITHUB_OUTPUT}"',
  "  standalone-koed-server-release-assets:",
  "    needs: release",
  "    steps:",
  "      - name: Build standalone koed-server package",
  '        run: pnpm koed-server:package -- --version "${{ needs.release.outputs.version }}" --json',
  "  standalone-koed-server-release-metadata:",
  "    needs: [release]",
  "    steps:",
  "      - name: Write release artifact metadata",
  '        run: node scripts/write-koed-release-artifact-metadata.mjs -- --version "${{ needs.release.outputs.version }}"',
  "  native-runtime-linux-x64-release-assets:",
  "    needs: release",
  "    steps:",
  "      - name: Package native runtime release artifact",
  '        run: pnpm native-runtime:build:linux-x64 -- --version "${{ needs.release.outputs.version }}" --json',
  "  unsigned-desktop-release-assets:",
  "    needs: release",
  "    steps:",
  "      - name: Build native runtime artifact",
  "        env:",
  "          KOED_NATIVE_RUNTIME_VERSION: ${{ needs.release.outputs.version }}",
  "        run: pnpm native-runtime:build:macos-arm64 -- --json",
  ""
].join("\n");

const validRecoveryWorkflow = [
  "jobs:",
  "  recover-desktop-assets:",
  "    steps:",
  "      - name: Build native runtime artifact",
  "        env:",
  "          TAG: ${{ inputs.tag }}",
  '        run: KOED_NATIVE_RUNTIME_VERSION="${TAG#v}" pnpm native-runtime:build:macos-arm64 -- --json',
  ""
].join("\n");

const writeWorkflowFixture = (root, releaseWorkflow = validReleaseWorkflow) => {
  writeText(root, ".github/workflows/release.yml", releaseWorkflow);
  writeText(
    root,
    ".github/workflows/release-desktop-assets.yml",
    validRecoveryWorkflow
  );
};

const fixture = () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-release-version-"));
  writeJson(root, productReleasePackagePath, {
    name: "@koed/koed",
    version: "1.4.0"
  });
  const synchronizedPackageNames = new Map([
    ["package.json", "koed"],
    ["packages/koed-server/package.json", "@koed/koed-server"],
    ["apps/desktop/package.json", "@koed/desktop"]
  ]);
  for (const [, relativePath] of synchronizedProductPackagePaths) {
    writeJson(root, relativePath, {
      name: synchronizedPackageNames.get(relativePath),
      version: "1.3.2"
    });
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

test("rejects an unclassified internal workspace package", () => {
  const root = fixture();
  try {
    writeJson(root, "packages/unclassified/package.json", {
      name: "@koed/unclassified",
      version: "0.0.0",
      private: true
    });

    assert.throws(
      () => assertChangesetReleasePolicy(root),
      /missing from the release policy:[\s\S]*@koed\/unclassified/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uses one strict SemVer policy for Koed product versions", () => {
  for (const version of [
    "0.0.0",
    "1.2.3",
    "1.2.3-beta.1",
    "1.2.3+build.7",
    "1.2.3-beta.1+build.7"
  ]) {
    assert.equal(isKoedReleaseVersion(version), true, version);
    assert.equal(assertKoedReleaseVersion(version), version);
  }
  for (const version of [
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.2.3-01",
    "1.2.3-foo..bar",
    "1.2",
    "unknown"
  ]) {
    assert.equal(isKoedReleaseVersion(version), false, version);
    assert.throws(() => assertKoedReleaseVersion(version), /valid SemVer/);
  }
});

test("validates release version propagation in the owning workflow steps", () => {
  const root = fixture();
  try {
    writeWorkflowFixture(root);
    assert.equal(assertReleaseWorkflowVersionPropagation(root), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects version propagation moved to an unrelated workflow step", () => {
  const root = fixture();
  try {
    const brokenWorkflow = [
      validReleaseWorkflow.replace(
        '--version "${{ needs.release.outputs.version }}" --json',
        '--version "$VERSION" --json'
      ),
      "  decoy:",
      "    needs: release",
      "    steps:",
      "      - name: Unrelated version mention",
      '        run: pnpm koed-server:package -- --version "${{ needs.release.outputs.version }}" --json',
      ""
    ].join("\n");
    writeWorkflowFixture(root, brokenWorkflow);

    assert.throws(
      () => assertReleaseWorkflowVersionPropagation(root),
      /standalone-koed-server-release-assets\/Build standalone koed-server package/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects version propagation mentioned only in a shell comment", () => {
  const root = fixture();
  try {
    const requiredCommand =
      '        run: pnpm koed-server:package -- --version "${{ needs.release.outputs.version }}" --json';
    const brokenWorkflow = validReleaseWorkflow.replace(
      requiredCommand,
      [
        "        run: |",
        `          # ${requiredCommand.trim().replace("run: ", "")}`,
        '          pnpm koed-server:package -- --version "$VERSION" --json'
      ].join("\n")
    );
    writeWorkflowFixture(root, brokenWorkflow);

    assert.throws(
      () => assertReleaseWorkflowVersionPropagation(root),
      /standalone-koed-server-release-assets\/Build standalone koed-server package/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
