import { describe, expect, it } from "vitest";
import { resolveConfig } from "./config.js";

const baseEnvironment = {
  KOED_PRIVACY_TRANSFORMERS_CACHE: "/models/privacy"
};

describe("Privacy Service configuration", () => {
  it("retains the standalone CPU default with five-minute idle unloading", () => {
    expect(resolveConfig(baseEnvironment)).toMatchObject({
      runtimeProvider: "cpu",
      gpuIdleUnloadSeconds: 300
    });
  });

  it("accepts an explicit provider and disabled idle unloading", () => {
    expect(
      resolveConfig({
        ...baseEnvironment,
        PRIVACY_RUNTIME_PROVIDER: "cuda",
        PRIVACY_GPU_IDLE_UNLOAD_SECONDS: "0"
      })
    ).toMatchObject({
      runtimeProvider: "cuda",
      gpuIdleUnloadSeconds: 0
    });
  });

  it("rejects malformed idle unloading values", () => {
    expect(() =>
      resolveConfig({
        ...baseEnvironment,
        PRIVACY_GPU_IDLE_UNLOAD_SECONDS: "-1"
      })
    ).toThrow("PRIVACY_GPU_IDLE_UNLOAD_SECONDS must be a non-negative integer");
  });
});
