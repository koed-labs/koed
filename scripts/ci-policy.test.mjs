import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  evaluateCiPolicy,
  fileAffectsPackaging,
  packagingRelevant
} from "../.github/scripts/ci-policy.mjs";
import { evaluateRequiredJobs } from "../.github/scripts/ci-required.mjs";

const REPOSITORY_FULL_NAME = "koed-labs/koed";

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

test("packaging path policy excludes documentation and includes runtime consumers", () => {
  assert.equal(packagingRelevant(["docs/running-koed.md", "PLAN.md"]), false);
  for (const file of [
    "apps/desktop/src/main.ts",
    "apps/api/src/index.ts",
    "apps/worker/src/index.ts",
    "apps/embedding-service/src/index.ts",
    "apps/explorer/src/App.tsx",
    "packages/koed-server/src/cli.ts",
    "packages/mcp-server/src/cli.ts",
    "packages/core/src/index.ts",
    "packages/db/src/index.ts",
    "packages/shared/src/index.ts",
    "packages/ui/src/index.ts",
    "scripts/native-runtime/procure-runtime.mjs",
    ".github/workflows/release.yml",
    "pnpm-lock.yaml"
  ]) {
    assert.equal(fileAffectsPackaging(file), true, file);
  }
});

test("unknown paths fail closed into packaged validation", () => {
  assert.equal(fileAffectsPackaging("new-runtime-area/config.json"), true);
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

test("app-only smoke starts after Build without waiting for Tests", () => {
  const workflow = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");
  const relevantSmoke = workflow
    .split("  relevant-packaged-smoke:")[1]
    .split("  release-candidate-validation:")[0];
  const needs = relevantSmoke.split("    if:")[0];

  assert.match(needs, /- changes/);
  assert.match(needs, /- build/);
  assert.doesNotMatch(needs, /- tests/);
  assert.match(relevantSmoke, /needs\.build\.result == 'success'/);
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

test("stable required result accepts only policy-correct success and skips", () => {
  const baseResults = {
    changes: "success",
    static_checks: "success",
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
        release_candidate_validation: "success"
      }
    }).ok,
    true
  );
});
