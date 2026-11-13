import { existsSync, realpathSync, statSync } from "node:fs";
import { extname, join, basename } from "node:path";

export interface NodeCliInvocation {
  command: string;
  args: string[];
  nodeExecutable?: string;
}

const NODE_ENTRY_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);

export const nodeCliInvocation = (
  executablePath: string,
  args: string[],
  nodeExecutable: string = process.execPath
): NodeCliInvocation => {
  let resolvedExecutablePath = executablePath;
  try {
    resolvedExecutablePath = realpathSync(executablePath);
  } catch {
    // Bare PATH commands and missing paths retain their original diagnostics.
  }
  return NODE_ENTRY_EXTENSIONS.has(
    extname(resolvedExecutablePath).toLowerCase()
  )
    ? {
        command: nodeExecutable,
        args: [resolvedExecutablePath, ...args],
        nodeExecutable
      }
    : { command: resolvedExecutablePath, args };
};

/**
 * Internal pure resolver for testing. Derives the macOS Helper executable
 * from an app-bundled Electron executable path.
 */
export const resolveThirdPartyNodeCliExecutableInternal = (
  executablePath: string,
  platform: NodeJS.Platform
): string => {
  // Only eligible on macOS
  if (platform !== "darwin") {
    return executablePath;
  }

  // Must be inside an Electron app bundle (Contents/Frameworks/...)
  if (!executablePath.includes("/Contents/Frameworks/")) {
    return executablePath;
  }

  // Extract the app bundle path (everything before /Contents/Frameworks/)
  const slash = executablePath.indexOf("/Contents/Frameworks/");
  if (slash === -1) {
    return executablePath;
  }
  const appBundlePath = executablePath.slice(0, slash);

  // Extract product name from the .app bundle filename (e.g. "Koed" from "Koed.app")
  const appBundleName = basename(appBundlePath);
  const productName = appBundleName.replace(/\.app$/, "");

  if (!productName) {
    return executablePath;
  }

  // Derive the Helper.app path
  const helperAppPath = join(
    appBundlePath,
    "Contents",
    "Frameworks",
    `${productName} Helper.app`,
    "Contents",
    "MacOS",
    `${productName} Helper`
  );

  // Verify Helper exists, is a regular file, and is executable
  if (!existsSync(helperAppPath)) {
    return executablePath;
  }

  try {
    const stats = statSync(helperAppPath);
    if (!stats.isFile() || !stats.mode || (stats.mode & 0o111) === 0) {
      return executablePath;
    }
  } catch {
    return executablePath;
  }

  return helperAppPath;
};

/**
 * Resolves the third-party Node CLI executable for macOS.
 *
 * When the executable is an app-bundled Electron binary on Darwin and a
 * matching `Contents/Frameworks/<Product> Helper.app/Contents/MacOS/<Product> Helper`
 * exists and is executable, returns that Helper path. Otherwise falls back
 * to the original executable.
 *
 * Only third-party CLI callsites should pass the result of this function
 * as `nodeExecutable` to `nodeCliInvocation`.
 */
export const resolveThirdPartyNodeCliExecutable = (
  executablePath: string = process.execPath,
  runtimeEnvironment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string =>
  resolveThirdPartyNodeCliExecutableInternal(executablePath, platform);

export const nodeCliProcessEnvironment = (
  invocation: NodeCliInvocation,
  environment: NodeJS.ProcessEnv,
  runtimeEnvironment: NodeJS.ProcessEnv = process.env,
  nodeExecutable: string = process.execPath
): NodeJS.ProcessEnv =>
  invocation.command === nodeExecutable &&
  runtimeEnvironment.ELECTRON_RUN_AS_NODE === "1"
    ? { ...environment, ELECTRON_RUN_AS_NODE: "1" }
    : environment;
