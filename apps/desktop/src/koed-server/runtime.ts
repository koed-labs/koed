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
  const explicitCliPath = environment.KOED_SERVER_CLI?.trim()
    ? resolve(environment.KOED_SERVER_CLI)
    : undefined;

  if (environment.KOED_REPO_ROOT?.trim()) {
    const repoRoot = resolve(environment.KOED_REPO_ROOT);
    return {
      repoRoot,
      cliPath:
        explicitCliPath ?? resolve(repoRoot, "packages/koed-server/dist/cli.js")
    };
  }

  if (explicitCliPath) {
    return {
      repoRoot: resolve(dirname(explicitCliPath), "..", "..", ".."),
      cliPath: explicitCliPath
    };
  }

  if (appIsPackaged) {
    const packagedResourcesPath = resourcesPath ?? resolve(appDir, "..");
    return {
      repoRoot: packagedResourcesPath,
      cliPath: resolve(
        packagedResourcesPath,
        "app.asar",
        "node_modules",
        "@koed",
        "koed-server",
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
): NodeJS.ProcessEnv => ({
  ...environment,
  ELECTRON_RUN_AS_NODE: "1"
});

export const resolveElectronNodeExecPath = ({
  appIsPackaged,
  electronExecPath,
  platform,
  existsSync: pathExists = existsSync
}: Pick<
  KoedServerRuntimeOptions,
  "appIsPackaged" | "electronExecPath" | "platform" | "existsSync"
>): string => {
  void appIsPackaged;
  void platform;
  void pathExists;
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

export const createKoedServerCliInvocation = (
  cliPath: string,
  args: string[],
  options: KoedServerRuntimeOptions
): NodeEntrypointInvocation => {
  const explicitNodeCommand = options.environment.KOED_NODE_COMMAND?.trim();
  if (explicitNodeCommand) {
    return {
      command: explicitNodeCommand,
      args: [cliPath, ...args],
      env: options.environment
    };
  }

  const command = resolveElectronNodeExecPath(options);
  const env = createElectronNodeEnv(options.environment);

  if (options.appIsPackaged) {
    return {
      command,
      args: [
        resolvePackagedRunnerPath(options.resourcesPath),
        "node-script",
        cliPath,
        ...args
      ],
      env
    };
  }

  return {
    command,
    args: [cliPath, ...args],
    env
  };
};
