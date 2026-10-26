import { describe, expect, it, vi } from "vitest";
import {
  PRIVACY_CLASSIFICATION_CONTRACT_VERSION,
  createPrivacyServiceClient,
  PrivacyServiceUnavailableError
} from "@koed/shared";
import type { PrivacyServiceConfig } from "./config.js";
import {
  DeterministicPrivacyRuntime,
  type PrivacyRuntimeAdapter,
  type RawPrivacyClassification
} from "./runtime.js";
import {
  createNodeHttpServer,
  createPrivacyService,
  listenNodeHttpServer
} from "./server.js";
import { ZERO_VITERBI_BIASES } from "./decoder.js";
import { request as httpRequest } from "node:http";

const config = (
  overrides: Partial<PrivacyServiceConfig> = {}
): PrivacyServiceConfig => ({
  host: "127.0.0.1",
  port: 8092,
  token: "internal-secret",
  controlToken: "control-secret",
  modelId: "openai/privacy-filter",
  modelRevision: "pinned-test-revision",
  transformersCache: "/verified/privacy-cache",
  maxFields: 2,
  maxFieldBytes: 100,
  maxRequestFieldBytes: 150,
  maxBodyBytes: 1024,
  runtimeProvider: "cpu",
  gpuIdleUnloadSeconds: 300,
  ...overrides
});

const classifyRequest = (
  body: string,
  headers: Record<string, string> = {}
): Request =>
  new Request("http://127.0.0.1/v1/classify", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body
  });

const json = async (response: Response) =>
  (await response.json()) as Record<string, unknown>;

const contractBody = (fields: Array<{ path: string; text: string }>): string =>
  JSON.stringify({
    schemaVersion: 1,
    inputContractVersion: PRIVACY_CLASSIFICATION_CONTRACT_VERSION,
    fields
  });

