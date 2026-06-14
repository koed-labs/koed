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

const currentDir = dirname(fileURLToPath(import.meta.url));

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
  if (appIsPackaged && platform === "darwin") {
    const marker = ".app/Contents/MacOS/";
    const markerIndex = electronExecPath.indexOf(marker);
    if (markerIndex !== -1) {
      const bundleRoot = electronExecPath.substring(
        0,
        markerIndex + ".app".length
      );
      const appName = electronExecPath.slice(markerIndex + marker.length);
      const helperPath = `${bundleRoot}/Contents/Frameworks/${appName} Helper.app/Contents/MacOS/${appName} Helper`;
      if (pathExists(helperPath)) {
        return helperPath;
      }
    }
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
