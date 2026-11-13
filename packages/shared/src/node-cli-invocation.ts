import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
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

  const match = executablePath.match(
    /^(.*\.app)\/Contents\/(Frameworks\/.*|MacOS\/[^/]+)$/
  );
  if (!match) {
    return executablePath;
  }
  const appBundlePath = match[1]!;

  const executableInsideBundle = match[2]!;
  let productName: string;
  if (executableInsideBundle.startsWith("MacOS/")) {
    productName = basename(executableInsideBundle);
  } else {
    try {
      const helpers = readdirSync(
        join(appBundlePath, "Contents", "Frameworks")
      ).filter((name) => name.endsWith(" Helper.app"));
      if (helpers.length !== 1) return executablePath;
      productName = helpers[0]!.slice(0, -" Helper.app".length);
    } catch {
      return executablePath;
    }
  }
  if (!productName) return executablePath;

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
  platform: NodeJS.Platform = process.platform
): string =>
  resolveThirdPartyNodeCliExecutableInternal(executablePath, platform);

export const nodeCliProcessEnvironment = (
  invocation: NodeCliInvocation,
  environment: NodeJS.ProcessEnv,
  runtimeEnvironment: NodeJS.ProcessEnv = process.env,
  nodeExecutable: string = invocation.nodeExecutable ?? process.execPath
): NodeJS.ProcessEnv => {
  if (invocation.nodeExecutable === undefined) return environment;
  return invocation.command === nodeExecutable &&
    (runtimeEnvironment.ELECTRON_RUN_AS_NODE === "1" ||
      (Boolean(process.versions.electron) &&
        invocation.command === process.execPath) ||
      /\/Contents\/Frameworks\/([^/]+ Helper)\.app\/Contents\/MacOS\/\1$/.test(
        invocation.nodeExecutable
      ))
    ? { ...environment, ELECTRON_RUN_AS_NODE: "1" }
    : environment;
};
