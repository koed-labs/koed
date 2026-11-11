import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import {
  evaluateCiPolicy,
  fileAffectsPackaging,
  packagingRelevant
} from "../.github/scripts/ci-policy.mjs";
import { evaluateRequiredJobs } from "../.github/scripts/ci-required.mjs";

const REPOSITORY_FULL_NAME = "koed-labs/koed";

const linuxJob = parse(readFileSync(".github/workflows/ci.yml", "utf8")).jobs[
  "native-runtime-linux-x64"
];

function runsFor(condition, outputs, { nativeHit, coreHit, failed = false }) {
  if (!condition) return !failed;
  const expression = condition
    .replace(
      /needs\.changes\.outputs\.(run_linux_native|run_app_smoke|run_full_validation)/g,
      (_, key) => JSON.stringify(outputs[key])
    )
    .replace(
      /steps\.native-cache\.outputs\.cache-hit/g,
      JSON.stringify(nativeHit)
    )
    .replace(
      /steps\.native-core-cache\.outputs\.cache-hit/g,
      JSON.stringify(coreHit)
    )
    .replace(/failure\(\)/g, String(failed));
  assert.match(expression, /^[\s()'"a-z!&|=]+$/);
  const matches = Function(`"use strict"; return (${expression});`)();
  return (condition.includes("failure()") || !failed) && matches;
}

test("Linux combined payload and CPU smoke respect policy and cache scenarios", () => {
  const combined = [
    "Restore verified Linux native runtime payload",
    "Install native runtime build dependencies",
    "Install pinned CUDA build toolkit",
    "Cold-build native runtime payload",
    "Validate native runtime payload before use or save",
    "Save verified Linux native runtime payload",
    "Package native runtime artifact",
    "Validate packaged native runtime artifact"
  ];
  const misses = new Set(combined.slice(1, 4).concat(combined[5]));
  const cpu = [
    "Restore Linux native CPU core",
    "Build Linux native CPU core on a cache miss",
    "Verify Linux native CPU core",
    "Save Linux native CPU core",
    "Build workspace and Linux release AppImage",
    "Upload unreleased Linux AppImage for manual testing",
    "Run Linux directory and extracted AppImage smoke"
  ];
  const step = (name) => {
    const found = linuxJob.steps.find((item) => item.name === name);
    assert.ok(found, `missing step ${name}`);
    return found;
  };
  const scenarios = [
    { native: false, smoke: true, full: false },
    { native: false, smoke: false, full: true },
    { native: true, smoke: false, full: false },
    { native: true, smoke: true, full: false },
    { native: true, smoke: false, full: true },
    { native: false, smoke: false, full: false }
  ];
  for (const { native, smoke, full } of scenarios) {
    const outputs = {
      run_linux_native: String(native),
      run_app_smoke: String(smoke),
      run_full_validation: String(full)
    };
    for (const nativeHit of [true, false]) {
      for (const coreHit of [true, false]) {
        const cache = {
          nativeHit: String(nativeHit),
          coreHit: String(coreHit)
        };
        const jobRuns = runsFor(linuxJob.if, outputs, cache);
        assert.equal(jobRuns, native || smoke || full);
        for (const name of combined) {
          assert.equal(
            jobRuns && runsFor(step(name).if, outputs, cache),
            (native || full) && (!misses.has(name) || !nativeHit),
            `${name}: ${JSON.stringify({ outputs, nativeHit, coreHit })}`
          );
        }
        for (const name of cpu) {
          assert.equal(
            jobRuns && runsFor(step(name).if, outputs, cache),
            (smoke || full) &&
              ((!name.includes("on a cache miss") &&
                name !== "Save Linux native CPU core") ||
                !coreHit),
            `${name}: ${JSON.stringify({ outputs, nativeHit, coreHit })}`
          );
        }
        assert.equal(
          jobRuns &&
            runsFor(
              step("Upload verified Linux native runtime artifact").if,
              outputs,
              cache
            ),
          native
        );
        const diagnostics = step("Upload Linux Desktop smoke diagnostics");
        assert.equal(jobRuns && runsFor(diagnostics.if, outputs, cache), false);
        assert.equal(
          jobRuns &&
            runsFor(diagnostics.if, outputs, { ...cache, failed: true }),
          smoke || full
        );
      }
    }
  }
});

test("Linux payload failures prevent save, packaging and successful required CI", () => {
  assert.ok([undefined, false].includes(linuxJob["continue-on-error"]));
  const names = [
    "Validate native runtime payload before use or save",
    "Save verified Linux native runtime payload",
    "Package native runtime artifact",
    "Validate packaged native runtime artifact",
    "Upload verified Linux native runtime artifact"
  ];
  const steps = names.map((name) => {
    const step = linuxJob.steps.find((item) => item.name === name);
    assert.ok(step, `missing step ${name}`);
    assert.ok([undefined, false].includes(step["continue-on-error"]), name);
    assert.doesNotMatch(step.if ?? "", /always\(\)|failure\(\)/, name);
    return step;
  });
  assert.deepEqual(
    steps.map((step) => linuxJob.steps.indexOf(step)),
    steps.map((step) => linuxJob.steps.indexOf(step)).toSorted((a, b) => a - b)
  );
  const outputs = {
    run_linux_native: "true",
    run_app_smoke: "true",
    run_full_validation: "false"
  };
  const failed = { nativeHit: "false", coreHit: "false", failed: true };
  for (const step of steps.slice(1))
    assert.equal(runsFor(step.if, outputs, failed), false, step.name);

  const required = parse(readFileSync(".github/workflows/ci.yml", "utf8")).jobs[
    "ci-required"
  ];
  assert.ok(required.needs.includes("native-runtime-linux-x64"));
  assert.ok([undefined, false].includes(required["continue-on-error"]));
  const requiredStep = required.steps.find(
    (step) => step.run === "node .github/scripts/ci-required.mjs"
  );
  assert.ok(requiredStep);
  assert.ok([undefined, false].includes(requiredStep["continue-on-error"]));
  assert.equal(
    requiredStep.env.LINUX_NATIVE_RESULT,
    "${{ needs.native-runtime-linux-x64.result }}"
  );
  assert.equal(
    evaluateRequiredJobs({
      policy: outputs,
      results: {
        changes: "success",
        static_checks: "success",
        node_26_consumer: "success",
        tests: "success",
        build: "success",
        relevant_packaged_smoke: "success",
        release_candidate_validation: "skipped",
        native_runtime_linux_x64: "failure"
      }
    }).ok,
    false
  );
});

test("Linux payload validation preserves validator failure after diagnostics", () => {
  const step = linuxJob.steps.find(
    (item) => item.name === "Validate native runtime payload before use or save"
  );
  mkdirSync(resolve("scratch"), { recursive: true });
  const directory = mkdtempSync(resolve("scratch/ci-policy-"));
  try {
    const result = spawnSync(
      "bash",
      [
        "-c",
        `node() { echo '{}'; return 7; }\njq() { return 0; }\n${step.run}`
      ],
      {
        env: { ...process.env, RUNNER_TEMP: directory },
        encoding: "utf8"
      }
    );
    assert.equal(result.status, 7, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const pullRequest = ({
  head = "feature",
  labels = [],
  repository = REPOSITORY_FULL_NAME,
  headRepository = REPOSITORY_FULL_NAME
} = {}) => ({
  repository: repository ? { full_name: repository } : undefined,
  pull_request: {
    head: {
      ref: head,
      sha: "head-sha",
      repo: headRepository ? { full_name: headRepository } : null
    },
    labels: labels.map((name) => ({ name }))
  }
});

test("active workflows build the renamed public Koed Server package", () => {
  for (const workflowPath of [
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
    ".github/workflows/native-runtime-cache.yml",
    ".github/workflows/native-runtime-linux-cache.yml"
  ]) {
    const workflow = readFileSync(resolve(workflowPath), "utf8");
    assert.doesNotMatch(workflow, /pnpm --filter @koed\/koed-server\b/);
    assert.match(workflow, /pnpm --filter @koed-labs\/server build/);
  }
});

test("packaging path policy excludes documentation and includes runtime consumers", () => {
  assert.equal(packagingRelevant(["docs/running-koed.md", "README.md"]), false);
  for (const file of [
    "apps/desktop/src/main.ts",
    "apps/api/package.json",
    "apps/worker/tsup.config.ts",
    "apps/embedding-service/src/index.ts",
    "packages/koed-server/src/cli.ts",
    "packages/mcp-server/package.json",
    "packages/core/package.json",
    "packages/db/migrations/0001_init.sql",
    "packages/shared/src/index.ts",
    "packages/ui/src/index.ts",
    "scripts/native-runtime/procure-runtime.mjs",
    ".github/workflows/release.yml",
    "pnpm-lock.yaml"
  ]) {
    assert.equal(fileAffectsPackaging(file), true, file);
  }
});

test("release-note and CI policy tooling does not select packaged smoke", () => {
  const files = [
    ".github/scripts/ci-policy.mjs",
    "scripts/ci-policy.test.mjs",
    "scripts/product-changelog.mjs",
    "scripts/product-changelog.test.mjs",
    "scripts/product-release-notes.mjs",
    "scripts/product-release-notes.test.mjs",
    "scripts/sync-product-release.mjs"
  ];
  for (const file of files) {
    assert.equal(fileAffectsPackaging(file), false, file);
  }
  assert.equal(
    evaluateCiPolicy({
      eventName: "pull_request",
      event: pullRequest(),
      changedFiles: files
    }).run_app_smoke,
    "false"
  );
  assert.equal(fileAffectsPackaging("scripts/new-release-tool.mjs"), true);
});

test("backend workspace source alone does not select packaged smoke", () => {
  for (const file of [
    "apps/api/src/index.ts",
    "apps/worker/src/index.test.ts",
    "packages/core/src/index.ts",
    "packages/db/src/index.ts",
    "packages/mcp-server/src/cli.ts"
  ]) {
    assert.equal(fileAffectsPackaging(file), false, file);
  }
  assert.equal(
    packagingRelevant([
      "packages/core/src/index.ts",
      "apps/desktop/src/main.ts"
    ]),
    true
  );
});

test("release workflow dispatches full CI for the generated version branch", () => {
  const release = readFileSync(
    resolve(".github/workflows/release.yml"),
    "utf8"
  );
  const step = release
    .split("- name: Dispatch release-candidate CI for the version branch")[1]
    .split("- name: Read product version")[0];

  assert.ok(release.includes("permissions:\n  actions: write"));
  assert.match(step, /if: steps\.changesets\.outputs\.pullRequestNumber != ''/);
  assert.doesNotMatch(step, /hasChangesets/);
  assert.match(
    step,
    /gh workflow run ci\.yml --ref changeset-release\/main -f validation_level=full/
  );
  assert.deepEqual(
    evaluateCiPolicy({
      eventName: "workflow_dispatch",
      event: { inputs: { validation_level: "full" } },
      changedFiles: []
    }).run_full_validation,
    "true"
  );
});

test("manual Linux native validation also selects Desktop smoke", () => {
  const result = evaluateCiPolicy({
    eventName: "workflow_dispatch",
    event: { inputs: { build_native_runtime_linux_x64: "true" } }
  });
  assert.equal(result.run_linux_native, "true");
  assert.equal(result.run_app_smoke, "true");
});

test("unknown paths fail closed into packaged validation", () => {
  assert.equal(fileAffectsPackaging("new-runtime-area/config.json"), true);
});

test("draft release workflows resolve releases through API IDs", () => {
  for (const workflowPath of [".github/workflows/release.yml"]) {
    const workflow = readFileSync(resolve(workflowPath), "utf8");
    assert.match(workflow, /gh api --paginate --slurp/);
    assert.match(
      workflow,
      /repos\/\$\{GITHUB_REPOSITORY\}\/releases\/\$\{RELEASE_ID\}/
    );
    assert.doesNotMatch(workflow, /gh release (?:view|edit)/);
  }
});

test("release validation compares clean package trees and deterministic archives", () => {
  const ci = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");
  const release = readFileSync(
    resolve(".github/workflows/release.yml"),
    "utf8"
  );
  assert.match(ci, /Verify native runtime packaging reproducibility/);
  assert.match(ci, /Verify clean Desktop runtime and app reproducibility/);
  assert.match(ci, /scripts\/compare-package-trees\.mjs/);
  assert.match(
    ci,
    /Build standalone koed-server package[\s\S]*Inspect standalone koed-server package[\s\S]*scripts\/inspect-release-artifact\.mjs/
  );
  assert.match(
    ci,
    /Relevant packaged Desktop app smoke[\s\S]*Build macOS standalone koed-server package[\s\S]*Inspect macOS standalone koed-server package[\s\S]*--platform macos[\s\S]*--arch arm64/
  );
  assert.match(release, /Verify standalone package reproducibility/);
  assert.match(release, /Verify native runtime artifact reproducibility/);
  assert.match(release, /SOURCE_DATE_EPOCH: 0/);
  assert.match(release, /cmp \\\n\s+"\$\{first\}\/koed-server-/);
  assert.match(
    release,
    /cmp \\\n\s+"\$\{first\}\/koed-native-runtime-linux-x64-/
  );
});

test("release artifact size reports have unique target-specific asset names", () => {
  const release = readFileSync(
    resolve(".github/workflows/release.yml"),
    "utf8"
  );

  assert.match(
    release,
    /koed-server-app-runtime-\$\{target\}-artifact-size-report\.json/
  );
  assert.match(
    release,
    /koed-native-runtime-linux-x64-artifact-size-report\.json/
  );
  assert.match(
    release,
    /koed-native-runtime-linux-x64-artifact-size-report\.json" \\\n\s+\| tee -a "\$\{GITHUB_STEP_SUMMARY\}"/
  );
  assert.doesNotMatch(release, /\$\{release_dir\}\/artifact-size-report\.json/);
});

test("release publication checks out validation scripts", () => {
  const release = readFileSync(
    resolve(".github/workflows/release.yml"),
    "utf8"
  );
  assert.match(
    release,
    /publish-release:[\s\S]*?- name: Checkout\n\s+uses: actions\/checkout@[\da-f]+[\s\S]*?Validate published metadata URLs against draft assets/
  );
});

test("the workflow model cache key and filename track the pinned runtime model", () => {
  const runtimeSource = readFileSync(
    resolve("packages/koed-server/src/local-models-runtime.ts"),
    "utf8"
  );
  const workflow = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");
  const filename = runtimeSource.match(
    /filename: "(Qwen3-Embedding-[^"]+\.gguf)"/
  )?.[1];
  const sha256 = runtimeSource.match(/defaultSha256:\s*"([a-f0-9]{64})"/)?.[1];
  assert.ok(filename);
  assert.ok(sha256);
  assert.match(workflow, new RegExp(filename.replaceAll(".", "\\.")));
  assert.match(workflow, new RegExp(sha256));
});

test("native runtime caches are restored by PRs and written only by trusted main runs", () => {
  const workflow = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");
  const cacheWorkflow = readFileSync(
    resolve(".github/workflows/native-runtime-cache.yml"),
    "utf8"
  );
  const relevantSmoke = workflow
    .split("  relevant-packaged-smoke:")[1]
    .split("  release-candidate-validation:")[0];
  const fullValidation = workflow
    .split("  release-candidate-validation:")[1]
    .split("  native-runtime-linux-x64:")[0];
  const nativeRestoreStep = relevantSmoke
    .split("      - name: Restore verified native runtime payload")[1]
    .split("      - name: Build native runtime payload on cache miss")[0];
  const cacheKey = /key: (native-runtime-payload-v3-[^\n]+)/;

  assert.match(nativeRestoreStep, /uses: actions\/cache\/restore@/);
  assert.doesNotMatch(nativeRestoreStep, /uses: actions\/cache@/);
  assert.doesNotMatch(fullValidation, /native-runtime-payload-v3-/);
  assert.doesNotMatch(cacheWorkflow, /pull_request:/);
  assert.match(cacheWorkflow, /branches:\n\s+- main/);
  assert.match(
    cacheWorkflow,
    /if: github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/
  );
  assert.match(cacheWorkflow, /uses: actions\/cache\/restore@/);
  assert.match(cacheWorkflow, /uses: actions\/cache\/save@/);
  assert.match(cacheWorkflow, /cron: "47 3 \* \* 2,5"/);
  assert.ok(
    cacheWorkflow.indexOf(
      "Validate native runtime payload before use or save"
    ) <
      cacheWorkflow.indexOf(
        "Save independently validated native runtime payload"
      )
  );
  assert.equal(
    relevantSmoke.match(cacheKey)?.[1],
    cacheWorkflow.match(cacheKey)?.[1]
  );
});

test("relevant packaged smoke retains fail-closed missing-asset coverage", () => {
  const workflow = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");
  const relevantSmoke = workflow
    .split("  relevant-packaged-smoke:")[1]
    .split("  release-candidate-validation:")[0];

  assert.match(
    relevantSmoke,
    /smoke-packaged-desktop-app\.mjs --json --missing-assets --mask-native-assets/
  );
  assert.doesNotMatch(relevantSmoke, /package:smoke:mac/);
  assert.doesNotMatch(relevantSmoke, /missing-assets[^\n]*--build/);
});

test("app-only smoke stages once-validated runtime without a PR archive", () => {
  const workflow = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");
  const relevantSmoke = workflow
    .split("  relevant-packaged-smoke:")[1]
    .split("  release-candidate-validation:")[0];
  const fullValidation = workflow
    .split("  release-candidate-validation:")[1]
    .split("  native-runtime-linux-x64:")[0];

  assert.equal(
    relevantSmoke.match(/native-runtime:validate/g)?.length,
    1,
    "app-only smoke should fully validate the trusted payload once"
  );
  assert.match(relevantSmoke, /--source-dir[^\n]+--no-archive --json/);
  assert.doesNotMatch(relevantSmoke, /archive and checksum/);
  assert.match(fullValidation, /Cold-build native runtime artifact/);
  assert.match(
    fullValidation,
    /Extract native runtime for relocation validation/
  );
  assert.match(fullValidation, /Validate native runtime artifact/);
  assert.doesNotMatch(fullValidation, /--no-archive/);
});

test("app-only smoke starts immediately without waiting for other jobs", () => {
  const workflow = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");
  const relevantSmoke = workflow
    .split("  relevant-packaged-smoke:")[1]
    .split("  release-candidate-validation:")[0];
  const needs = relevantSmoke.split("    if:")[0];

  assert.match(needs, /needs: changes\n/);
  assert.doesNotMatch(needs, /build|tests|static-checks/);
  assert.doesNotMatch(relevantSmoke, /needs\.build\.result/);
});

test("ordinary, documentation, relevant, forced, and release pull requests route correctly", () => {
  assert.deepEqual(
    evaluateCiPolicy({
      eventName: "pull_request",
      event: pullRequest(),
      changedFiles: ["docs/running-koed.md"]
    }),
    {
      packaging_relevant: "false",
      changesets_release_pr: "false",
      force_full_ci: "false",
      trusted_skip_packaged: "false",
      run_app_smoke: "false",
      run_full_validation: "false",
      clean_model_install: "false",
      run_linux_native: "false"
    }
  );
  assert.equal(
    evaluateCiPolicy({
      eventName: "pull_request",
      event: pullRequest(),
      changedFiles: ["apps/desktop/src/main.ts"]
    }).run_app_smoke,
    "true"
  );
  assert.equal(
    evaluateCiPolicy({
      eventName: "pull_request",
      event: pullRequest({ labels: ["full-ci"] }),
      changedFiles: ["docs/ci.md"]
    }).run_app_smoke,
    "true"
  );
  const release = evaluateCiPolicy({
    eventName: "pull_request",
    event: pullRequest({ head: "changeset-release/main" }),
    changedFiles: [".changeset/release.md"]
  });
  assert.equal(release.changesets_release_pr, "true");
  assert.equal(release.run_app_smoke, "false");
  assert.equal(release.run_full_validation, "true");
});

test("Changesets release validation requires a same-repository head", () => {
  const sameRepository = evaluateCiPolicy({
    eventName: "pull_request",
    event: pullRequest({ head: "changeset-release/main" }),
    changedFiles: [".changeset/release.md"]
  });
  assert.equal(sameRepository.changesets_release_pr, "true");
  assert.equal(sameRepository.run_full_validation, "true");

  for (const event of [
    pullRequest({
      head: "changeset-release/main",
      headRepository: "fork-owner/koed"
    }),
    pullRequest({ head: "changeset-release/main", headRepository: null }),
    pullRequest({ head: "changeset-release/main", repository: null })
  ]) {
    const untrusted = evaluateCiPolicy({
      eventName: "pull_request",
      event,
      changedFiles: [".changeset/release.md"]
    });
    assert.equal(untrusted.changesets_release_pr, "false");
    assert.equal(untrusted.run_full_validation, "false");
  }
});

test("only a repository-controlled exact head SHA can skip app validation", () => {
  const skipped = evaluateCiPolicy({
    eventName: "pull_request",
    event: pullRequest(),
    changedFiles: ["apps/desktop/src/main.ts"],
    trustedSkipSha: "head-sha"
  });
  assert.equal(skipped.trusted_skip_packaged, "true");
  assert.equal(skipped.run_app_smoke, "false");

  const release = evaluateCiPolicy({
    eventName: "pull_request",
    event: pullRequest({ head: "changeset-release/main" }),
    changedFiles: ["apps/desktop/src/main.ts"],
    trustedSkipSha: "head-sha"
  });
  assert.equal(release.trusted_skip_packaged, "false");
  assert.equal(release.run_full_validation, "true");
});

test("push, manual, scheduled, and Linux dispatch policies are explicit", () => {
  assert.equal(
    evaluateCiPolicy({ eventName: "push", event: {}, changedFiles: [] })
      .run_app_smoke,
    "false"
  );
  assert.equal(
    evaluateCiPolicy({
      eventName: "workflow_dispatch",
      event: { inputs: { validation_level: "app-only" } }
    }).run_app_smoke,
    "true"
  );
  const manual = evaluateCiPolicy({
    eventName: "workflow_dispatch",
    event: {
      inputs: {
        validation_level: "clean-install",
        build_native_runtime_linux_x64: "true"
      }
    }
  });
  assert.equal(manual.run_full_validation, "true");
  assert.equal(manual.clean_model_install, "true");
  assert.equal(manual.run_linux_native, "true");
  assert.equal(
    evaluateCiPolicy({ eventName: "schedule", event: {} }).clean_model_install,
    "true"
  );
});

test("Linux smoke clears stale output, verifies checksum, and gates direct FUSE launch", () => {
  const ci = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");
  const job = ci
    .split("  native-runtime-linux-x64:")[1]
    .split("  ci-required:")[0];
  assert.match(
    job,
    /rm -rf[^\n]*linux-unpacked[\s\S]*desktop:package:linux:release[\s\S]*verify-linux[\s\S]*--appimage-direct/
  );
});

test("Linux smoke system packages install from cached archives before the package mirrors", () => {
  const names = [
    "Restore Linux Desktop smoke package archives",
    "Install Linux Desktop smoke dependencies",
    "Save Linux Desktop smoke package archives"
  ];
  const steps = names.map((name) => {
    const step = linuxJob.steps.find((item) => item.name === name);
    assert.ok(step, `missing step: ${name}`);
    return step;
  });
  const [restore, install, save] = steps;
  assert.deepEqual(
    steps.map((step) => linuxJob.steps.indexOf(step)),
    steps.map((step) => linuxJob.steps.indexOf(step)).toSorted((a, b) => a - b)
  );
  assert.match(restore.uses, /^actions\/cache\/restore@/);
  assert.match(save.uses, /^actions\/cache\/save@/);
  assert.deepEqual(save.with, restore.with);
  assert.match(
    install.run,
    /^\.github\/scripts\/install-linux-smoke-deps\.sh "\$\{RUNNER_TEMP\}\/koed-linux-smoke-packages" /
  );
  assert.doesNotMatch(install.run, /apt-get/);
  assert.match(save.if, /steps\.smoke-packages\.outputs\.downloaded == 'true'/);
  assert.match(
    save.if,
    /steps\.smoke-package-cache\.outputs\.cache-hit != 'true'/
  );

  const script = readFileSync(
    resolve(".github/scripts/install-linux-smoke-deps.sh"),
    "utf8"
  );
  const cached = script.indexOf(
    "dpkg -i --skip-same-version --refuse-downgrade"
  );
  const mirrors = script.indexOf("if ! apt_fetch; then");
  assert.ok(cached > 0 && mirrors > cached);
  assert.match(script, /Dir::Cache::Archives="\$\{archives\}"/);

  const fallback = script.indexOf("KOED_APT_FALLBACK_MIRROR");
  assert.ok(fallback > mirrors, "fallback mirror must follow the default");
  assert.match(
    script,
    /deb \[signed-by=\$\{keyring\}\] \$\{mirror\} \$\{pocket\} main universe/
  );
  assert.match(
    script,
    /keyring=\/usr\/share\/keyrings\/ubuntu-archive-keyring\.gpg/
  );
});

test("pull requests run Linux jobs on Blacksmith and other events on GitHub runners", () => {
  const jobs = parse(readFileSync(".github/workflows/ci.yml", "utf8")).jobs;
  const expected = {
    changes: ["blacksmith-2vcpu-ubuntu-2404", "ubuntu-24.04"],
    "node-26-consumer": ["blacksmith-4vcpu-ubuntu-2404", "ubuntu-24.04"],
    "static-checks": ["blacksmith-4vcpu-ubuntu-2404", "ubuntu-24.04"],
    tests: ["blacksmith-4vcpu-ubuntu-2404", "ubuntu-24.04"],
    build: ["blacksmith-4vcpu-ubuntu-2404", "ubuntu-24.04"],
    "ci-required": ["blacksmith-2vcpu-ubuntu-2404", "ubuntu-24.04"]
  };
  for (const [name, [pullRequest, other]] of Object.entries(expected)) {
    assert.equal(
      jobs[name]["runs-on"],
      `\${{ github.event_name == 'pull_request' && '${pullRequest}' || '${other}' }}`,
      name
    );
  }
  // The native runtime keeps its Ubuntu 22.04 (glibc 2.35) build floor. Full
  // validation restores the payload cache that GitHub-hosted runs save, so it
  // stays on the GitHub-hosted runner.
  assert.equal(
    jobs["native-runtime-linux-x64"]["runs-on"],
    "${{ github.event_name == 'pull_request' && needs.changes.outputs.run_full_validation != 'true' && 'blacksmith-4vcpu-ubuntu-2204' || 'ubuntu-22.04' }}"
  );
  for (const name of [
    "relevant-packaged-smoke",
    "release-candidate-validation"
  ]) {
    assert.equal(jobs[name]["runs-on"], "macos-15", name);
  }
  assert.deepEqual(
    Object.keys(jobs).toSorted(),
    [
      ...Object.keys(expected),
      "native-runtime-linux-x64",
      "relevant-packaged-smoke",
      "release-candidate-validation"
    ].toSorted()
  );
});

test("Linux smoke is required for app and full validation", () => {
  for (const policy of [
    { run_app_smoke: "true", run_full_validation: "false" },
    { run_app_smoke: "false", run_full_validation: "true" }
  ]) {
    const evaluation = evaluateRequiredJobs({
      policy: { ...policy, run_linux_native: "false" },
      results: {}
    });
    assert.equal(evaluation.expected.native_runtime_linux_x64, true);
  }
});

test("required CI job depends on and forwards Node 26 consumer result", () => {
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  const job = workflow.jobs["ci-required"];
  assert.ok(job.needs.includes("node-26-consumer"));
  const evaluation = job.steps.find(
    (step) => step.run === "node .github/scripts/ci-required.mjs"
  );
  assert.equal(
    evaluation.env.NODE_26_CONSUMER_RESULT,
    "${{ needs.node-26-consumer.result }}"
  );
});

test("stable required result accepts only policy-correct success and skips", () => {
  const baseResults = {
    changes: "success",
    static_checks: "success",
    node_26_consumer: "success",
    tests: "success",
    build: "success",
    relevant_packaged_smoke: "skipped",
    release_candidate_validation: "skipped",
    native_runtime_linux_x64: "skipped"
  };
  assert.equal(
    evaluateRequiredJobs({
      policy: {
        run_app_smoke: "false",
        run_full_validation: "false",
        run_linux_native: "false"
      },
      results: baseResults
    }).ok,
    true
  );
  assert.equal(
    evaluateRequiredJobs({
      policy: {
        run_app_smoke: "false",
        run_full_validation: "false",
        run_linux_native: "false"
      },
      results: { ...baseResults, node_26_consumer: "failure" }
    }).ok,
    false
  );
  assert.equal(
    evaluateRequiredJobs({
      policy: {
        run_app_smoke: "true",
        run_full_validation: "false",
        run_linux_native: "false"
      },
      results: { ...baseResults, relevant_packaged_smoke: "failure" }
    }).ok,
    false
  );
  assert.equal(
    evaluateRequiredJobs({
      policy: {
        run_app_smoke: "true",
        run_full_validation: "false",
        run_linux_native: "true"
      },
      results: {
        ...baseResults,
        relevant_packaged_smoke: "success",
        native_runtime_linux_x64: "success"
      }
    }).ok,
    true
  );
  assert.equal(
    evaluateRequiredJobs({
      policy: {
        run_app_smoke: "false",
        run_full_validation: "false",
        run_linux_native: "false"
      },
      results: { ...baseResults, tests: "cancelled" }
    }).ok,
    false
  );
  assert.equal(
    evaluateRequiredJobs({
      policy: {
        run_app_smoke: "false",
        run_full_validation: "true",
        run_linux_native: "false"
      },
      results: {
        ...baseResults,
        release_candidate_validation: "success",
        native_runtime_linux_x64: "success"
      }
    }).ok,
    true
  );
});
