#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createApiTokenBootstrap,
  formatCliError,
  formatCreateApiTokenResult,
  loadRootEnv,
  UsageError
} from "./api-token-bootstrap-lib.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultOwnerEmail = "local@koed.ai";
const defaultTokenName = "Codex";
const defaultApiUrl = "http://localhost:3300";
const defaultNodeCommand = "node";
const defaultAppServerBinary = "codex";
const setupEnvScript = resolve(rootDir, "scripts/setup-env.mjs");
const configureCodexScript = resolve(rootDir, "scripts/configure-codex.mjs");
const verifyCaptureScript = resolve(
  rootDir,
  "scripts/verify-codex-capture-hook.mjs"
);
const mcpDoctorScript = resolve(rootDir, "packages/mcp-server/dist/cli.js");

const usageText = `Usage: pnpm codex:bootstrap [options]

Options:
  --owner-email <email>   Email for the local owner user. Defaults to ${defaultOwnerEmail}.
  --name <name>           API token name. Defaults to "${defaultTokenName}".
  --api-url <url>         Koed API URL. Defaults to ${defaultApiUrl}.
  --node-command <cmd>    Node command used by the Codex setup script. Defaults to "${defaultNodeCommand}".
  --skip-build            Skip the @koed/mcp-server build step.
  --skip-verify           Skip capture verification.
  --skip-doctor           Skip the final doctor check.
  --help                  Show this help.

Environment:
  MEMORY_API_URL                 Used when --api-url is not set.
  CODEX_MEMORY_BASE_URL          Used when MEMORY_API_URL is not set.
  MEMORY_NODE_COMMAND            Used when --node-command is not set.
  MEMORY_CODEX_APP_SERVER_BINARY  Overrides the Codex app-server binary written by configure-codex.
  KOED_PROMPT_DIR                 Optional prompt override directory written into the MCP environment.
`;

export const parseBootstrapArgs = (argv, environment = process.env) => {
  const parsed = {
    ownerEmail: defaultOwnerEmail,
    name: defaultTokenName,
    apiUrl:
      environment.MEMORY_API_URL ??
      environment.CODEX_MEMORY_BASE_URL ??
      defaultApiUrl,
    nodeCommand: environment.MEMORY_NODE_COMMAND ?? defaultNodeCommand,
    skipBuild: false,
    skipVerify: false,
    skipDoctor: false,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--skip-build") {
      parsed.skipBuild = true;
      continue;
    }
    if (arg === "--skip-verify") {
      parsed.skipVerify = true;
      continue;
    }
    if (arg === "--skip-doctor") {
      parsed.skipDoctor = true;
      continue;
    }
    if (arg === "--owner-email") {
      parsed.ownerEmail = readFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--owner-email=")) {
      parsed.ownerEmail = arg.slice("--owner-email=".length);
      continue;
    }
    if (arg === "--name") {
      parsed.name = readFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--name=")) {
      parsed.name = arg.slice("--name=".length);
      continue;
    }
    if (arg === "--api-url") {
      parsed.apiUrl = readFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--api-url=")) {
      parsed.apiUrl = arg.slice("--api-url=".length);
      continue;
    }
    if (arg === "--node-command") {
      parsed.nodeCommand = readFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--node-command=")) {
      parsed.nodeCommand = arg.slice("--node-command=".length);
      continue;
    }
    throw new UsageError(`Unknown argument: ${arg}\n\n${usageText}`);
  }

  if (parsed.help) {
    return parsed;
  }

  parsed.ownerEmail = parsed.ownerEmail.trim().toLowerCase();
  parsed.name = parsed.name.trim();
  parsed.apiUrl = parsed.apiUrl.trim();
  parsed.nodeCommand = parsed.nodeCommand.trim();

  if (!parsed.ownerEmail) {
    throw new UsageError(`--owner-email must not be empty.\n\n${usageText}`);
  }
  if (!parsed.name) {
    throw new UsageError(`--name must not be empty.\n\n${usageText}`);
  }
  if (!parsed.apiUrl) {
    throw new UsageError(`--api-url must not be empty.\n\n${usageText}`);
  }
  if (!parsed.nodeCommand) {
    throw new UsageError(`--node-command must not be empty.\n\n${usageText}`);
  }

  return parsed;
};

const hasHelpArg = (argv) =>
  argv.some((arg) => arg === "--help" || arg === "-h");

const readFlagValue = (argv, index, flag) => {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new UsageError(`${flag} requires a value.\n\n${usageText}`);
  }
  return value;
};

