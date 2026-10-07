import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface NodeEntrypointInvocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface KoedServerRuntimeOptions {
  appIsPackaged: boolean;
  electronExecPath: string;
  platform: NodeJS.Platform;
  resourcesPath?: string;
  environment: NodeJS.ProcessEnv;
  existsSync?: (path: string) => boolean;
}

export interface KoedServerPathOptions {
  appDir: string;
  appIsPackaged: boolean;
  environment: NodeJS.ProcessEnv;
  resourcesPath?: string;
}

export interface KoedServerPaths {
  repoRoot: string;
  cliPath: string;
}

const currentDir = dirname(fileURLToPath(import.meta.url));

export const resolveKoedServerPaths = ({
  appDir,
  appIsPackaged,
  environment,
  resourcesPath
}: KoedServerPathOptions): KoedServerPaths => {
  const explicitCliPath =
    !appIsPackaged && environment.KOED_SERVER_CLI?.trim()
      ? resolve(environment.KOED_SERVER_CLI)
      : undefined;

  if (!appIsPackaged && environment.KOED_REPO_ROOT?.trim()) {
    const repoRoot = resolve(environment.KOED_REPO_ROOT);
    return {
      repoRoot,
      cliPath:
        explicitCliPath ?? resolve(repoRoot, "packages/koed-server/dist/cli.js")
    };
  }

  if (!appIsPackaged && explicitCliPath) {
    return {
      repoRoot: resolve(dirname(explicitCliPath), "..", "..", ".."),
      cliPath: explicitCliPath
    };
  }

  if (appIsPackaged) {
    if (
      environment.KOED_SERVER_CLI?.trim() ||
      environment.KOED_REPO_ROOT?.trim() ||
      environment.KOED_NODE_COMMAND?.trim()
    ) {
      throw new Error("Packaged Desktop runtime overrides are not allowed.");
    }
    const packagedResourcesPath = resourcesPath ?? resolve(appDir, "..");
    return {
      repoRoot: packagedResourcesPath,
      cliPath: resolve(
        packagedResourcesPath,
        "app.asar",
        "node_modules",
        "@koed-labs",
        "server",
        "dist",
        "cli.js"
      )
    };
  }

  const repoRoot = resolve(appDir, "..", "..", "..");
  return {
    repoRoot,
    cliPath: resolve(repoRoot, "packages/koed-server/dist/cli.js")
  };
};

export const createElectronNodeEnv = (
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv => {
  const packagedEnvironment = { ...environment };
  delete packagedEnvironment.KOED_SERVER_CLI;
  delete packagedEnvironment.KOED_REPO_ROOT;
  delete packagedEnvironment.KOED_NODE_COMMAND;
  return {
    ...packagedEnvironment,
    ELECTRON_RUN_AS_NODE: "1"
  };
};

export const resolveElectronNodeExecPath = ({
  appIsPackaged,
  electronExecPath,
  platform,
  existsSync: pathExists = existsSync
}: Pick<
  KoedServerRuntimeOptions,
  "appIsPackaged" | "electronExecPath" | "platform" | "existsSync"
>): string => {
  if (!appIsPackaged) return electronExecPath;
  if (platform !== "darwin" && platform !== "win32" && platform !== "linux") {
    throw new Error(`Unsupported packaged Electron platform: ${platform}`);
  }
  if (!pathExists(electronExecPath)) {
    throw new Error("Packaged Electron executable is unavailable");
  }
  return electronExecPath;
};

const resolvePackagedRunnerPath = (resourcesPath?: string): string => {
  if (resourcesPath) {
    return resolve(
      resourcesPath,
      "app.asar.unpacked",
      "dist-electron",
      "koed-server",
      "node-entrypoint-runner.js"
    );
  }
  return resolve(currentDir, "node-entrypoint-runner.js");
};

const daemonInvocationEnvironment = (
  environment: NodeJS.ProcessEnv,
  command: string,
  args: string[]
): NodeJS.ProcessEnv => {
  if (!args.includes("--daemon")) {
    return environment;
  }
  return {
    ...environment,
    KOED_SERVER_DAEMON_COMMAND: command,
    KOED_SERVER_DAEMON_ARGS_JSON: JSON.stringify(
      args.filter((arg) => arg !== "--daemon" && arg !== "--json")
    )
  };
};

export const createNodeEntrypointInvocation = (
  entrypointPath: string,
  args: string[],
  options: KoedServerRuntimeOptions
): NodeEntrypointInvocation => {
  const explicitNodeCommand = options.appIsPackaged
    ? undefined
    : options.environment.KOED_NODE_COMMAND?.trim();
  if (explicitNodeCommand) {
    const invocationArgs = [entrypointPath, ...args];
    return {
      command: explicitNodeCommand,
      args: invocationArgs,
      env: options.environment
    };
  }

  const command = options.appIsPackaged
    ? resolveElectronNodeExecPath(options)
    : "node";
  const env = options.appIsPackaged
    ? createElectronNodeEnv(options.environment)
    : options.environment;

  if (options.appIsPackaged) {
    const invocationArgs = [
      resolvePackagedRunnerPath(options.resourcesPath),
      "node-script",
      entrypointPath,
      ...args
    ];
    return {
      command,
      args: invocationArgs,
      env
    };
  }

  const invocationArgs = [entrypointPath, ...args];
  return {
    command,
    args: invocationArgs,
    env
  };
};

export const createKoedServerCliInvocation = (
  cliPath: string,
  args: string[],
  options: KoedServerRuntimeOptions
): NodeEntrypointInvocation => {
  const invocation = createNodeEntrypointInvocation(cliPath, args, options);
  return {
    ...invocation,
    env: daemonInvocationEnvironment(
      invocation.env,
      invocation.command,
      invocation.args
    )
  };
};
