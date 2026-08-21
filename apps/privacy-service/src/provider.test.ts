import { describe, expect, it } from "vitest";
import {
  observeCudaAccelerator,
  parsePrivacyRuntimePreference,
  platformPrivacyProviderCandidates
} from "./provider.js";

describe("Privacy Filter runtime providers", () => {
  it("defaults to CPU and validates explicit preferences", () => {
    expect(parsePrivacyRuntimePreference(undefined)).toBe("cpu");
    expect(parsePrivacyRuntimePreference(" AUTO ")).toBe("auto");
    expect(parsePrivacyRuntimePreference("coreml")).toBe("coreml");
    expect(() => parsePrivacyRuntimePreference("metal")).toThrow(
      /must be one of/u
    );
  });

  it("keeps platform candidates distinct from verified availability", () => {
    expect(platformPrivacyProviderCandidates("linux", "x64")).toEqual([
      "cuda",
      "cpu"
    ]);
    expect(platformPrivacyProviderCandidates("darwin", "arm64")).toEqual([
      "coreml",
      "cpu"
    ]);
    expect(platformPrivacyProviderCandidates("win32", "x64")).toEqual([
      "dml",
      "cpu"
    ]);
    expect(platformPrivacyProviderCandidates("linux", "arm64")).toEqual([
      "cpu"
    ]);
  });

  it("reports bounded CUDA capacity and contention observations", async () => {
    const normal = await observeCudaAccelerator(
      async () => ({ stdout: "16384, 2048, 14336, 25\n" }),
      () => new Date("2026-08-13T00:00:00.000Z")
    );
    expect(normal).toEqual({
      provider: "cuda",
      observedAt: "2026-08-13T00:00:00.000Z",
      capacityAvailable: true,
      totalMemoryMiB: 16384,
      usedMemoryMiB: 2048,
      freeMemoryMiB: 14336,
      utilizationPercent: 25,
      pressure: "normal",
      contentionLikely: false
    });

    const busy = await observeCudaAccelerator(async () => ({
      stdout: "16384, 14500, 1884, 92\n"
    }));
    expect(busy).toMatchObject({
      capacityAvailable: true,
      pressure: "elevated",
      contentionLikely: true
    });

    const exhausted = await observeCudaAccelerator(async () => ({
      stdout: "16384, 16000, 384, 40\n"
    }));
    expect(exhausted).toMatchObject({
      capacityAvailable: false,
      pressure: "critical"
    });
  });

  it("fails closed when accelerator observation is unavailable", async () => {
    const observation = await observeCudaAccelerator(async () => {
      const error = new Error("missing") as Error & { code: string };
      error.code = "ENOENT";
      throw error;
    });
    expect(observation).toMatchObject({
      capacityAvailable: false,
      pressure: "unknown",
      unavailableReason: "tool_unavailable"
    });
  });
});
