// Validation entry only. These devices and bytes never enter the app bundle.
import type {
  AccelerationChoice,
  DesktopAccelerationApi,
  DesktopAccelerationState
} from "@koed-labs/server";
import { accelerationSnapshot } from "./renderer/v1/acceleration.fixture.js";

export function createAccelerationValidation(
  query: URLSearchParams,
  onCancel: () => void
) {
  const device = query.get("device") ?? "cpu";
  const snapshot = accelerationSnapshot();
  snapshot.hardware.name = "NVIDIA GeForce RTX 3070";
  if (device === "metal") {
    snapshot.hardware = {
      state: "available",
      backend: "metal",
      name: "Apple Silicon",
      memoryBytes: null,
      reason: "Metal is available on this Mac.",
      verification: "host"
    };
    snapshot.recommendedPreference = "auto";
    snapshot.cuda.state = "not-applicable";
  } else if (["cpu", "unknown", "driver"].includes(device)) {
    snapshot.hardware = {
      state:
        device === "unknown"
          ? "unknown"
          : device === "driver"
            ? "unavailable"
            : "unsupported",
      backend: null,
      name: "CPU processing",
      memoryBytes: null,
      reason:
        device === "unknown"
          ? "Hardware detection could not finish. Check again, or continue with CPU."
          : device === "driver"
            ? "The NVIDIA driver needs an update before CUDA can be enabled."
            : "CPU processing is ready to use.",
      verification: "none"
    };
  } else if (device === "cuda-installed") {
    snapshot.cuda.state = "installed";
    snapshot.cuda.downloadBytes = 0;
    snapshot.source = "saved";
    snapshot.recommendedPreference = "auto";
  } else if (device === "managed" || device === "external") {
    snapshot.source = device === "managed" ? "environment" : "external";
    snapshot.readOnlyReason =
      device === "managed"
        ? "The Operator environment controls local acceleration."
        : "The Operator manages the external Embedding Service.";
    if (device === "external")
      snapshot.runtimeReadOnlyReason = snapshot.readOnlyReason;
    if (device === "external")
      snapshot.model.label = "Operator-managed embedding model";
  }
  const state: DesktopAccelerationState = { snapshot, operation: null };
  const calls: AccelerationChoice[] = [];
  let sequence = 0;
  let choice: AccelerationChoice | undefined;
  let checking = device === "checking";
  const pending: Array<() => void> = [];
  const clone = () => structuredClone(state);
  const api: DesktopAccelerationApi = {
    inspect: async () => {
      if (checking) await new Promise<void>((resolve) => pending.push(resolve));
      return clone();
    },
    apply: async (input) => {
      calls.push(input);
      snapshot.preference = input.preference;
      snapshot.effectivePolicy = input.preference;
      snapshot.source = "saved";
      snapshot.revision = (++sequence).toString(16).padStart(64, "0");
      return clone();
    },
    cancel: async (id) => {
      if (state.operation?.id === id && state.operation.cancellable) {
        state.operation = {
          ...state.operation,
          sequence: state.operation.sequence + 1,
          state: "cancelled",
          cancellable: false,
          message: "CUDA setup cancelled."
        };
        onCancel();
      }
      return clone();
    }
  };
  return {
    api,
    calls,
    run(input?: AccelerationChoice) {
      choice = input;
    },
    state: clone,
    finishDetection() {
      checking = false;
      for (const resolve of pending.splice(0)) resolve();
    },
    progress(phase: "downloading" | "inference" | "activating", fraction = 0) {
      state.operation = {
        id: "d6abf730-0f02-4adc-a7e6-4ddf98f30905",
        sequence: (state.operation?.sequence ?? 0) + 1,
        state: "running",
        phase,
        cancellable: phase !== "activating",
        completedBytes:
          phase === "downloading" ? fraction * 300 * 1_048_576 : null,
        totalBytes: phase === "downloading" ? 300 * 1_048_576 : null,
        message:
          phase === "downloading"
            ? "Downloading the reviewed CUDA runtime…"
            : phase === "inference"
              ? "Checking GPU offload and CPU/GPU embedding agreement…"
              : "Activating the verified runtime…"
      };
    },
    fail() {
      if (state.operation?.state === "running")
        state.operation = {
          ...state.operation,
          sequence: state.operation.sequence + 1,
          state: "failed",
          cancellable: false,
          message: "CUDA inference verification failed."
        };
    },
    complete() {
      if (choice) {
        snapshot.preference = choice.preference;
        snapshot.effectivePolicy = choice.preference;
      }
      if (choice?.installCuda) {
        snapshot.cuda.state = "installed";
        snapshot.cuda.validation = "inference";
      }
      snapshot.model.present = true;
      snapshot.embedding = {
        state: "ready",
        backend:
          snapshot.preference === "cpu" || query.get("backend") === "cpu"
            ? "cpu"
            : (snapshot.hardware.backend ?? "cpu"),
        fallbackReason:
          query.get("backend") === "cpu" ? "gpu_unavailable" : null
      };
      if (state.operation)
        state.operation = {
          ...state.operation,
          sequence: state.operation.sequence + 1,
          state: "complete",
          phase: "ready",
          cancellable: false,
          message: "Runtime verified."
        };
    }
  };
}
