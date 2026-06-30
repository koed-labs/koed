import assert from "node:assert/strict";
import test from "node:test";
import {
  assertLaunchValidationEnvironment,
  formatLaunchValidationReport,
  launchValidationGates,
  summarizeLaunchValidation
} from "./team-saas-launch-validation-lib.mjs";

test("launch validation requires API_TOKEN_PEPPER for Auth gate coverage", () => {
  assert.doesNotThrow(() =>
    assertLaunchValidationEnvironment({ API_TOKEN_PEPPER: "pepper" })
  );
  assert.throws(
    () => assertLaunchValidationEnvironment({ API_TOKEN_PEPPER: "" }),
    /API_TOKEN_PEPPER is required/
  );
  assert.throws(
    () => assertLaunchValidationEnvironment({}),
    /API_TOKEN_PEPPER is required/
  );
});

test("launch validation gates cover KOE-227 critical path areas", () => {
  const criteria = launchValidationGates.map((gate) => gate.launchCriterion);

  assert.ok(criteria.some((criterion) => criterion.includes("signs up")));
  assert.ok(criteria.some((criterion) => criterion.includes("Team")));
  assert.ok(criteria.some((criterion) => criterion.includes("Workspace")));
  assert.ok(criteria.some((criterion) => criterion.includes("shared")));
  assert.ok(criteria.some((criterion) => criterion.includes("Unauthorized")));
  assert.ok(criteria.some((criterion) => criterion.includes("Member removal")));
  assert.ok(
    criteria.some((criterion) => criterion.includes("Personal deletion"))
  );
  assert.ok(criteria.some((criterion) => criterion.includes("Billing")));
  assert.ok(criteria.some((criterion) => criterion.includes("observability")));
});

test("launch validation report separates automated and manual gates", () => {
  const summary = summarizeLaunchValidation({
    memories: 13,
    checks: ["Fixture access check"]
  });
  const report = formatLaunchValidationReport(summary);

  assert.equal(summary.byMode.automated, 6);
  assert.equal(summary.byMode.manual, 3);
  assert.equal(summary.byMode.staging, 2);
  assert.match(report, /Automated launch gates:/);
  assert.match(report, /Manual launch gates:/);
  assert.match(report, /Staging launch gates:/);
  assert.match(report, /Any failed launch blocker/);
});
