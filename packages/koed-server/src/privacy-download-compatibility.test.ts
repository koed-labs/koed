import { describe, expect, it, vi } from "vitest";
import { probePrivacyDownloadCompatibility } from "./privacy-download-compatibility.js";
const linux = { platform: "linux", architecture: "x64" };
const libraries = JSON.stringify({ cudaRuntimeVersion: 12080, cudnnMajor: 9 });
const runner = (gpu = "0, 570.26, 8.6", libs = libraries) =>
  vi.fn(async (command: string) => (command === "nvidia-smi" ? gpu : libs));
describe("Privacy download compatibility", () => {
  it("preserves macOS behavior and avoids host probes", async () => {
    const run = runner();
    expect(
      await probePrivacyDownloadCompatibility({
        platform: "macos",
        architecture: "arm64",
        run
      })
    ).toMatchObject({ compatible: true, target: "macos-arm64" });
    expect(run).not.toHaveBeenCalled();
  });
  it("respects explicit CPU preference without probing", async () => {
    const run = runner();
    expect(
      await probePrivacyDownloadCompatibility({
        ...linux,
        preference: "CPU",
        run
      })
    ).toMatchObject({ variant: "cpu", reason: "explicit_cpu_preference" });
    expect(run).not.toHaveBeenCalled();
  });
  it("selects CUDA only after both bounded host probes pass", async () => {
    const run = runner();
    expect(
      await probePrivacyDownloadCompatibility({ ...linux, run })
    ).toMatchObject({
      variant: "cuda",
      compatible: true,
      gpuIndex: 0,
      cudaRuntimeVersion: 12080
    });
    expect(run.mock.calls.map(([command]) => command)).toEqual([
      "nvidia-smi",
      "python3"
    ]);
  });
  it.each([
    ["", libraries, "no_visible_gpu"],
    ["0, 569.99, 8.6", libraries, "incompatible_driver"],
    ["0, 570.26, 10.0", libraries, "unsupported_compute_capability"],
    ["0, 570.26, 8.999", libraries, "inconclusive_gpu_probe"],
    [
      "0, 570.26, 8.6",
      '{"missingLibrary":"libcudnn.so.9"}',
      "missing_library:libcudnn.so.9"
    ],
    [
      "0, 570.26, 8.6",
      '{"cudaRuntimeVersion":12060,"cudnnMajor":9}',
      "incompatible_cuda_libraries"
    ],
    [
      "0, 570.26, 8.6",
      '{"cudaRuntimeVersion":13000,"cudnnMajor":9}',
      "incompatible_cuda_libraries"
    ],
    [
      "0, 570.26, 8.6",
      '{"cudaRuntimeVersion":12080,"cudnnMajor":8}',
      "incompatible_cuda_libraries"
    ],
    ["0, 570.26, 8.6", "{}", "inconclusive_library_versions"],
    ["0, 570.26, 8.6", "invalid", "inconclusive_probe"]
  ])("selects CPU for %s / %s", async (gpu, libs, reason) => {
    expect(
      await probePrivacyDownloadCompatibility({
        ...linux,
        run: runner(gpu, libs)
      })
    ).toMatchObject({ variant: "cpu", compatible: false, reason });
  });
  it("treats unavailable tools and oversized output as inconclusive", async () => {
    expect(
      await probePrivacyDownloadCompatibility({
        ...linux,
        run: async () => {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        }
      })
    ).toMatchObject({ variant: "cpu", reason: "probe_tool_unavailable" });
    expect(
      await probePrivacyDownloadCompatibility({
        ...linux,
        run: runner("x".repeat(33000))
      })
    ).toMatchObject({ variant: "cpu", reason: "inconclusive_probe" });
  });
  it("bounds a stuck probe and propagates cancellation", async () => {
    expect(
      await probePrivacyDownloadCompatibility({
        ...linux,
        budgetMs: 5,
        run: () => new Promise(() => {})
      })
    ).toMatchObject({ variant: "cpu", reason: "probe_timeout" });
    const signal = AbortSignal.abort();
    await expect(
      probePrivacyDownloadCompatibility({ ...linux, signal, run: runner() })
    ).rejects.toThrow();
  });
  it("does not introduce an unsupported target", async () => {
    const run = runner();
    expect(
      await probePrivacyDownloadCompatibility({
        platform: "linux",
        architecture: "arm64",
        run
      })
    ).toMatchObject({ target: "unsupported" });
    expect(run).not.toHaveBeenCalled();
  });
  it("does not assume physical GPU indices match hidden or reordered CUDA devices", async () => {
    const run = runner();
    expect(
      await probePrivacyDownloadCompatibility({
        ...linux,
        environment: { CUDA_VISIBLE_DEVICES: "" },
        run
      })
    ).toMatchObject({
      variant: "cpu",
      reason: "inconclusive_device_visibility"
    });
    expect(run).not.toHaveBeenCalled();
    expect(
      await probePrivacyDownloadCompatibility({
        ...linux,
        environment: {},
        run: runner("0, 570.26, 8.6\n1, 570.26, 9.0")
      })
    ).toMatchObject({
      variant: "cpu",
      reason: "inconclusive_multiple_gpu_mapping"
    });
  });
});