describe("Privacy Service routes", () => {
  it.each(["missing", "duplicate"])(
    "fails the whole response closed for %s batch field mapping",
    async (mode) => {
      const native = new DeterministicPrivacyRuntime();
      const runtime = Object.assign(native, {
        supportsBatch: true,
        classifyFields: async (
          texts: readonly string[],
          onField: (index: number, raw: RawPrivacyClassification) => void
        ) => {
          onField(0, await native.classify(texts[0]!));
          if (mode === "duplicate")
            onField(0, await native.classify(texts[0]!));
        }
      });
      const response = await createPrivacyService(config(), runtime).handle(
        classifyRequest(
          contractBody([
            { path: "/first", text: "Synthetic A" },
            { path: "/second", text: "Synthetic B" }
          ]),
          { "x-koed-privacy-token": "internal-secret" }
        )
      );
      expect(response.status).toBe(503);
      expect(await response.json()).not.toHaveProperty("fields");
    }
  );
  it("reserves both profile slots before reading an HTTP body and rejects a third header-only request", async () => {
    const runtime = Object.assign(new DeterministicPrivacyRuntime(), {
      maximumConcurrentRequests: 2 as const,
      maximumConcurrentFields: 2 as const
    });
    const service = createPrivacyService(config(), runtime);
    const headers = {
      "content-type": "application/json",
      "x-koed-privacy-token": "internal-secret"
    };
    const headerRequest = () =>
      new Request("http://privacy/v1/classify", { method: "POST", headers });
    const first = service.reserve!(headerRequest())!;
    const second = service.reserve!(headerRequest())!;
    const server = createNodeHttpServer(service, config().maxBodyBytes);
    await listenNodeHttpServer(server, "127.0.0.1", 0);
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("missing listener");
    try {
      const result = await new Promise<{
        status: number | undefined;
        retry: string | undefined;
      }>((resolve, reject) => {
        const request = httpRequest(
          {
            host: "127.0.0.1",
            port: address.port,
            path: "/v1/classify",
            method: "POST",
            headers: { ...headers, "content-length": "100" }
          },
          (response) => {
            response.resume();
            response.once("end", () => {
              resolve({
                status: response.statusCode,
                retry: response.headers["retry-after"]
              });
              request.destroy();
            });
          }
        );
        request.on("error", reject);
        request.flushHeaders(); // Deliberately send no body: rejection must not wait for it.
      });
      expect(result).toEqual({ status: 503, retry: "1" });
      first.release();
      first.release();
      const accepted = await service.handle(
        classifyRequest(
          contractBody([{ path: "/same", text: "Synthetic" }]),
          headers
        )
      );
      expect(accepted.status).toBe(200);
    } finally {
      first.release();
      second.release();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("propagates a real HTTP disconnect to inference cancellation", async () => {
    const runtime: PrivacyRuntimeAdapter = new DeterministicPrivacyRuntime();
    const original = runtime.classify.bind(runtime);
    let started!: () => void;
    let cancelled!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const observed = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    runtime.classify = async (text, signal, onProgress) => {
      if (text === "hold") {
        onProgress?.();
        started();
        await new Promise<void>((resolve) =>
          signal!.addEventListener(
            "abort",
            () => {
              cancelled();
              resolve();
            },
            { once: true }
          )
        );
        signal!.throwIfAborted();
      }
      return original(text);
    };
    const server = createNodeHttpServer(
      createPrivacyService(config(), runtime),
      1024
    );
    await listenNodeHttpServer(server, "127.0.0.1", 0);
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("test server has no port");
    try {
      const cancellation = new AbortController();
      const post = (text: string, signal?: AbortSignal) =>
        fetch(`http://127.0.0.1:${address.port}/v1/classify`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-koed-privacy-token": "internal-secret"
          },
          body: contractBody([{ path: "text", text }]),
          signal
        });
      const pending = post("hold", cancellation.signal).catch(() => null);
      await entered;
      cancellation.abort();
      await pending;
      await observed;
      // The service retains its slot until the cancelled inference settles.
      await vi.waitFor(async () =>
        expect((await post("next")).status).toBe(200)
      );
      const client = createPrivacyServiceClient({
        baseUrl: `http://127.0.0.1:${address.port}`,
        token: "internal-secret"
      });
      await expect(
        client.classify([{ path: "text", text: "next" }])
      ).resolves.toMatchObject({
        fields: [{ path: "text", inputByteLength: 4 }]
      });
      const fetchImpl = vi.fn(fetch);
      const timedClient = createPrivacyServiceClient({
        baseUrl: `http://127.0.0.1:${address.port}`,
        token: "internal-secret",
        timeoutMs: 100,
        fetchImpl
      });
      await expect(
        timedClient.classify([{ path: "text", text: "hold" }])
      ).rejects.toBeInstanceOf(PrivacyServiceUnavailableError);
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
  it("rejects concurrent inference without queueing and keeps authentication required", async () => {
    const runtime = new DeterministicPrivacyRuntime();
    const original = runtime.classify.bind(runtime);
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    runtime.classify = vi.fn(async (text: string) => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return original(text);
    });
    const service = createPrivacyService(config(), runtime);
    const request = () =>
      classifyRequest(contractBody([{ path: "text", text: "hello" }]), {
        "x-koed-privacy-token": "internal-secret"
      });
    const first = service.handle(request());
    await entered;
    expect(
      (await service.handle(classifyRequest(contractBody([])))).status
    ).toBe(401);
    const busy = await service.handle(request());
    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).toBe("1");
    expect(runtime.classify).toHaveBeenCalledTimes(1);
    release();
    expect((await first).status).toBe(200);
  });

  it("discards a cancelled request without classifying its remaining fields", async () => {
    const runtime: PrivacyRuntimeAdapter = new DeterministicPrivacyRuntime();
    const original = runtime.classify.bind(runtime);
    const cancellation = new AbortController();
    runtime.classify = vi.fn(async (text: string, signal?: AbortSignal) => {
      expect(signal?.aborted).toBe(false);
      cancellation.abort();
      return original(text);
    });
    const service = createPrivacyService(config(), runtime);
    const request = new Request(
      classifyRequest(
        contractBody([
          { path: "first", text: "hello" },
          { path: "second", text: "world" }
        ]),
        { "x-koed-privacy-token": "internal-secret" }
      ),
      { signal: cancellation.signal }
    );
    const response = await service.handle(request);
    expect(response.status).toBe(499);
    expect(runtime.classify).toHaveBeenCalledTimes(1);
    runtime.classify = original;
    const next = await service.handle(
      classifyRequest(contractBody([{ path: "next", text: "next" }]), {
        "x-koed-privacy-token": "internal-secret"
      })
    );
    expect(next.status).toBe(200);
  });
  it("exposes the authenticated versioned capacity contract", async () => {
    const service = createPrivacyService(
      config(),
      new DeterministicPrivacyRuntime()
    );
    const unauthenticated = await service.handle(
      new Request("http://127.0.0.1/v1/capabilities")
    );
    expect(unauthenticated.status).toBe(401);
    const response = await service.handle(
      new Request("http://127.0.0.1/v1/capabilities", {
        headers: { "x-koed-privacy-token": "internal-secret" }
      })
    );
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      schemaVersion: 1,
      inputContractVersion: PRIVACY_CLASSIFICATION_CONTRACT_VERSION,
      tokenizerNormalization: "none",
      maximumFieldsPerRequest: 128,
      maximumFieldBytes: 262_144,
      maximumRequestFieldBytes: 1_048_576,
      maximumRequestBodyBytes: 2_097_152,
      windowCoreTokens: 256,
      windowContextTokens: 128,
      windowMaximumTokens: 512,
      maximumFieldTokens: 262_144,
      maximumSemanticPreviewFields: 65_536,
      maximumSemanticPreviewBytes: 67_108_864,
      maximumSemanticPreviewEncodedBytes: 83_886_080,
      maximumConcurrentRequests: 1
    });
  });

  it("exposes content-free readiness and fixed labels", async () => {
    const service = createPrivacyService(
      config(),
      new DeterministicPrivacyRuntime()
    );
    const response = await service.handle(
      new Request("http://127.0.0.1/health", {
        headers: { "x-request-id": "health-1" }
      })
    );
    const payload = await json(response);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("health-1");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(payload.status).toBe("ok");
    expect(payload.labels).toHaveLength(8);
    expect(payload.runtime).toEqual({
      component: "privacy_filter",
      activeProvider: "cpu"
    });
  });

  it("keeps provider diagnostics and switching behind internal authentication", async () => {
    const deterministic = new DeterministicPrivacyRuntime();
    let requestedProvider: "cpu" | "cuda" = "cpu";
    const runtime = Object.assign(deterministic, {
      status: () => ({
        component: "privacy_filter" as const,
        requestedProvider,
        activeProvider: requestedProvider,
        candidateProviders: ["cuda", "cpu"] as const,
        verifiedProviders: ["cpu"] as const,
        switchState: "ready" as const,
        drainingProviders: [],
        calibrations: []
      }),
      switchProvider: async (provider: "cpu" | "cuda") => {
        requestedProvider = provider;
        return runtime.status();
      },
      refreshAcceleratorObservation: async () => runtime.status()
    });
    const service = createPrivacyService(config(), runtime);
    const unauthenticated = await service.handle(
      new Request("http://127.0.0.1/v1/runtime/status")
    );
    expect(unauthenticated.status).toBe(401);
    const classificationCredential = await service.handle(
      new Request("http://127.0.0.1/v1/runtime/status", {
        headers: { "x-koed-privacy-token": "internal-secret" }
      })
    );
    expect(classificationCredential.status).toBe(401);

    const status = await service.handle(
      new Request("http://127.0.0.1/v1/runtime/status", {
        headers: { "x-koed-privacy-token": "control-secret" }
      })
    );
    expect(status.status).toBe(200);
    expect(await json(status)).toMatchObject({
      component: "privacy_filter",
      activeProvider: "cpu"
    });

    const switched = await service.handle(
      new Request("http://127.0.0.1/v1/runtime/provider", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-koed-privacy-token": "control-secret"
        },
        body: JSON.stringify({ provider: "cuda" })
      })
    );
    expect(switched.status).toBe(200);
    expect(await json(switched)).toMatchObject({ activeProvider: "cuda" });

    const controlCredentialCannotClassify = await service.handle(
      classifyRequest(contractBody([{ path: "x", text: "x" }]), {
        "x-koed-privacy-token": "control-secret"
      })
    );
    expect(controlCredentialCannotClassify.status).toBe(401);

    const health = await service.handle(new Request("http://127.0.0.1/health"));
    expect(await json(health)).toMatchObject({
      runtime: {
        component: "privacy_filter",
        requestedProvider: "cuda",
        activeProvider: "cuda"
      }
    });
  });

  it("validates provider control without accepting extra fields", async () => {
    const deterministic = new DeterministicPrivacyRuntime();
    const runtime = Object.assign(deterministic, {
      status: () => ({
        component: "privacy_filter" as const,
        requestedProvider: "cpu" as const,
        activeProvider: "cpu" as const,
        candidateProviders: ["cpu"] as const,
        verifiedProviders: ["cpu"] as const,
        switchState: "ready" as const,
        drainingProviders: [],
        calibrations: []
      }),
      switchProvider: async () => runtime.status(),
      refreshAcceleratorObservation: async () => runtime.status()
    });
    const response = await createPrivacyService(config(), runtime).handle(
      new Request("http://127.0.0.1/v1/runtime/provider", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-koed-privacy-token": "control-secret"
        },
        body: JSON.stringify({ provider: "cuda", unexpected: true })
      })
    );
    expect(response.status).toBe(422);
    expect(await json(response)).toMatchObject({
      error: { code: "invalid_provider_control" }
    });
  });

  it("reports loading health without accepting classification output", async () => {
    const runtime: PrivacyRuntimeAdapter = {
      modelId: "model",
      modelRevision: "revision",
      classifierHash: "1".repeat(64),
      provider: "cpu",
      isReady: () => false,
      classify: async () => {
        throw new Error("not ready");
      }
    };
    const response = await createPrivacyService(config(), runtime).handle(
      new Request("http://127.0.0.1/health")
    );
    expect(response.status).toBe(503);
    expect((await json(response)).status).toBe("loading");
  });

  it("authenticates before parsing classification content", async () => {
    const service = createPrivacyService(
      config(),
      new DeterministicPrivacyRuntime()
    );
    const missing = await service.handle(classifyRequest("not json"));
    const wrong = await service.handle(
      classifyRequest("not json", { "x-koed-privacy-token": "wrong" })
    );
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect((await json(missing)).error).toMatchObject({ code: "unauthorized" });
  });

  it("fails closed when authentication is not configured", async () => {
    const service = createPrivacyService(
      config({ token: "" }),
      new DeterministicPrivacyRuntime()
    );
    const response = await service.handle(
      classifyRequest(contractBody([{ path: "x", text: "x" }]), {
        "x-koed-privacy-token": "anything"
      })
    );
    expect(response.status).toBe(503);
    expect((await json(response)).error).toMatchObject({
      code: "auth_not_configured"
    });
  });

  it("classifies named fields and applies deterministic secret masking", async () => {
    const service = createPrivacyService(
      config({ maxFields: 3, maxRequestFieldBytes: 300 }),
      new DeterministicPrivacyRuntime()
    );
    const response = await service.handle(
      classifyRequest(
        contractBody([
          { path: "memory.title", text: "Public title" },
          {
            path: "memory.summary",
            text: "api_key=sk-abcdefghijklmnopqrstuv"
          },
          {
            path: "memory.message",
            text: "username: preview-owner password: correct-horse-battery-staple"
          }
        ]),
        { "x-koed-privacy-token": "internal-secret" }
      )
    );
    const payload = await json(response);
    expect(response.status).toBe(200);
    expect(payload.schemaVersion).toBe(1);
    expect(payload.fields).toEqual([
      expect.objectContaining({
        path: "memory.title",
        maskedText: "Public title",
        spans: [],
        decodedTextMatchesInput: true
      }),
      expect.objectContaining({
        path: "memory.summary",
        maskedText: "api_key=[SECRET]",
        spans: [
          expect.objectContaining({
            label: "secret",
            detectors: ["deterministic"]
          })
        ],
        decodedTextMatchesInput: true
      }),
      expect.objectContaining({
        path: "memory.message",
        maskedText: "username: preview-owner password: [SECRET]",
        spans: [
          expect.objectContaining({
            label: "secret",
            detectors: ["deterministic"]
          })
        ],
        decodedTextMatchesInput: true
      })
    ]);
    expect(JSON.stringify(payload)).not.toContain("abcdefghijklmnopqrstuv");
    expect(JSON.stringify(payload)).not.toContain(
      "correct-horse-battery-staple"
    );
  });

  it("enforces media type, body bytes, and schema limits", async () => {
    const service = createPrivacyService(
      config({ maxBodyBytes: 40 }),
      new DeterministicPrivacyRuntime()
    );
    const unsupported = await service.handle(
      new Request("http://127.0.0.1/v1/classify", {
        method: "POST",
        headers: { "x-koed-privacy-token": "internal-secret" },
        body: "{}"
      })
    );
    const oversized = await service.handle(
      classifyRequest("x".repeat(41), {
        "x-koed-privacy-token": "internal-secret"
      })
    );
    expect(unsupported.status).toBe(415);
    expect(oversized.status).toBe(413);
  });

  it("rejects malformed JSON and unknown routes", async () => {
    const service = createPrivacyService(
      config(),
      new DeterministicPrivacyRuntime()
    );
    const malformed = await service.handle(
      classifyRequest("{", { "x-koed-privacy-token": "internal-secret" })
    );
    const missing = await service.handle(new Request("http://127.0.0.1/nope"));
    expect(malformed.status).toBe(422);
    expect(missing.status).toBe(404);
  });

  it("converts malformed runtime output to a fail-closed response", async () => {
    const malformed: PrivacyRuntimeAdapter = {
      modelId: "bad",
      modelRevision: "bad",
      classifierHash: "2".repeat(64),
      provider: "cpu",
      isReady: () => true,
      classify: async (): Promise<RawPrivacyClassification> => ({
        decodedText: "x",
        tokenOffsets: [{ startByte: 0, endByte: 1 }],
        logits: [[1, 2]],
        viterbiBiases: { ...ZERO_VITERBI_BIASES }
      })
    };
    const response = await createPrivacyService(config(), malformed).handle(
      classifyRequest(contractBody([{ path: "summary", text: "x" }]), {
        "x-koed-privacy-token": "internal-secret"
      })
    );
    expect(response.status).toBe(503);
    expect((await json(response)).error).toEqual({
      code: "classification_failed",
      detail: "privacy classification output could not be validated"
    });
  });
});
