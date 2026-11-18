import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

const workflow = () =>
  parse(
    readFileSync(
      new URL(
        "../.github/workflows/macos-candidate-artifact.yml",
        import.meta.url
      ),
      "utf8"
    )
  );

test("candidate workflow is manual, least privilege and separated across jobs", () => {
  const yaml = workflow();
  assert.deepEqual(Object.keys(yaml.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(yaml.jobs), [
    "prepare",
    "build",
    "inspect",
    "sign",
    "smoke",
    "publish"
  ]);
  for (const job of ["build", "inspect", "sign", "smoke"]) {
    assert.equal(yaml.jobs[job]["runs-on"], "xcode-27");
  }
  assert.equal(yaml.jobs.sign.environment, "desktop-candidate-signing");
  assert.deepEqual(yaml.jobs.sign.needs, ["prepare", "inspect"]);
  assert.equal(yaml.jobs.sign["runs-on"], "xcode-27");
  assert.deepEqual(yaml.jobs.smoke.needs, ["prepare", "inspect", "sign"]);
  assert.deepEqual(yaml.jobs.publish.needs, [
    "prepare",
    "inspect",
    "sign",
    "smoke"
  ]);
  const buildScript = yaml.jobs.build.steps.find((step) =>
    step.name?.startsWith("Build untrusted")
  );
  assert.match(buildScript.run, /apps\/desktop\/release\/mac\/Koed\.app/);
  const text = JSON.stringify(yaml);
  assert.doesNotMatch(
    text,
    /contents:\s*write|npm publish|gh release|create-release/i
  );
  assert.doesNotMatch(
    JSON.stringify(yaml.jobs.build),
    /CANDIDATE_P12|APPLE_API_KEY|APPLE_API_ISSUER|secrets\./
  );
  assert.doesNotMatch(
    JSON.stringify(yaml.jobs.smoke),
    /CANDIDATE_P12|APPLE_API_KEY|APPLE_API_ISSUER/
  );
});

test("candidate execution cannot read or poison shared caches", () => {
  const yaml = workflow();
  assert.equal(yaml["cache-mode"], "none");
  for (const [name, job] of Object.entries(yaml.jobs)) {
    assert.ok(
      job["cache-mode"] === undefined || job["cache-mode"] === "none",
      `${name} must not override the cache restriction`
    );
  }
});

test("signer checks out only trusted workflow code; candidate executes only without signing secrets", () => {
  const yaml = workflow();
  const checkout = yaml.jobs.sign.steps.find((step) =>
    step.uses?.startsWith("actions/checkout@")
  );
  assert.equal(checkout.with.ref, "${{ github.sha }}");
  assert.equal(checkout.with["persist-credentials"], false);
  const run = yaml.jobs.sign.steps.find((step) => step.id === "sign");
  assert.equal(run.run, "node scripts/macos-candidate.mjs sign");
  assert.ok(run.env.CANDIDATE_P12_BASE64.includes("secrets."));
  const smokeCheckouts = yaml.jobs.smoke.steps.filter((step) =>
    step.uses?.startsWith("actions/checkout@")
  );
  assert.equal(smokeCheckouts.length, 1);
  assert.equal(smokeCheckouts[0].with.ref, "${{ github.sha }}");
  assert.equal(smokeCheckouts[0].with["persist-credentials"], false);
  const smokeScript = yaml.jobs.smoke.steps.find((step) =>
    step.name?.startsWith("Run trusted CLI")
  );
  assert.match(
    smokeScript.run,
    /node trusted\/apps\/desktop\/scripts\/smoke-candidate-trusted\.mjs/
  );
  assert.doesNotMatch(
    JSON.stringify(yaml.jobs.smoke),
    /needs\.prepare\.outputs\.sha|candidate install/
  );
  for (const job of Object.values(yaml.jobs)) {
    for (const step of job.steps ?? [])
      if (step.run) assert.doesNotMatch(step.run, /\$\{\{\s*inputs\./);
  }
});
