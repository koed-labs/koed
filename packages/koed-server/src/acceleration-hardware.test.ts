import { describe, expect, it, vi } from "vitest";
import {
  inspectAccelerationHardware,
  parseNvidiaDevices,
  visibleNvidiaDevices
} from "./acceleration-hardware.js";
import type { nativeCommand } from "./native-validation-process.js";

const devices =
  "0, GPU-aaaaaaaa-1111, NVIDIA Test One, 8192, 8.6\n1, GPU-bbbbbbbb-2222, NVIDIA Test Two, 16384, 8.9";
const fixture = () => ({
  platform: "linux" as const,
  arch: "x64",
  libc: "2.35",
  exists: vi.fn(() => true),
  command: vi.fn<typeof nativeCommand>(async () => devices),
  checkCuda: vi.fn(async () => "550.54.14")
});
describe("hardware capability inspection", () => {
  it("reports Metal capability without claiming that the model has run", async () => {
    const f = fixture();
    expect(
      await inspectAccelerationHardware(
        {},
        { ...f, platform: "darwin", arch: "arm64" }
      )
    ).toMatchObject({ backend: "metal", verification: "host" });
    expect(f.command).not.toHaveBeenCalled();
  });
  it.each(["", "-1"])(
    "honors hidden devices (%s) before invoking probes",
    async (mask) => {
      const f = fixture();
      const value = await inspectAccelerationHardware(
        { CUDA_VISIBLE_DEVICES: mask },
        f
      );
      expect(value.state).toBe("unavailable");
      expect(f.command).not.toHaveBeenCalled();
    }
  );
  it("resolves UUID masks and does not confuse nvidia-smi with CUDA ordinal ordering", async () => {
    expect(visibleNvidiaDevices(parseNvidiaDevices(devices), "0")).toBeNull();
    expect(
      visibleNvidiaDevices(parseNvidiaDevices(devices), "GPU-bbbb")?.[0]?.name
    ).toBe("NVIDIA Test Two");
    const f = fixture();
    const value = await inspectAccelerationHardware(
      { CUDA_VISIBLE_DEVICES: "GPU-bbbb" },
      f
    );
    expect(value).toMatchObject({
      state: "available",
      backend: "cuda",
      name: "NVIDIA Test Two",
      memoryBytes: 16384 * 1_048_576,
      verification: "host"
    });
    expect(f.checkCuda).toHaveBeenCalledOnce();
    expect(f.command.mock.calls[0]?.[2].signal).toBeInstanceOf(AbortSignal);
  });
  it.each(["cuda_driver_too_old", "cuda_driver_library_unavailable"])(
    "reports %s without raw probe output",
    async (reason) => {
      const f = fixture();
      f.checkCuda.mockRejectedValueOnce(
        Object.assign(new Error("raw secret output"), { reason })
      );
      const value = await inspectAccelerationHardware({}, f);
      expect(value.state).toBe("unavailable");
      expect(value.reason).not.toContain("secret");
      expect(value.reason).toContain(
        reason === "cuda_driver_too_old" ? "update" : "library"
      );
    }
  );
  it("keeps missing tools, unsupported libc and failed discovery distinct", async () => {
    const f = fixture();
    expect(
      (await inspectAccelerationHardware({}, { ...f, libc: "2.34" })).state
    ).toBe("unsupported");
    expect(
      (await inspectAccelerationHardware({}, { ...f, exists: () => false }))
        .reason
    ).toContain("tools");
    f.command.mockResolvedValueOnce("malformed");
    expect((await inspectAccelerationHardware({}, f)).state).toBe("unknown");
  });
  it("respects the architectures admitted by this release rather than assuming every CUDA device is supported", async () => {
    const f = fixture();
    expect(
      (await inspectAccelerationHardware({}, { ...f, architectures: [75] }))
        .state
    ).toBe("unsupported");
    expect(f.checkCuda).not.toHaveBeenCalled();
  });
});
