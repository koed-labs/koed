export type ComponentId = "base" | "privacy";
export type ProcessId =
  | "api"
  | "worker"
  | "local-ai-runtime"
  | "postgres"
  | "embedding-service"
  | "privacy-service";
export interface ArtifactTarget {
  platform: "macos" | "linux";
  architecture: "arm64" | "x64";
  libc?: { family: "glibc"; minimumVersion: string };
}
export interface RuntimeIdentity {
  kind: "node" | "electron";
  version: string;
  nodeVersion: string;
  modulesAbi: string;
  napiVersion: number;
  platform: ArtifactTarget["platform"];
  architecture: ArtifactTarget["architecture"];
  libcVersion?: string;
}
export interface RuntimeCompatibility {
  kind: RuntimeIdentity["kind"];
  runtimeRange: string;
  nodeRange: string;
  modulesAbi?: string;
  minimumNapi?: number;
}
export interface ComponentManifest {
  schemaVersion: 1;
  productVersion: string;
  component: ComponentId;
  target: ArtifactTarget;
  runtimes: readonly RuntimeCompatibility[];
  archive: { name: string; bytes: number; sha256: string };
  requiredFiles: readonly string[];
  files: readonly { path: string; sha256: string }[];
}
export interface ComponentSignature {
  schemaVersion: 1;
  keyId: string;
  algorithm: "ed25519";
  signature: string;
}
export interface RuntimeRequirements {
  components: readonly ComponentId[];
  processes: readonly ProcessId[];
  queue: "local" | "bullmq";
  native: readonly ("postgres" | "llama-server")[];
  models: readonly ("embedding" | "privacy")[];
}
export interface RuntimeOwner {
  kind: "cli" | "desktop" | "standalone";
  installationId: string;
}
export interface VerifiedComponent {
  manifest: ComponentManifest;
  root: string;
  manifestDigest: string;
}
export interface VerifiedGeneration {
  id: string;
  productVersion: string;
  base: VerifiedComponent;
  privacy?: VerifiedComponent;
  owner: RuntimeOwner;
}
