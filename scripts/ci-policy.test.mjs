import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

function runsFor(condition, outputs, cacheHit) {
  if (!condition) return true;
  const expression = condition
    .replace(
      /needs\.changes\.outputs\.(run_linux_native|run_app_smoke|run_full_validation)/g,
      (_, key) => JSON.stringify(outputs[key])
    )
    .replace(
      /steps\.native-cache\.outputs\.cache-hit/g,
      JSON.stringify(cacheHit)
    )
    .replace(
      /steps\.native-core-cache\.outputs\.cache-hit/g,
      JSON.stringify(cacheHit)
    );
  assert.match(expression, /^[\s()'"a-z!&|=]+$/);
  return Function(`"use strict"; return (${expression});`)();
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
    "Verify Linux native CPU core",
    "Build workspace and Linux release AppImage",
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
    for (const hit of [true, false]) {
      const cacheHit = String(hit);
      const jobRuns = runsFor(linuxJob.if, outputs, cacheHit);
      assert.equal(jobRuns, native || smoke || full);
      for (const name of combined) {
        assert.equal(
          jobRuns && runsFor(step(name).if, outputs, cacheHit),
          (native || full) && (!misses.has(name) || !hit),
          `${name}: ${JSON.stringify({ outputs, hit })}`
        );
      }
      for (const name of cpu) {
        assert.equal(
          jobRuns && runsFor(step(name).if, outputs, cacheHit),
          smoke || full,
          name
        );
      }
      assert.equal(
        jobRuns &&
          runsFor(
            step("Upload verified Linux native runtime artifact").if,
            outputs,
            cacheHit
          ),
        native
      );
    }
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
