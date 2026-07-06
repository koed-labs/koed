import { resolve } from "node:path";

export type RuntimeArtifactSource =
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
