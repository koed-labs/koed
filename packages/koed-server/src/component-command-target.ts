import type { ArtifactTarget, RuntimeIdentity } from "./component-contract.js";
import {
  validateManifestCatalog,
  type ManifestPinCatalog
} from "./component-manifest-catalog.js";

export function resolveComponentCommandTarget(
  runtime: RuntimeIdentity,
  catalog: ManifestPinCatalog | null
): ArtifactTarget {
  const host = {
    platform: runtime.platform,
    architecture: runtime.architecture
  };
  if (catalog === null) return host;
  const targets = new Map<string, ArtifactTarget>();
  for (const { target } of validateManifestCatalog(catalog).entries) {
    if (
      target.platform === host.platform &&
      target.architecture === host.architecture
    )
      targets.set(JSON.stringify(target), target);
  }
  if (targets.size === 0)
    throw new Error("Component pin catalog has no target for actual runtime.");
  if (targets.size !== 1)
    throw new Error(
      "Component pin catalog has ambiguous targets for actual runtime."
    );
  // Artifact baseline comes from trusted catalog. Actual host libc is checked
  // independently during compatibility verification, never used as pin identity.
  return [...targets.values()][0]!;
}
