import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const productReleasePackagePath = "packages/koed/package.json";

export const synchronizedProductPackagePaths = [
  ["root package", "package.json"],
  ["koed-server package", "packages/koed-server/package.json"],
  ["Desktop package", "apps/desktop/package.json"]
];

export const internalWorkspacePackageNames = [
  "@koed/api",
  "@koed/core",
  "@koed/db",
  "@koed/desktop",
  "@koed/embedding-service",
  "@koed/evals",
  "@koed/koed-server",
  "@koed/mcp-server",
  "@koed/memory-ui",
  "@koed/privacy-service",
  "@koed/shared",
  "@koed/ui",
  "@koed/worker"
];

const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const readJson = (root, relativePath) =>
  JSON.parse(readFileSync(resolve(root, relativePath), "utf8"));

const assertReleaseVersion = (value, source) => {
  if (typeof value !== "string" || !semverPattern.test(value)) {
    throw new Error(
      `Invalid Koed product release version in ${source}: ${JSON.stringify(value)}`
    );
  }
  return value;
};

export const readProductReleaseVersion = (root) =>
  assertReleaseVersion(
    readJson(root, productReleasePackagePath).version,
    productReleasePackagePath
  );

export const syncProductPackageVersions = (root) => {
  const version = readProductReleaseVersion(root);
  const changed = [];
  for (const [label, relativePath] of synchronizedProductPackagePaths) {
    const packageJson = readJson(root, relativePath);
    if (packageJson.version === version) continue;
    packageJson.version = version;
    writeFileSync(
      resolve(root, relativePath),
      `${JSON.stringify(packageJson, null, 2)}\n`
    );
    changed.push({ label, relativePath });
  }
  return { changed, version };
};

export const assertProductPackageVersions = (root) => {
  const version = readProductReleaseVersion(root);
  const mismatches = synchronizedProductPackagePaths.flatMap(
    ([label, relativePath]) => {
      const actual = readJson(root, relativePath).version;
      return actual === version
        ? []
        : [
            `${label} (${relativePath}) is ${String(actual)}; expected ${version}`
          ];
    }
  );
  if (mismatches.length > 0) {
    throw new Error(
      `Koed product release versions are out of sync:\n- ${mismatches.join("\n- ")}\nRun \`pnpm release:version\` to synchronize release artifacts.`
    );
  }
  return version;
};

export const assertChangesetReleasePolicy = (root) => {
  const config = readJson(root, ".changeset/config.json");
  const ignored = new Set(Array.isArray(config.ignore) ? config.ignore : []);
  const missing = internalWorkspacePackageNames.filter(
    (packageName) => !ignored.has(packageName)
  );
  if (missing.length > 0) {
    throw new Error(
      `Changesets must ignore internal Koed workspace packages:\n- ${missing.join("\n- ")}`
    );
  }
  if (ignored.has("@koed/koed")) {
    throw new Error("Changesets must not ignore the @koed/koed release unit.");
  }
  return true;
};

export const assertReleaseWorkflowVersionPropagation = (root) => {
  const workflow = readFileSync(
    resolve(root, ".github/workflows/release.yml"),
    "utf8"
  );
  const required = [
    "version: pnpm release:version",
    "packages/koed/package.json",
    'koed-server:package -- --version "${{ needs.release.outputs.version }}"',
    "KOED_NATIVE_RUNTIME_VERSION: ${{ needs.release.outputs.version }}",
    'native-runtime:build:linux-x64 -- --source-dir "${RUNNER_TEMP}/koed-native-runtime-cache/linux-x64/koed-runtime" --version "${{ needs.release.outputs.version }}"',
    "write-koed-release-artifact-metadata.mjs --"
  ];
  const missing = required.filter((fragment) => !workflow.includes(fragment));
  if (missing.length > 0) {
    throw new Error(
      `The release workflow does not propagate the Koed product version:\n- ${missing.join("\n- ")}`
    );
  }
  const recoveryWorkflow = readFileSync(
    resolve(root, ".github/workflows/release-desktop-assets.yml"),
    "utf8"
  );
  if (!recoveryWorkflow.includes('KOED_NATIVE_RUNTIME_VERSION="${TAG#v}"')) {
    throw new Error(
      "The Desktop recovery workflow must strip the Git tag prefix before versioning its native runtime."
    );
  }
  return true;
};
