import { describe, expect, it } from "vitest";
import {
  accelerationArgs,
  parseLlamaDevices,
  resolveAcceleration
} from "./acceleration.js";

const listing = `Available devices:
  CUDA0: NVIDIA GPU (16384 MiB, 15000 MiB free)
  MTL0: Apple M-series (16384 MiB, 12000 MiB free)
  BLAS: OpenBLAS (0 MiB, 0 MiB free)`;

describe("llama-server acceleration policy", () => {
  it("parses only bounded device identifiers and backend classes", () => {
    expect(parseLlamaDevices(listing)).toEqual([
      { id: "CUDA0", backend: "cuda" },
      { id: "MTL0", backend: "metal" },
      { id: "BLAS", backend: "cpu" }
    ]);
  });

  it("selects CUDA automatically on Linux and Metal on Apple Silicon", () => {
    const devices = parseLlamaDevices(listing);
    expect(
      resolveAcceleration("auto", devices, null, {
        platform: "linux",
        arch: "x64"
      })
    ).toMatchObject({ backend: "cuda", device: "CUDA0", gpuLayers: "all" });
    expect(
      resolveAcceleration("auto", devices, null, {
        platform: "darwin",
        arch: "arm64"
      })
    ).toMatchObject({ backend: "metal", device: "MTL0", gpuLayers: "all" });
  });

  it("falls back visibly only in auto mode", () => {
    expect(
      resolveAcceleration("auto", [], null, {
        platform: "linux",
        arch: "x64"
      })
    ).toMatchObject({
      backend: "cpu",
      gpuLayers: "0",
      fallbackReason: "cuda_device_unavailable"
    });
    expect(() =>
      resolveAcceleration("cuda", [], null, {
        platform: "linux",
        arch: "x64"
      })
    ).toThrow("cuda acceleration was required");
  });

  it("honors a compatible explicit device and rejects a mismatched one", () => {
    const devices = parseLlamaDevices(listing);
    expect(resolveAcceleration("cuda", devices, "CUDA0").device).toBe("CUDA0");
    expect(() => resolveAcceleration("cuda", devices, "MTL0")).toThrow(
      'device "MTL0"'
    );
  });

  it("uses deterministic CPU or explicit full GPU offload arguments", () => {
    expect(accelerationArgs(resolveAcceleration("cpu", []))).toEqual([
      "--n-gpu-layers",
      "0"
    ]);
    expect(
      accelerationArgs(resolveAcceleration("cuda", parseLlamaDevices(listing)))
    ).toEqual(["--device", "CUDA0", "--n-gpu-layers", "all", "--fit", "off"]);
  });
});
