import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectLocalPrivacyRuntimeHealthStatus,
  localPrivacyEnv
} from "./local-privacy-runtime.js";
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

  it("collects live startup health without requiring model files", async () => {
    const paths = {
      koedHome: "/koed",
      modelsDir: "/koed/models",
      repoRoot: "/repo"
    } as KoedServerPaths;

    await expect(
      collectLocalPrivacyRuntimeHealthStatus(
        paths,
        { PRIVACY_SERVICE_PORT: "48092" },
        {
          existsSync: () => true,
          fetch: async () =>
            new Response(JSON.stringify({ status: "ok" }), {
              status: 200,
              headers: { "content-type": "application/json" }
            })
        }
      )
    ).resolves.toMatchObject({
      state: "healthy",
      details: { healthUrl: "http://127.0.0.1:48092/health" }
    });
  });
});
