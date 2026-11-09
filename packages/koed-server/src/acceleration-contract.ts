// Renderer-safe observations. Package presence, host capability and live execution
// are intentionally independent: none of them implies the other two.
export type AccelerationPreference = "auto" | "cpu";
export type EmbeddingBackend = "cpu" | "cuda" | "metal";

export interface AccelerationHardware {
  state: "available" | "unavailable" | "unsupported" | "unknown";
  backend: "cuda" | "metal" | null;
  name: string;
  memoryBytes: number | null;
  reason: string;
  verification: "host" | "none";
}

export interface AccelerationCudaPackage {
  validation: "unknown" | "device-only" | "inference";
  state:
    | "not-applicable"
    | "missing"
    | "installed"
    | "outdated"
    | "incompatible"
    | "unavailable";
  selectionId: string | null;
  canInstall: boolean;
  downloadBytes: number | null;
  requiredFreeBytes: number | null;
  availableFreeBytes: number | null;
  reason: string;
}

export interface AccelerationSnapshot {
  observedAt: string;
  // Changes when configuration, authority or selected assets change. A restored
  // renderer draft is never sufficient authority to overwrite a newer revision.
  revision: string;
  configurationRevision: string;
  runtimeEpoch: string;
  preference: AccelerationPreference;
  recommendedPreference: AccelerationPreference;
  effectivePolicy: string;
  source: "default" | "saved" | "environment" | "external";
  readOnlyReason: string | null;
  hardware: AccelerationHardware;
  cuda: AccelerationCudaPackage;
  model: { key: string; label: string; filename: string; present: boolean };
  embedding: {
    state: "stopped" | "starting" | "ready" | "unavailable";
    backend: EmbeddingBackend | null;
    fallbackReason: string | null;
  };
  privacy: {
    state: "absent" | "stopped" | "ready" | "unavailable";
    provider: string | null;
    fallbackReason: string | null;
  };
}

export interface AccelerationChoice {
  preference: AccelerationPreference;
  installCuda: boolean;
  expectedRevision: string;
}

export interface AccelerationOperation {
  id: string;
  sequence: number;
  state: "running" | "complete" | "failed" | "cancelled" | "interrupted";
  phase:
    | "checking"
    | "stopping"
    | "downloading"
    | "verifying"
    | "inference"
    | "activating"
    | "saving"
    | "starting"
    | "ready";
  cancellable: boolean;
  completedBytes: number | null;
  totalBytes: number | null;
  message: string;
}

export interface DesktopAccelerationState {
  snapshot: AccelerationSnapshot | null;
  operation: AccelerationOperation | null;
}

export interface DesktopAccelerationApi {
  inspect: (refresh?: boolean) => Promise<DesktopAccelerationState>;
  apply: (choice: AccelerationChoice) => Promise<DesktopAccelerationState>;
  cancel: (operationId: string) => Promise<DesktopAccelerationState>;
}

export interface AccelerationInstallProgress {
  phase: "checking" | "downloading" | "verifying" | "inference" | "activating";
  completedBytes: number | null;
  totalBytes: number | null;
  message: string;
}
export interface AccelerationInstallResult {
  snapshot: AccelerationSnapshot;
  validation: "unknown" | "device-only" | "inference";
  changed: boolean;
}
