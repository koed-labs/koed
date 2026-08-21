import { describe, expect, it } from "vitest";
import { PRIVACY_CLASSIFICATION_CONTRACT_VERSION } from "@koed/shared";
import type { PrivacyServiceConfig } from "./config.js";
import {
  DeterministicPrivacyRuntime,
  type PrivacyRuntimeAdapter,
  type RawPrivacyClassification
} from "./runtime.js";
import { createPrivacyService } from "./server.js";
import { ZERO_VITERBI_BIASES } from "./decoder.js";

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
  maxFieldChars: 100,
  maxRequestChars: 150,
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
      config({ maxFields: 3, maxRequestChars: 300 }),
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
