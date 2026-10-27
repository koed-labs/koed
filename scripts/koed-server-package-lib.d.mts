import type {
  ArtifactTarget,
  ComponentId,
  ComponentManifest,
  RuntimeCompatibility
} from "../packages/koed-server/src/component-contract.js";

export function canonicalComponentManifestBytes(
  manifest: ComponentManifest
): Buffer;

export function buildComponentManifest(input: {
  componentRoot: string;
  archivePath: string;
  component: ComponentId;
  productVersion: string;
  target: ArtifactTarget;
  runtimes: readonly RuntimeCompatibility[];
  requiredFiles: readonly string[];
}): ComponentManifest;
