import type {
  AccelerationSnapshot,
  DesktopAccelerationApi
} from "@koed-labs/server";

export const accelerationSnapshot = (): AccelerationSnapshot => ({
  observedAt: "2026-11-09T00:00:00Z",
  revision: "a".repeat(64),
  configurationRevision: "a".repeat(64),
  runtimeEpoch: "stopped",
  preference: "auto",
  recommendedPreference: "cpu",
  effectivePolicy: "auto",
  source: "default",
  readOnlyReason: null,
  runtimeReadOnlyReason: null,
  hardware: {
    state: "available",
    backend: "cuda",
    name: "NVIDIA test device",
    memoryBytes: 8 * 1_073_741_824,
    reason: "Detected",
    verification: "host"
  },
  cuda: {
    validation: "unknown",
    state: "missing",
    selectionId: null,
    canInstall: true,
    downloadBytes: 300 * 1_048_576,
    requiredFreeBytes: 1e9,
    availableFreeBytes: 10e9,
    reason: "CUDA is an optional additional download."
  },
  model: {
    key: "qwen3-0.6b",
    label: "Qwen3 Embedding · 0.6B",
    filename: "model.gguf",
    present: false
  },
  embedding: { state: "stopped", backend: null, fallbackReason: null },
  privacy: { state: "absent", provider: null, fallbackReason: null }
});

export const accelerationApiFixture = (
  snapshot = accelerationSnapshot()
): DesktopAccelerationApi => ({
  inspect: async () => ({ snapshot, operation: null }),
  apply: async () => {
    throw new Error("This read-only fixture must not mutate processing.");
  },
  cancel: async () => ({ snapshot, operation: null })
});
