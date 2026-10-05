import type {
  ArtifactTarget,
  ComponentId,
  ComponentManifest,
  RuntimeCompatibility
} from "../packages/koed-server/src/component-contract.js";
import type { KeyObject } from "node:crypto";

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

export function signComponentManifest(input: {
  manifest: ComponentManifest;
  keyId: string;
  privateKey: string | Buffer | KeyObject;
}): {
  manifestBytes: Buffer;
  signature: {
    schemaVersion: 1;
    keyId: string;
    algorithm: "ed25519";
    signature: string;
  };
};
