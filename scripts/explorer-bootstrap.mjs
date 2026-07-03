#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { upsertEnvFileValue } from "./env-file-utils.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultToken =
  process.env.VITE_KOED_API_TOKEN ??
  process.env.MEMORY_API_TOKEN ??
  process.env.CODEX_MEMORY_API_TOKEN ??
  "";

const usageText = `Usage: pnpm explorer:bootstrap [options]

Options:
  --token <token>         Koed API token used to prefill Explorer config.
  --skip-refresh          Skip rebuilding local Explorer assets.
  --help                  Show this help.

Environment:
  VITE_KOED_API_TOKEN     Token written into Explorer local config.
  MEMORY_API_TOKEN        Fallback token written into Explorer local config.
  CODEX_MEMORY_API_TOKEN  Fallback token written into Explorer local config.
`;

const parseArgs = (argv, environment = process.env) => {
  const parsed = {
    token:
      environment.VITE_KOED_API_TOKEN ??
      environment.MEMORY_API_TOKEN ??
      environment.CODEX_MEMORY_API_TOKEN ??
      defaultToken,
    skipRefresh: false,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--skip-refresh") {
      parsed.skipRefresh = true;
      continue;
    }
    if (arg === "--token") {
      parsed.token = readFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--token=")) {
      parsed.token = arg.slice("--token=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n\n${usageText}`);
  }

  if (parsed.help) {
    return parsed;
  }

  parsed.token = parsed.token.trim();
  if (!parsed.token) {
    throw new Error(
      `Explorer API token is required. Run pnpm clients:bootstrap, run pnpm codex:bootstrap first, or pass --token.\n\n${usageText}`
    );
  }

  return parsed;
};

const readFlagValue = (argv, index, flag) => {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.\n\n${usageText}`);
  }
  return value;
};

const runCommand = ({
  label,
  command,
  args,
  cwd = rootDir,
  environment = process.env
}) => {
  console.log(`> ${label}`);
  const result = spawnSync(command, args, {
    cwd,
    env: environment,
    stdio: "inherit"
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? 1}.`);
  }
};

const writeExplorerTokenConfig = ({ rootDir: repoRoot, token }) => {
  upsertEnvFileValue(resolve(repoRoot, ".env"), "MEMORY_API_TOKEN", token);
  upsertEnvFileValue(resolve(repoRoot, ".env"), "VITE_KOED_API_TOKEN", token);
  for (const envFile of [".env.local", ".env.production.local"]) {
    upsertEnvFileValue(
      resolve(repoRoot, "apps/explorer", envFile),
      "VITE_KOED_API_TOKEN",
      token
    );
  }
};

export const runExplorerBootstrap = async ({
  argv = process.argv.slice(2),
  environment = process.env,
  token = null,
  rootDir: bootstrapRootDir = rootDir,
  writeExplorerTokenConfigFn = writeExplorerTokenConfig,
  runCommandFn = runCommand,
  onComplete = (result) => {
    console.log("Explorer bootstrap complete.");
    console.log(`Root .env token: ${result.paths.rootEnvPath}`);
    console.log(`Explorer local token: ${result.paths.explorerEnvPath}`);
    console.log(
      `Explorer refresh: ${result.args.skipRefresh ? "skipped" : "rebuilt"}`
    );
  }
} = {}) => {
  const args = parseArgs(argv, environment);
  const effectiveToken = (token ?? args.token).trim();

  writeExplorerTokenConfigFn({
    rootDir: bootstrapRootDir,
    token: effectiveToken
  });

  if (!args.skipRefresh) {
    await runCommandFn({
      label: "Build Explorer assets",
      command: "pnpm",
      args: ["--filter", "@koed/explorer", "build"],
      cwd: bootstrapRootDir,
      environment: {
        ...process.env,
        ...environment,
        MEMORY_API_TOKEN: effectiveToken,
        VITE_KOED_API_TOKEN: effectiveToken
      }
    });
  }

  const result = {
    help: false,
    args,
    paths: {
      rootEnvPath: resolve(bootstrapRootDir, ".env"),
      explorerEnvPath: resolve(bootstrapRootDir, "apps/explorer/.env.local")
    }
  };
  await onComplete(result);
  return result;
};

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const initialArgs = parseArgs(process.argv.slice(2), process.env);
    if (initialArgs.help) {
      process.stdout.write(usageText);
    } else {
      await runExplorerBootstrap({ argv: process.argv.slice(2) });
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
