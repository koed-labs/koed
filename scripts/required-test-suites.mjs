import { spawnSync } from "node:child_process";

const suites = [
  {
    name: "database",
    runs: [
      {
        files: ["packages/db/tests/collaboration-constraints.test.ts"],
        databaseUrlEnvironment: "COLLABORATION_CONSTRAINT_TEST_DATABASE_URL"
      },
      {
        files: ["packages/db/tests/collaboration-repository.test.ts"],
        databaseUrlEnvironment: "COLLABORATION_TEST_DATABASE_URL"
      },
      {
        files: ["packages/db/tests/team-creation-idempotency.test.ts"],
        databaseUrlEnvironment: "TEAM_CREATION_IDEMPOTENCY_TEST_DATABASE_URL"
      }
    ]
  },
  {
    name: "api",
    runs: [{ files: ["apps/api/src/collaboration/routes.test.ts"] }]
  },
  {
    name: "authorization",
    runs: [
      {
        files: [
          "apps/api/src/collaboration/admission.test.ts",
          "apps/api/src/server/browser-write-csrf.test.ts",
          "packages/core/src/team-workspace-authorization.test.ts"
        ]
      }
    ]
  },
  {
    name: "realtime",
    runs: [{ files: ["apps/api/src/collaboration/realtime.test.ts"] }]
  },
  {
    name: "ipc",
    runs: [
      {
        files: [
          "apps/desktop/src/ipc/commands.test.ts",
          "apps/desktop/src/ipc/personal-memory-boundary.test.ts",
          "apps/desktop/src/ipc/personal-memory-preload.test.ts"
        ]
      }
    ]
  },
  {
    name: "electron-ui",
    runs: [
      {
        files: [
          "apps/desktop/src/CollaborationApp.test.tsx",
          "apps/desktop/src/collaboration/renderer-surface.test.tsx"
        ]
      }
    ]
  },
  {
    name: "accessibility",
    runs: [
      {
        files: ["apps/desktop/src/renderer/shell/AppShell.test.tsx"],
        testNamePattern:
          "uses one roving tab stop and supports Team rail navigation"
      },
      {
        files: [
          "apps/desktop/src/renderer/views/onboarding/SetupChecklist.test.tsx"
        ],
        testNamePattern:
          "inspects existing state and requires consent before setup"
      },
      {
        files: [
          "apps/desktop/src/renderer/views/personal/PersonalMemoryViews.test.tsx"
        ],
        testNamePattern:
          "loads the normalized Project index and restores focus through drilldown"
      }
    ]
  }
];

for (const suite of suites) {
  process.stdout.write(`\nRequired ${suite.name} suite\n`);
  let totalPassedTests = 0;
  for (const run of suite.runs) {
    const args = ["exec", "vitest", "run", ...run.files, "--reporter=json"];
    if (run.testNamePattern) {
      args.push("--testNamePattern", run.testNamePattern);
    }
    if (run.databaseUrlEnvironment && !process.env.DATABASE_URL) {
      process.stderr.write(
        `Required ${suite.name} suite needs DATABASE_URL.\n`
      );
      process.exit(1);
    }

    const result = spawnSync("pnpm", args, {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        ...(run.databaseUrlEnvironment
          ? { [run.databaseUrlEnvironment]: process.env.DATABASE_URL }
          : {})
      }
    });

    process.stderr.write(result.stderr ?? "");

    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      process.stderr.write(result.stdout ?? "");
      process.exit(result.status ?? 1);
    }

    let report;
    try {
      report = JSON.parse(result.stdout ?? "");
    } catch (error) {
      process.stderr.write(
        `Required ${suite.name} suite returned an invalid Vitest report: ${error instanceof Error ? error.message : String(error)}\n`
      );
      process.exit(1);
    }
    if (
      report.success !== true ||
      report.numFailedTests !== 0 ||
      !Number.isInteger(report.numPassedTests) ||
      report.numPassedTests < 1
    ) {
      process.stderr.write(
        `Required ${suite.name} suite returned an unsuccessful Vitest report.\n`
      );
      process.exit(1);
    }
    totalPassedTests += report.numPassedTests;
    process.stdout.write(
      `- ${run.files.join(", ")}: ${report.numPassedTests} passed\n`
    );
  }
  if (totalPassedTests < 1) {
    process.stderr.write(
      `Required ${suite.name} suite did not execute a passing test.\n`
    );
    process.exit(1);
  }
}
