import { describe, expect, it } from "vitest";
import { isPrivacyInferenceVerification } from "./privacy-inference.js";
const cpu = {
  activeProvider: "cpu",
  requestedProvider: "cpu",
  executedProviders: ["CPUExecutionProvider"],
  proof: "onnx-execution-profile",
  maskingSha256: "a".repeat(64)
};
describe("Privacy execution evidence", () => {
  it("accepts CPU kernel proof and an explicit CPU-only worker", () => {
    expect(isPrivacyInferenceVerification(cpu, "cpu")).toBe(true);
    expect(
      isPrivacyInferenceVerification(
        { ...cpu, proof: "cpu-only-worker", executedProviders: [] },
        "cpu"
      )
    ).toBe(true);
  });
  it("requires executed CUDA kernels, not a requested-provider label", () => {
    const cuda = { ...cpu, requestedProvider: "cuda", activeProvider: "cuda" };
    expect(isPrivacyInferenceVerification(cuda, "cuda")).toBe(false);
    expect(
      isPrivacyInferenceVerification(
        { ...cuda, executedProviders: ["CUDAExecutionProvider"] },
        "cuda"
      )
    ).toBe(true);
    expect(
      isPrivacyInferenceVerification(
        {
          ...cuda,
          executedProviders: ["CUDAExecutionProvider"],
          proof: "cpu-only-worker"
        },
        "cuda"
      )
    ).toBe(false);
    expect(
      isPrivacyInferenceVerification(
        { ...cuda, executedProviders: ["CUDAExecutionProvider"] },
        "cpu"
      )
    ).toBe(false);
  });
  it("requires an explicit reason and CPU proof after CUDA failure", () => {
    const fallback = { ...cpu, requestedProvider: "cuda" };
    expect(isPrivacyInferenceVerification(fallback, "cuda")).toBe(false);
    expect(
      isPrivacyInferenceVerification(
        {
          ...fallback,
          fallbackReason: "cuda_initialization_or_inference_failed"
        },
        "cuda"
      )
    ).toBe(true);
    expect(
      isPrivacyInferenceVerification(
        {
          ...fallback,
          fallbackReason: "cuda_initialization_or_inference_failed",
          executedProviders: []
        },
        "cuda"
      )
    ).toBe(false);
  });
  it("rejects malformed or unrelated evidence", () => {
    for (const value of [
      null,
      [],
      {},
      { ...cpu, maskingSha256: "bad" },
      { ...cpu, executedProviders: [undefined] },
      { ...cpu, fallbackReason: "unrelated" }
    ])
      expect(isPrivacyInferenceVerification(value)).toBe(false);
  });
});
