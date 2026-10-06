import {
  createDesktopComponentManagerBridge,
  validateDesktopBundle,
  type DesktopBundleCapability
} from "@koed-labs/server/desktop-component-manager";
import type {
  ArtifactTarget,
  RuntimeIdentity
} from "@koed-labs/server/desktop-component-manager";
import type { KoedServerPaths } from "@koed-labs/server";

export interface DesktopDistributionManagerOptions {
  bundleRoot: string;
  manifestPath: string;
  paths: KoedServerPaths;
  runtime: RuntimeIdentity;
  target: ArtifactTarget;
  controlPlaneVersion: string;
  isRunning: () => boolean;
}

export const createDesktopDistributionManager = async (
  options: DesktopDistributionManagerOptions
) => {
  const capability: DesktopBundleCapability = await validateDesktopBundle(
    options.bundleRoot,
    options.manifestPath,
    options.target,
    options.controlPlaneVersion
  );
  const bridge = createDesktopComponentManagerBridge({
    capability,
    paths: options.paths,
    runtime: options.runtime,
    target: options.target,
    controlPlaneVersion: options.controlPlaneVersion,
    isRunning: options.isRunning()
  });
  return Object.freeze({
    owner: bridge.owner,
    bundleDigest: bridge.bundleDigest,
    status: bridge.status,
    install: bridge.install
  });
};
