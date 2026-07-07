#!/usr/bin/env node
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  automatedLaunchTestCommands,
  assertLaunchValidationEnvironment,
  defaultStagedRemoteOptions,
  formatLaunchValidationReport,
  runStagedRemoteValidation,
  validateLaunchReadiness
} from "./team-saas-launch-validation-lib.mjs";
import { loadRootEnv } from "./api-token-bootstrap-lib.mjs";

const requireFromDbPackage = createRequire(resolve("packages/db/package.json"));
const pg = requireFromDbPackage("pg");

const usage = `Usage: pnpm team-launch:validate [--with-automated-tests] [--with-staged-remote] [options]

Validates the seeded Team SaaS fixture and prints the launch validation gates.
With --with-automated-tests it also runs the focused repository test commands
that back the non-fixture automated launch gates.
With --with-staged-remote it also probes Team Workspace routes on a running
target using a browser session cookie and scoped device credential.

Options:
  --base-url <url>                 Running API target for staged remote probes.
  --session-cookie <cookie>        Browser Cookie header for Team routes.
  --device-credential <credential> Koed-Device credential value or full header.
  --api-token <token>              Optional API Token used to prove Team rejection.
  --team-workspace-id <uuid>       Team Workspace to probe; defaults to the fixture Workspace.
  --team-node-id <uuid>            Memory node to expand; defaults to a fixture node.
  --local-edge-base-url <url>      Optional local-edge API target for proxy probes.
  --local-edge-backend-id <id>     Optional upstream backend id for local-edge proxy probes.

Environment:
  DATABASE_URL must point at the Koed database to validate.
  API_TOKEN_PEPPER must be configured so fixture API sessions are seeded and validated.
  KOED_LAUNCH_BASE_URL, KOED_LAUNCH_SESSION_COOKIE,
  KOED_LAUNCH_DEVICE_CREDENTIAL, KOED_LAUNCH_API_TOKEN,
  KOED_LAUNCH_TEAM_WORKSPACE_ID, KOED_LAUNCH_TEAM_NODE_ID,
  KOED_LAUNCH_LOCAL_EDGE_BASE_URL, and KOED_LAUNCH_LOCAL_EDGE_BACKEND_ID
  provide equivalent staged-remote defaults.
`;

loadRootEnv(process.cwd(), process.env);

const args = process.argv.slice(2);
const withAutomatedTests = args.includes("--with-automated-tests");
const withStagedRemote = args.includes("--with-staged-remote");
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(usage);
  process.exit(0);
}

const stagedRemoteOptionFlags = new Set([
  "--base-url",
  "--session-cookie",
  "--device-credential",
  "--api-token",
  "--team-workspace-id",
  "--team-node-id",
  "--local-edge-base-url",
  "--local-edge-backend-id"
]);
const stagedRemoteOptions = defaultStagedRemoteOptions(process.env);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--with-automated-tests" || arg === "--with-staged-remote") {
    continue;
  }
  if (stagedRemoteOptionFlags.has(arg)) {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      console.error(`${arg} requires a value.`);
      process.exit(2);
    }
    if (arg === "--base-url") {
      stagedRemoteOptions.baseUrl = value;
    } else if (arg === "--session-cookie") {
      stagedRemoteOptions.sessionCookie = value;
    } else if (arg === "--device-credential") {
      stagedRemoteOptions.deviceCredential = value;
    } else if (arg === "--api-token") {
      stagedRemoteOptions.apiToken = value;
    } else if (arg === "--team-workspace-id") {
      stagedRemoteOptions.teamWorkspaceId = value;
    } else if (arg === "--team-node-id") {
      stagedRemoteOptions.teamNodeId = value;
    } else if (arg === "--local-edge-base-url") {
      stagedRemoteOptions.localEdgeBaseUrl = value;
    } else if (arg === "--local-edge-backend-id") {
      stagedRemoteOptions.localEdgeBackendId = value;
    }
    index += 1;
    continue;
  }
  if (arg.startsWith("--")) {
    console.error(`Unknown option: ${arg}`);
    process.exit(2);
  }
}

if (!process.env.DATABASE_URL?.trim()) {
  console.error("DATABASE_URL is required. Run pnpm env:setup or set it.");
  process.exit(2);
}

try {
  assertLaunchValidationEnvironment(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

try {
  await client.connect();
  const stagedRemote = withStagedRemote
    ? await runStagedRemoteValidation(stagedRemoteOptions)
    : null;
  const summary = await validateLaunchReadiness(client, {
    automatedTestStatus: withAutomatedTests ? "passed" : "not_run",
    stagedRemote
  });
  if (withAutomatedTests) {
    for (const testCommand of automatedLaunchTestCommands) {
      console.error(
        `Running ${testCommand.id}: ${[
          testCommand.command,
          ...testCommand.args
        ].join(" ")}`
      );
      const result = spawnSync(testCommand.command, testCommand.args, {
        cwd: process.cwd(),
        env: process.env,
        stdio: "inherit"
      });
      if (result.status !== 0) {
        throw new Error(
          `Automated launch test command failed: ${testCommand.id}`
        );
      }
    }
  }
  process.stdout.write(formatLaunchValidationReport(summary));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
