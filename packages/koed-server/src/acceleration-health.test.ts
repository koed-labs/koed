import { describe, expect, it, vi } from "vitest";
import { inspectAccelerationServices } from "./acceleration-health.js";

const environment = {
  EMBEDDING_SERVICE_TOKEN: "private-embedding-token",
  PRIVACY_RUNTIME_CONTROL_TOKEN: "private-privacy-token"
};
const lifecycle = {
  state: "running" as const,
  epoch: "runtime-1",
  message: "Running"
};
const inspect = (
  fetcher: typeof fetch,
  extra: Partial<Parameters<typeof inspectAccelerationServices>[0]> = {}
) =>
  inspectAccelerationServices({
    environment,
    lifecycle,
    privacyInstalled: true,
    fetcher,
    ...extra
  });
const response = (body: unknown) => Response.json(body);
describe("authoritative acceleration health", () => {
  it.each(["switching", "recovering", "failed"])(
    "does not claim Privacy readiness while %s",
    async (switchState) => {
      const result = await inspect(
        vi.fn(async () =>
          response({
            component: "privacy_filter",
            activeProvider: "cuda",
            verifiedProviders: ["cuda"],
            switchState
          })
        )
      );
      expect(result.privacy).toMatchObject({
        state: "unavailable",
        provider: null
      });
    }
  );
  it.each(["running", "starting"] as const)(
    "reports authenticated service readiness independently of a %s supervisor",
    async (state) => {
      const fetcher = vi.fn(async (url: URL | RequestInfo) =>
        String(url).includes("/health")
          ? response({
              status: "ok",
              authRequired: true,
              authValid: true,
              acceleration: "metal;runtime=llama.cpp;n-gpu-layers=all",
              artifact: "private/path"
            })
          : response({
              component: "privacy_filter",
              switchState: "ready",
              activeProvider: "coreml",
              verifiedProviders: ["cpu", "coreml"],
              lastFailure: "private/log"
            })
      );
      const result = await inspect(fetcher, {
        lifecycle: { ...lifecycle, state }
      });
      expect(result.embedding).toEqual({
        state: "ready",
        backend: "metal",
        fallbackReason: null
      });
      expect(result.privacy).toEqual({
        state: "ready",
        provider: "coreml",
        fallbackReason: null
      });
      expect(JSON.stringify(result)).not.toContain("private");
    }
  );
  it.each([
    { status: "loading", authValid: true },
    { status: "ok", authValid: false }
  ])(
    "does not claim an active backend during unverified startup: %j",
    async (health) => {
      const result = await inspect(
        vi.fn(async () =>
          response({
            ...health,
            authRequired: true,
            acceleration: "metal;runtime=llama.cpp;n-gpu-layers=all"
          })
        ),
        {
          lifecycle: { ...lifecycle, state: "starting" },
          privacyInstalled: false
        }
      );
      expect(result.embedding).toEqual({
        state: "starting",
        backend: null,
        fallbackReason: null
      });
    }
  );
  it("rejects unauthenticated embedding readiness and unverified Privacy providers", async () => {
    const result = await inspect(
      vi.fn(async () =>
        response({
          status: "ok",
          authRequired: true,
          authValid: false,
          acceleration: "cuda;runtime=llama.cpp;n-gpu-layers=99",
          activeProvider: "cuda"
        })
      )
    );
    expect(result.embedding.backend).toBeNull();
    expect(result.privacy.provider).toBeNull();
  });
  it("reports verified CPU fallback separately from GPU preference", async () => {
    const result = await inspect(
      vi.fn(async () =>
        response({
          status: "ok",
          authRequired: true,
          authValid: true,
          acceleration: "cpu;runtime=llama.cpp;n-gpu-layers=0",
          accelerationFallback: {
            policy: "auto",
            reason: "cuda_initialization_failed"
          }
        })
      ),
      { privacyInstalled: false }
    );
    expect(result.embedding).toMatchObject({
      backend: "cpu",
      fallbackReason: "cuda_initialization_failed"
    });
    expect(result.privacy.state).toBe("absent");
  });
  it.each(["stopped", "unavailable"] as const)(
    "does not query a %s local runtime or infer live execution",
    async (state) => {
      const fetcher = vi.fn();
      const result = await inspect(fetcher, {
        lifecycle: { ...lifecycle, state },
        privacyInstalled: false
      });
      expect(fetcher).not.toHaveBeenCalled();
      expect(result.embedding.state).toBe(state);
      expect(result.embedding.backend).toBeNull();
    }
  );
  it("does not send missing credentials or follow redirects", async () => {
    const fetcher = vi.fn(async () => response({}));
    await inspect(fetcher, { environment: {} });
    expect(fetcher).not.toHaveBeenCalled();
    await inspect(fetcher);
    expect(fetcher).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        redirect: "error",
        headers: {
          "x-koed-embedding-token": environment.EMBEDDING_SERVICE_TOKEN
        }
      })
    );
  });
  it("keeps invalid external URLs and malformed health unavailable", async () => {
    const fetcher = vi.fn(async () =>
      response({
        status: "ok",
        authRequired: true,
        authValid: true,
        acceleration: "configured-cuda"
      })
    );
    expect(
      (await inspect(fetcher, { externalEmbeddingUrl: "not a url" })).embedding
        .state
    ).toBe("unavailable");
    expect((await inspect(fetcher)).embedding.backend).toBeNull();
  });
});
