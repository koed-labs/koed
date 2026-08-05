#!/usr/bin/env node
/* global console, process */

export const evaluateRequiredJobs = ({ policy, results }) => {
  const expected = {
    changes: true,
    static_checks: true,
    tests: true,
    build: true,
    relevant_packaged_smoke: policy.run_app_smoke === "true",
    release_candidate_validation: policy.run_full_validation === "true",
    native_runtime_linux_x64: policy.run_linux_native === "true"
  };
  const errors = [];
  for (const [job, required] of Object.entries(expected)) {
    const result = results[job];
    if (required && result !== "success") {
      errors.push(`${job} was required but finished as ${result ?? "unknown"}`);
    }
    if (!required && result !== "skipped") {
      errors.push(
        `${job} should have been skipped but finished as ${result ?? "unknown"}`
      );
    }
  }
  return { ok: errors.length === 0, expected, results, errors };
};

const main = () => {
  const result = evaluateRequiredJobs({
    policy: {
      run_app_smoke: process.env.RUN_APP_SMOKE,
      run_full_validation: process.env.RUN_FULL_VALIDATION,
      run_linux_native: process.env.RUN_LINUX_NATIVE
    },
    results: {
      changes: process.env.CHANGES_RESULT,
      static_checks: process.env.STATIC_CHECKS_RESULT,
      tests: process.env.TESTS_RESULT,
      build: process.env.BUILD_RESULT,
      relevant_packaged_smoke: process.env.APP_SMOKE_RESULT,
      release_candidate_validation: process.env.FULL_VALIDATION_RESULT,
      native_runtime_linux_x64: process.env.LINUX_NATIVE_RESULT
    }
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
};

if (import.meta.url === `file://${process.argv[1]}`) main();
