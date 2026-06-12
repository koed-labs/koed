#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCodexBootstrap } from "./codex-bootstrap.mjs";
import { runExplorerBootstrap } from "./explorer-bootstrap.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const usageText = `Usage: pnpm clients:bootstrap

Runs the guided Koed bootstrap path:
  1. Prepare the environment
  2. Start backend services
  3. Create or reuse the API token
  4. Configure Codex
  5. Write Explorer token config
  6. Verify capture and doctor health
`;

const hasHelpArg = (argv) =>
  argv.some((arg) => arg === "--help" || arg === "-h");

const runCommand = ({ label, command, args, cwd = rootDir }) => {
  console.log(`> ${label}`);
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: "inherit"
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? 1}.`);
  }
};

export const runClientsBootstrap = async ({
  argv = process.argv.slice(2),
  environment = process.env,
  rootDir: bootstrapRootDir = rootDir,
  runCommandFn = runCommand,
  runCodexBootstrapFn = runCodexBootstrap,
  runExplorerBootstrapFn = runExplorerBootstrap,
  onComplete = (result) => {
    console.log("Koed client bootstrap complete.");
    console.log(`API token owner: ${result.codex.tokenResult.owner.email}`);
    console.log(`Root env token: ${result.explorer.paths.rootEnvPath}`);
    console.log(
      `Explorer local token: ${result.explorer.paths.explorerEnvPath}`
    );
    console.log(
      `Capture verification: ${result.codex.args.skipVerify ? "skipped" : "passed"}`
    );
    console.log(
      `Doctor check: ${result.codex.args.skipDoctor ? "skipped" : "passed"}`
    );
  }
} = {}) => {
  if (hasHelpArg(argv)) {
    return { help: true };
  }

  await runCommandFn({
    label: "Prepare local environment",
    command: process.execPath,
    args: [resolve(bootstrapRootDir, "scripts/setup-env.mjs")],
    cwd: bootstrapRootDir
  });

  await runCommandFn({
    label: "Start Koed backend services",
    command: "docker",
    args: [
      "compose",
      "up",
      "-d",
      "--build",
      "postgres",
      "redis",
      "embedding-service",
      "api",
      "worker"
    ],
    cwd: bootstrapRootDir
  });

  const codex = await runCodexBootstrapFn({
    argv: [],
    environment,
    skipSetup: true
  });

  const explorer = await runExplorerBootstrapFn({
    token: codex.tokenResult.token,
    rootDir: bootstrapRootDir,
    environment
  });

  const result = { codex, explorer };
  await onComplete(result);
  return result;
};

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (hasHelpArg(process.argv.slice(2))) {
      process.stdout.write(usageText);
    } else {
      await runClientsBootstrap({});
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
