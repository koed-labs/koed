import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { localPrivacyEnv } from "./local-privacy-runtime.js";
import type { KoedServerPaths } from "./paths.js";

describe("native Privacy Filter Service runtime", () => {
  it("wires a credential-free local URL and KOED_HOME model cache", () => {
    const paths = {
      koedHome: "/koed",
      modelsDir: "/koed/models"
    } as KoedServerPaths;
    expect(
      localPrivacyEnv(paths, {
        PRIVACY_SERVICE_HOST: "127.0.0.1",
        PRIVACY_SERVICE_PORT: "48092"
      })
    ).toEqual({
      PRIVACY_SERVICE_HOST: "127.0.0.1",
      PRIVACY_SERVICE_PORT: "48092",
      PRIVACY_SERVICE_URL: "http://127.0.0.1:48092",
      PRIVACY_RUNTIME_PROVIDER: "auto",
      PRIVACY_GPU_IDLE_UNLOAD_SECONDS: "300",
      KOED_PRIVACY_TRANSFORMERS_CACHE: resolve(
        "/koed/models/privacy/transformers-cache"
      )
    });
  });

  it("inherits the product hardware preference unless the service is overridden", () => {
    const paths = {
      koedHome: "/koed",
      modelsDir: "/koed/models"
    } as KoedServerPaths;
    expect(
      localPrivacyEnv(paths, { KOED_HARDWARE_ACCELERATION: "cpu" })
        .PRIVACY_RUNTIME_PROVIDER
    ).toBe("cpu");
    expect(
      localPrivacyEnv(paths, {
        KOED_HARDWARE_ACCELERATION: "cpu",
        PRIVACY_RUNTIME_PROVIDER: "cuda"
      }).PRIVACY_RUNTIME_PROVIDER
    ).toBe("cuda");
  });
});