const runCommand = ({
  label,
  command,
  args,
  cwd = rootDir,
  env = {},
  captureOutput = false
}) => {
  console.log(`> ${label}`);
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: captureOutput ? "utf8" : undefined,
    stdio: captureOutput ? ["ignore", "pipe", "pipe"] : "inherit"
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const stdout = captureOutput ? result.stdout?.trim() : "";
    const stderr = captureOutput ? result.stderr?.trim() : "";
    throw new Error(
      [
        `${label} failed with exit code ${result.status ?? 1}.`,
        stdout ? `stdout: ${stdout}` : null,
        stderr ? `stderr: ${stderr}` : null
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  return {
    stdout: captureOutput ? (result.stdout ?? "") : "",
    stderr: captureOutput ? (result.stderr ?? "") : ""
  };
};

const resolveBootstrapPaths = (environment) => ({
  codexConfigPath: resolve(
    environment.CODEX_CONFIG_PATH ?? `${homedir()}/.codex/config.toml`
  ),
  hookConfigPath: resolve(
    environment.MEMORY_HOOK_CONFIG ?? `${homedir()}/.koed/config.json`
  )
});

export const runCodexBootstrap = async ({
  argv = process.argv.slice(2),
  environment = process.env,
  repo = null,
  createRepoFn = null,
  loadRootEnvFn = loadRootEnv,
  createTokenBootstrap = createApiTokenBootstrap,
  runCommandFn = runCommand,
  skipSetup = false,
  onTokenCreated = (tokenResult) =>
    console.log(formatCreateApiTokenResult(tokenResult)),
  onComplete = (result) => {
    console.log("Koed Codex bootstrap complete.");
    console.log(`API URL: ${result.args.apiUrl}`);
    console.log(`Token owner: ${result.tokenResult.owner.email}`);
    console.log(`Codex config: ${result.paths.codexConfigPath}`);
    console.log(`Capture hook config: ${result.paths.hookConfigPath}`);
    console.log(
      `Capture verification: ${result.args.skipVerify ? "skipped" : "passed"}`
    );
    console.log(
      `Doctor check: ${result.args.skipDoctor ? "skipped" : "passed"}`
    );
  }
} = {}) => {
  if (hasHelpArg(argv)) {
    return { help: true };
  }

  let activeRepo = repo;
  let shouldCloseRepo = false;

  try {
    if (!skipSetup) {
      await runCommandFn({
        label: "Prepare local environment",
        command: process.execPath,
        args: [setupEnvScript]
      });
    }

    loadRootEnvFn(rootDir, environment);

    const args = parseBootstrapArgs(argv, environment);
    const resolvedPaths = resolveBootstrapPaths(environment);
    const appServerBinary =
      environment.MEMORY_CODEX_APP_SERVER_BINARY ?? defaultAppServerBinary;
    const configuredPromptOverrideDirectory =
      environment.KOED_PROMPT_DIR?.trim();
    const promptOverrideDirectory = configuredPromptOverrideDirectory
      ? resolve(rootDir, configuredPromptOverrideDirectory)
      : undefined;
    const promptOverrideEnv = promptOverrideDirectory
      ? { KOED_PROMPT_DIR: promptOverrideDirectory }
      : {};

    await runCommandFn({
      label: "Build @koed/db",
      command: "pnpm",
      args: ["--filter", "@koed/db", "build"]
    });

    if (!activeRepo) {
      if (!createRepoFn) {
        ({ createApiTokenScriptRepo: createRepoFn } =
          await import("../packages/db/scripts/api-token-repo.mjs"));
      }
      activeRepo = createRepoFn(environment.DATABASE_URL);
      shouldCloseRepo = true;
    }

    if (!args.skipBuild) {
      await runCommandFn({
        label: "Build @koed/mcp-server",
        command: "pnpm",
        args: ["--filter", "@koed/mcp-server", "build"]
      });
    }

    const tokenResult = await createTokenBootstrap({
      repo: activeRepo,
      environment,
      argv: ["--owner-email", args.ownerEmail, "--name", args.name]
    });

    await onTokenCreated(tokenResult);

    await runCommandFn({
      label: "Configure Codex",
      command: process.execPath,
      args: [configureCodexScript],
      env: {
        MEMORY_API_URL: args.apiUrl,
        MEMORY_API_TOKEN: tokenResult.token,
        MEMORY_NODE_COMMAND: args.nodeCommand,
        MEMORY_CODEX_APP_SERVER_BINARY: appServerBinary,
        ...promptOverrideEnv
      }
    });

    if (!args.skipVerify) {
      await runCommandFn({
        label: "Verify capture",
        command: process.execPath,
        args: [verifyCaptureScript],
        env: {
          MEMORY_API_URL: args.apiUrl,
          MEMORY_API_TOKEN: tokenResult.token,
          MEMORY_NODE_COMMAND: args.nodeCommand
        }
      });
    }

    let doctorResult = null;
    if (!args.skipDoctor) {
      const doctorOutput = await runCommandFn({
        label: "Run doctor",
        command: process.execPath,
        args: [mcpDoctorScript, "doctor"],
        env: {
          MEMORY_API_URL: args.apiUrl,
          MEMORY_API_TOKEN: tokenResult.token,
          MEMORY_CODEX_APP_SERVER_BINARY: appServerBinary,
          ...promptOverrideEnv
        },
        captureOutput: true
      });

      const parsedDoctor = JSON.parse(doctorOutput.stdout.trim() || "{}");
      if (!parsedDoctor.ok) {
        throw new Error(
          `Doctor check failed: ${
            parsedDoctor.error ?? doctorOutput.stderr.trim() ?? "unknown error"
          }`
        );
      }
      doctorResult = parsedDoctor;
    }

    const result = {
      help: false,
      args,
      paths: resolvedPaths,
      tokenResult,
      doctorResult
    };
    await onComplete(result);
    return result;
  } finally {
    if (shouldCloseRepo) {
      await activeRepo.close?.().catch(() => {});
    }
  }
};

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const initialArgs = parseBootstrapArgs(process.argv.slice(2), process.env);
    if (initialArgs.help) {
      process.stdout.write(usageText);
    } else {
      await runCodexBootstrap({
        argv: process.argv.slice(2)
      });
    }
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      process.exitCode = 2;
    } else {
      console.error(formatCliError(error));
      process.exitCode = 1;
    }
  }
}
