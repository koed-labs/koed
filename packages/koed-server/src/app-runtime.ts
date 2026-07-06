import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { KoedServerPaths } from "./paths.js";
import {
  canUseSourceCheckoutFallback,
  isPackagedRuntimeMode,
  resolvePackagedKoedRuntimeRoot,
  trimRuntimeValue,
  type RuntimeArtifactSource
} from "./runtime-artifact-source.js";

export type KoedAppRuntimeKind = "source" | "packaged";

export interface KoedAppRuntime {
  kind: KoedAppRuntimeKind;
  artifactSource: RuntimeArtifactSource;
  root: string;
  apiEntry: string;
  workerEntry: string;
  explorerDist: string;
  mcpCli: string;
  captureHook: string;
  dbPackageRoot: string;
  missing: string[];
}

const koedHomeRuntimeRoot = (paths: KoedServerPaths): string =>
  resolve(paths.koedHome, "runtime", "koed-runtime");

const packagedRuntime = (
  root: string,
  artifactSource: RuntimeArtifactSource,
  exists: (path: string) => boolean
): KoedAppRuntime => {
  const apiEntry = resolve(root, "api", "dist", "index.js");
  const workerEntry = resolve(root, "worker", "dist", "index.js");
  const explorerDist = resolve(root, "explorer-dist");
  const mcpCli = resolve(root, "mcp-server", "dist", "cli.js");
  const captureHook = resolve(root, "mcp-server", "dist", "capture-hook.js");
  const dbPackageRoot = resolve(root, "api", "node_modules", "@koed", "db");
  const required = [
    apiEntry,
    workerEntry,
    resolve(explorerDist, "index.html"),
    mcpCli,
    captureHook,
    resolve(dbPackageRoot, "dist", "index.js"),
    resolve(dbPackageRoot, "drizzle", "meta", "_journal.json")
  ];
  return {
    kind: "packaged",
    artifactSource,
    root,
    apiEntry,
    workerEntry,
    explorerDist,
    mcpCli,
    captureHook,
    dbPackageRoot,
    missing: required.filter((entry) => !exists(entry))
  };
};

const sourceRuntime = (
  paths: KoedServerPaths,
  exists: (path: string) => boolean
): KoedAppRuntime => {
  const root = paths.repoRoot;
  const apiEntry = resolve(root, "apps", "api", "dist", "index.js");
  const workerEntry = resolve(root, "apps", "worker", "dist", "index.js");
  const explorerDist = resolve(root, "apps", "explorer", "dist");
  const mcpCli = resolve(root, "packages", "mcp-server", "dist", "cli.js");
  const captureHook = resolve(
    root,
    "packages",
    "mcp-server",
    "dist",
    "capture-hook.js"
  );
  const dbPackageRoot = resolve(root, "packages", "db");
  const required = [
    resolve(root, "scripts", "setup-env.mjs"),
    resolve(root, "apps", "api", "package.json"),
    resolve(root, "apps", "worker", "package.json"),
    resolve(root, "apps", "explorer", "package.json"),
    resolve(root, "packages", "db", "package.json"),
    resolve(root, "packages", "mcp-server", "package.json")
  ];
  return {
    kind: "source",
    artifactSource: "source-checkout",
    root,
    apiEntry,
    workerEntry,
    explorerDist,
    mcpCli,
    captureHook,
    dbPackageRoot,
    missing: required.filter((entry) => !exists(entry))
  };
};

export const resolveKoedAppRuntime = (
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync
): KoedAppRuntime => {
  const explicitPackagedRoot = trimRuntimeValue(
    environment.KOED_JS_RUNTIME_ROOT
  );
  if (explicitPackagedRoot) {
    return packagedRuntime(
      resolve(explicitPackagedRoot),
      "explicit-override",
      exists
    );
  }

  const koedHomeRuntime = packagedRuntime(
    koedHomeRuntimeRoot(paths),
    "koed-home-runtime",
    exists
  );
  if (koedHomeRuntime.missing.length === 0) {
    return koedHomeRuntime;
  }

  const packagedResourcesRoot = resolvePackagedKoedRuntimeRoot(environment);
  const packagedResourcesRuntime = packagedResourcesRoot
    ? packagedRuntime(packagedResourcesRoot, "packaged-resource", exists)
    : null;
  if (packagedResourcesRuntime?.missing.length === 0) {
    return packagedResourcesRuntime;
  }

  const legacyPackagedRuntime = packagedRuntime(
    resolve(paths.repoRoot, "koed-runtime"),
    "packaged-resource",
    exists
  );
  if (legacyPackagedRuntime.missing.length === 0) {
    return legacyPackagedRuntime;
  }

  if (
    isPackagedRuntimeMode(environment) &&
    !canUseSourceCheckoutFallback(environment)
  ) {
    return packagedResourcesRuntime ?? legacyPackagedRuntime ?? koedHomeRuntime;
  }

  if (canUseSourceCheckoutFallback(environment)) {
    return sourceRuntime(paths, exists);
  }

  return packagedResourcesRuntime ?? legacyPackagedRuntime ?? koedHomeRuntime;
};

export const assertKoedAppRuntimeAvailable = (
  runtime: KoedAppRuntime,
  paths: KoedServerPaths
): void => {
  if (runtime.missing.length === 0) {
    return;
  }
  if (runtime.kind === "packaged") {
    throw new Error(
      [
        "Packaged Koed JS runtime artifacts are missing.",
        `Missing runtime files under ${runtime.root}: ${runtime.missing.join(", ")}.`,
        "Rebuild Koed Desktop packaging so koed-runtime contains API, Worker, Explorer, MCP Server, Supported Capture Hook, and DB migration artifacts."
      ].join(" ")
    );
  }

  void paths;
};
