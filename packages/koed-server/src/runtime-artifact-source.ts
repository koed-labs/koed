import { lstatSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";
import type { KoedServerPaths } from "./paths.js";

export type RuntimeArtifactSource =
  | "verified-generation"
  | "explicit-override"
  | "koed-home-runtime"
  | "packaged-resource"
  | "source-checkout";

const runtimeProcess = process as NodeJS.Process & { resourcesPath?: string };

export const trimRuntimeValue = (
  value: string | undefined
): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

export const isPackagedRuntimeMode = (
  environment: NodeJS.ProcessEnv = process.env
): boolean => environment.KOED_PACKAGED_DESKTOP === "1";

export const allowsPackagedSourceFallback = (
  environment: NodeJS.ProcessEnv = process.env
): boolean => environment.KOED_ALLOW_PACKAGED_SOURCE_FALLBACK === "1";

export const canUseSourceCheckoutFallback = (
  environment: NodeJS.ProcessEnv = process.env
): boolean =>
  !isPackagedRuntimeMode(environment) ||
  allowsPackagedSourceFallback(environment);

export const resolvePackagedResourcesPath = (
  environment: NodeJS.ProcessEnv = process.env
): string | undefined => {
  const explicit = trimRuntimeValue(environment.KOED_PACKAGED_RESOURCES_PATH);
  if (explicit) {
    return resolve(explicit);
  }
  return runtimeProcess.resourcesPath
    ? resolve(runtimeProcess.resourcesPath)
    : undefined;
};

export const resolvePackagedKoedRuntimeRoot = (
  environment: NodeJS.ProcessEnv = process.env
): string | undefined => {
  const resourcesPath = resolvePackagedResourcesPath(environment);
  return resourcesPath ? resolve(resourcesPath, "koed-runtime") : undefined;
};

// The native store exists before final activation. A source supervisor that sees
// it checks the selection under the same exclusion as a packaged start.
export function hasReleaseRuntime(paths: KoedServerPaths): boolean {
  const runtime = resolve(paths.koedHome, "runtime");
  if (lstatSync(resolve(runtime, "native"), { throwIfNoEntry: false }))
    return true;
  return ["postgres", "llama.cpp"].some((name) => {
    const path = resolve(runtime, name);
    return (
      lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() &&
      readlinkSync(path) === `native/current/${name}`
    );
  });
}

export function assertNoReleaseRuntime(paths: KoedServerPaths): void {
  if (hasReleaseRuntime(paths))
    throw new Error(
      "The release provider owns this runtime. Use koed runtime install --provider release --dependency-mode bundled-local or a fresh KOED_HOME."
    );
}
