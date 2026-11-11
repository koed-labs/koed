import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const readWorkflow = (path) => parse(readFileSync(path, "utf8"));
const ci = readWorkflow(".github/workflows/ci.yml");
const coreSteps = ci.jobs["native-runtime-linux-x64"].steps;
const findStep = (steps, name) => {
  const step = steps.find((item) => item.name === name);
  assert.ok(step, `missing step: ${name}`);
  return step;
};

test("CI validates pull requests, schedules and dispatches without ordinary main pushes", () => {
  assert.ok(ci.on.pull_request);
  assert.ok(ci.on.schedule);
  assert.ok(ci.on.workflow_dispatch);
  assert.equal(ci.on.push, undefined);
  const release = readWorkflow(".github/workflows/release.yml");
  assert.ok(release.on.push);
});

test("default-branch CPU core warmer matches CI cache and validates before saving", () => {
  const path = ".github/workflows/native-runtime-linux-core-cache.yml";
  assert.ok(existsSync(path), "dedicated Linux CPU core warmer is missing");
  const warmer = readWorkflow(path);
  assert.deepEqual(warmer.on.push.branches, ["main"]);
  assert.ok(warmer.on.schedule);
  assert.ok("workflow_dispatch" in warmer.on);
  const job = warmer.jobs["maintain-native-core-cache"];
  assert.match(job.if, /github\.event\.repository\.default_branch/);
  // Pull requests restore from the Blacksmith cache, so the warmer must save there.
  assert.equal(job["runs-on"], "blacksmith-4vcpu-ubuntu-2204");
  assert.ok(
    ci.jobs["native-runtime-linux-x64"]["runs-on"].includes(
      `&& '${job["runs-on"]}' ||`
    )
  );
  assert.equal(warmer.env.NODE_VERSION, ci.env.NODE_VERSION);
  assert.equal(warmer.env.PNPM_VERSION, ci.env.PNPM_VERSION);
  const names = [
    "Restore Linux native CPU core",
    "Build Linux native CPU core on a cache miss",
    "Verify Linux native CPU core",
    "Save Linux native CPU core"
  ];
  const steps = names.map((name) => findStep(job.steps, name));
  const originals = names.map((name) => findStep(coreSteps, name));
  for (const i of [0, 3]) {
    assert.deepEqual(steps[i].with, originals[i].with);
    assert.equal(steps[i].uses, originals[i].uses);
  }
  for (const i of [1, 2]) assert.equal(steps[i].run, originals[i].run);
  assert.deepEqual(
    steps.map((step) => job.steps.indexOf(step)),
    steps.map((step) => job.steps.indexOf(step)).toSorted((a, b) => a - b)
  );
  assert.match(
    steps[1].if,
    /steps\.native-core-cache\.outputs\.cache-hit != 'true'/
  );
  assert.match(
    steps[3].if,
    /steps\.native-core-cache\.outputs\.cache-hit != 'true'/
  );
  assert.equal(steps[2].if, undefined);
  for (const step of steps) {
    assert.ok([undefined, false].includes(step["continue-on-error"]));
    assert.doesNotMatch(step.if ?? "", /always\(\)|failure\(\)/);
  }
  for (const input of [
    "scripts/native-runtime/*.linux-x64.json",
    "scripts/native-runtime/build-core-linux-x64.mjs",
    "scripts/native-runtime/core-artifact.mjs",
    "scripts/native-runtime/procure-runtime.mjs",
    "scripts/native-runtime/content-policy.mjs",
    "scripts/native-runtime/manifest-lib.mjs",
    "scripts/native-runtime/loader-validation-lib.mjs",
    "scripts/deterministic-tar-gzip.mjs",
    "packages/koed-server/src/artifact-canonical-json.mjs"
  ]) {
    assert.ok(
      warmer.on.push.paths.includes(input),
      `missing cache input trigger: ${input}`
    );
  }
});
