import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { assertKoedReleaseVersion } from "../packages/koed/release-version.mjs";

export const productReleasePackagePath = "packages/koed/package.json";

export const synchronizedProductPackagePaths = [
  ["root package", "package.json"],
  ["koed-server package", "packages/koed-server/package.json"],
  ["Desktop package", "apps/desktop/package.json"]
];

export const internalWorkspacePackageNames = [
  "@koed/api",
  "@koed/app-runtime-stage",
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

const readJson = (root, relativePath) =>
  JSON.parse(readFileSync(resolve(root, relativePath), "utf8"));

const discoverWorkspacePackageNames = (root) =>
  ["apps", "packages"].flatMap((workspaceRoot) =>
    readdirSync(resolve(root, workspaceRoot), { withFileTypes: true }).flatMap(
      (entry) => {
        if (!entry.isDirectory()) return [];
        const relativePath = `${workspaceRoot}/${entry.name}/package.json`;
        if (!existsSync(resolve(root, relativePath))) return [];
        const name = readJson(root, relativePath).name;
        if (typeof name !== "string" || name.length === 0) {
          throw new Error(
            `Workspace package has no valid name: ${relativePath}`
          );
        }
        return [name];
      }
    )
  );

export const readProductReleaseVersion = (root) =>
  assertKoedReleaseVersion(
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
  const classifiedPackages = new Set(internalWorkspacePackageNames);
  const unclassifiedPackages = discoverWorkspacePackageNames(root).filter(
    (packageName) =>
      packageName !== "@koed/koed" && !classifiedPackages.has(packageName)
  );
  if (unclassifiedPackages.length > 0) {
    throw new Error(
      `Internal workspace packages are missing from the release policy:\n- ${unclassifiedPackages.join("\n- ")}`
    );
  }
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

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const parseWorkflow = (root, relativePath) => {
  const workflow = parse(readFileSync(resolve(root, relativePath), "utf8"));
  if (!isRecord(workflow)) {
    throw new Error(`Invalid GitHub Actions workflow: ${relativePath}`);
  }
  return workflow;
};

const findWorkflowJob = (workflow, jobId, relativePath, failures) => {
  const jobs = isRecord(workflow.jobs) ? workflow.jobs : {};
  const job = jobs[jobId];
  if (!isRecord(job)) {
    failures.push(`${relativePath} must define the ${jobId} job`);
    return undefined;
  }
  return job;
};

const findWorkflowStep = (job, stepName, jobId, failures) => {
  const matches = (Array.isArray(job?.steps) ? job.steps : []).filter(
    (step) => isRecord(step) && step.name === stepName
  );
  if (matches.length !== 1) {
    failures.push(
      `${jobId} must contain exactly one ${JSON.stringify(stepName)} step`
    );
    return undefined;
  }
  return matches[0];
};

const jobNeedsRelease = (job) =>
  job?.needs === "release" ||
  (Array.isArray(job?.needs) && job.needs.includes("release"));

const executableRun = (step) =>
  typeof step?.run === "string"
    ? step.run
        .split(/\r?\n/)
        .filter((line) => !/^\s*#/.test(line))
        .join("\n")
    : "";

const releaseVersionExpression = "${{ needs.release.outputs.version }}";
const releaseVersionArgumentPattern =
  /--version\s+["']?\$\{\{\s*needs\.release\.outputs\.version\s*\}\}["']?/;

export const assertReleaseWorkflowVersionPropagation = (root) => {
  const failures = [];
  const releaseWorkflowPath = ".github/workflows/release.yml";
  const workflow = parseWorkflow(root, releaseWorkflowPath);

  const releaseJob = findWorkflowJob(
    workflow,
    "release",
    releaseWorkflowPath,
    failures
  );
  const changesetsStep = findWorkflowStep(
    releaseJob,
    "Create release pull request",
    "release",
    failures
  );
  if (
    typeof changesetsStep?.uses !== "string" ||
    !changesetsStep.uses.startsWith("changesets/action@") ||
    !isRecord(changesetsStep?.with) ||
    changesetsStep.with.version !== "pnpm release:version"
  ) {
    failures.push(
      "release/Create release pull request must run changesets/action with pnpm release:version"
    );
  }
  const productStep = findWorkflowStep(
    releaseJob,
    "Read product version",
    "release",
    failures
  );
  if (
    productStep?.id !== "product" ||
    !executableRun(productStep).includes("packages/koed/package.json") ||
    !/echo\s+["']?version=\$\{version\}["']?\s*>>\s*["']?\$\{GITHUB_OUTPUT\}["']?/.test(
      executableRun(productStep)
    )
  ) {
    failures.push(
      "release/Read product version must read packages/koed/package.json and publish the product step version"
    );
  }
  if (
    !isRecord(releaseJob?.outputs) ||
    releaseJob.outputs.version !== "${{ steps.product.outputs.version }}"
  ) {
    failures.push("release must export the product step version");
  }

  const releaseConsumers = [
    {
      jobId: "standalone-koed-server-release-assets",
      stepName: "Build standalone koed-server package",
      commandPattern: /\bpnpm\s+koed-server:package\b/
    },
    {
      jobId: "standalone-koed-server-release-metadata",
      stepName: "Write release artifact metadata",
      commandPattern:
        /\bnode\s+scripts\/write-koed-release-artifact-metadata\.mjs\b/
    },
    {
      jobId: "native-runtime-linux-x64-release-assets",
      stepName: "Package native runtime release artifact",
      commandPattern: /\bpnpm\s+native-runtime:build:linux-x64\b/
    }
  ];
  for (const { jobId, stepName, commandPattern } of releaseConsumers) {
    const job = findWorkflowJob(workflow, jobId, releaseWorkflowPath, failures);
    if (job && !jobNeedsRelease(job)) {
      failures.push(`${jobId} must depend on the release job`);
    }
    const step = findWorkflowStep(job, stepName, jobId, failures);
    const run = executableRun(step);
    if (!commandPattern.test(run) || !releaseVersionArgumentPattern.test(run)) {
      failures.push(
        `${jobId}/${stepName} must pass the release job version to its builder`
      );
    }
  }

  const desktopJobId = "unsigned-desktop-release-assets";
  const desktopJob = findWorkflowJob(
    workflow,
    desktopJobId,
    releaseWorkflowPath,
    failures
  );
  if (desktopJob && !jobNeedsRelease(desktopJob)) {
    failures.push(`${desktopJobId} must depend on the release job`);
  }
  const desktopStep = findWorkflowStep(
    desktopJob,
    "Build native runtime artifact",
    desktopJobId,
    failures
  );
  if (
    !isRecord(desktopStep?.env) ||
    desktopStep.env.KOED_NATIVE_RUNTIME_VERSION !== releaseVersionExpression ||
    !/\bpnpm\s+native-runtime:build:macos-arm64\b/.test(
      executableRun(desktopStep)
    )
  ) {
    failures.push(
      `${desktopJobId}/Build native runtime artifact must pass the release job version`
    );
  }

  const recoveryWorkflowPath = ".github/workflows/release-desktop-assets.yml";
  const recoveryWorkflow = parseWorkflow(root, recoveryWorkflowPath);
  const recoveryJobId = "recover-desktop-assets";
  const recoveryJob = findWorkflowJob(
    recoveryWorkflow,
    recoveryJobId,
    recoveryWorkflowPath,
    failures
  );
  const recoveryStep = findWorkflowStep(
    recoveryJob,
    "Build native runtime artifact",
    recoveryJobId,
    failures
  );
  if (
    !isRecord(recoveryStep?.env) ||
    recoveryStep.env.TAG !== "${{ inputs.tag }}" ||
    !/KOED_NATIVE_RUNTIME_VERSION=["']?\$\{TAG#v\}["']?\s+pnpm\s+native-runtime:build:macos-arm64\b/.test(
      executableRun(recoveryStep)
    )
  ) {
    failures.push(
      `${recoveryJobId}/Build native runtime artifact must strip the tag prefix before versioning its native runtime`
    );
  }

  if (failures.length > 0) {
    throw new Error(
      `The release workflows do not propagate the Koed product version:\n- ${failures.join("\n- ")}`
    );
  }
  return true;
};
