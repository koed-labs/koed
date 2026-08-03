#!/usr/bin/env node
/* global console, process */
import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const PACKAGING_ROOTS = [
  "apps/api/",
  "apps/desktop/",
  "apps/embedding-service/",
  "apps/explorer/",
  "apps/worker/",
  "packages/core/",
  "packages/db/",
  "packages/koed-server/",
  "packages/mcp-server/",
  "packages/memory-ui/",
  "packages/shared/",
  "packages/ui/",
  "scripts/native-runtime/"
];

const PACKAGING_FILES = new Set([
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml"
]);

const SAFE_NON_PACKAGING_ROOTS = [".changeset/", "docs/"];
const SAFE_NON_PACKAGING_FILES = new Set([
  ".editorconfig",
  ".gitattributes",
  ".gitignore",
  "AGENTS.md",
  "CONTEXT.md",
  "LICENSE",
  "PLAN.md",
  "README.md",
  "TODO.md"
]);

export const fileAffectsPackaging = (file) => {
  const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");
  if (PACKAGING_FILES.has(normalized)) return true;
  if (PACKAGING_ROOTS.some((root) => normalized.startsWith(root))) return true;
  if (SAFE_NON_PACKAGING_FILES.has(normalized)) return false;
  if (SAFE_NON_PACKAGING_ROOTS.some((root) => normalized.startsWith(root))) {
    return false;
  }
  if (/\.md$/i.test(normalized)) return false;
  return true;
};

export const packagingRelevant = (files) =>
  files.some((file) => fileAffectsPackaging(file));

const labelNames = (event) =>
  (event.pull_request?.labels ?? [])
    .map((label) => (typeof label === "string" ? label : label?.name))
    .filter(Boolean);

export const evaluateCiPolicy = ({
  eventName,
  event = {},
  changedFiles = [],
  trustedSkipSha = ""
}) => {
  const labels = labelNames(event);
  const headRef = event.pull_request?.head?.ref ?? "";
  const repositoryFullName = event.repository?.full_name ?? "";
  const headRepositoryFullName =
    event.pull_request?.head?.repo?.full_name ?? "";
  const changesetsReleasePr =
    eventName === "pull_request" &&
    headRef === "changeset-release/main" &&
    Boolean(repositoryFullName) &&
    headRepositoryFullName === repositoryFullName;
  const forceFullCi =
    eventName === "pull_request" && labels.includes("full-ci");
  const requestedValidation = event.inputs?.validation_level ?? "standard";
  const manualApp =
    eventName === "workflow_dispatch" && requestedValidation === "app-only";
  const manualFull =
    eventName === "workflow_dispatch" &&
    ["full", "clean-install"].includes(requestedValidation);
  const scheduledFull = eventName === "schedule";
  const changedPackaging =
    eventName === "pull_request" && packagingRelevant(changedFiles);
  const trustedSkipPackaged =
    eventName === "pull_request" &&
    !changesetsReleasePr &&
    Boolean(trustedSkipSha) &&
    trustedSkipSha === event.pull_request?.head?.sha;
  const runFullValidation = changesetsReleasePr || manualFull || scheduledFull;
  const runAppSmoke =
    !trustedSkipPackaged &&
    !runFullValidation &&
    (changedPackaging || forceFullCi || manualApp);

  return {
    packaging_relevant: String(changedPackaging),
    changesets_release_pr: String(changesetsReleasePr),
    force_full_ci: String(forceFullCi),
    trusted_skip_packaged: String(trustedSkipPackaged),
    run_app_smoke: String(runAppSmoke),
    run_full_validation: String(runFullValidation),
    clean_model_install: String(
      scheduledFull ||
        (eventName === "workflow_dispatch" &&
          requestedValidation === "clean-install")
    ),
    run_linux_native: String(
      eventName === "workflow_dispatch" &&
        event.inputs?.build_native_runtime_linux_x64 === "true"
    )
  };
};

const changedFilesForEvent = (eventName, event) => {
  if (eventName !== "pull_request") return [];
  const base = event.pull_request?.base?.sha;
  const head = event.pull_request?.head?.sha;
  if (!base || !head) {
    throw new Error("Pull-request base and head SHAs are required.");
  }
  return execFileSync("git", ["diff", "--name-only", `${base}...${head}`], {
    encoding: "utf8"
  })
    .split("\n")
    .map((file) => file.trim())
    .filter(Boolean);
};

const main = () => {
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!eventName || !eventPath || !outputPath) {
    throw new Error(
      "GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, and GITHUB_OUTPUT are required."
    );
  }
  const event = JSON.parse(readFileSync(eventPath, "utf8"));
  let changedFiles;
  try {
    changedFiles = changedFilesForEvent(eventName, event);
  } catch (error) {
    if (eventName !== "pull_request") throw error;
    console.error(
      `Change detection failed closed; packaged validation will run: ${error instanceof Error ? error.message : String(error)}`
    );
    changedFiles = ["__ambiguous_change__"];
  }
  const result = evaluateCiPolicy({
    eventName,
    event,
    changedFiles,
    trustedSkipSha: process.env.KOED_TRUSTED_PACKAGED_CI_SKIP_SHA ?? ""
  });
  for (const [name, value] of Object.entries(result)) {
    appendFileSync(outputPath, `${name}=${value}\n`);
  }
  console.log(JSON.stringify({ changedFiles, ...result }, null, 2));
};

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
