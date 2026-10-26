import { describe, expect, it, vi } from "vitest";
import {
  PRIVACY_CLASSIFICATION_CONTRACT_VERSION,
  PRIVACY_CLASSIFICATION_MAX_FIELD_BYTES,
  PRIVACY_CLASSIFICATION_MAX_REQUEST_BODY_BYTES,
  PRIVACY_CLASSIFICATION_MAX_REQUEST_FIELD_BYTES,
  PRIVACY_CLASSIFICATION_REQUEST_FIELD_LIMIT,
  PRIVACY_MAX_CONCURRENT_REQUESTS,
  PRIVACY_MAX_FIELD_TOKENS,
  PRIVACY_WINDOW_CONTEXT_TOKENS,
  PRIVACY_WINDOW_CORE_TOKENS,
  PRIVACY_WINDOW_MAX_TOKENS
} from "./privacy-filter-contract.js";
import {
  SHARED_MEMORY_SEMANTIC_PREVIEW_MAX_BYTES,
  SHARED_MEMORY_SEMANTIC_PREVIEW_MAX_ENCODED_BYTES,
  SHARED_MEMORY_SEMANTIC_PREVIEW_MAX_FIELDS
} from "./shared-memory-semantic-contract.js";
import {
  createPrivacyServiceClient,
  PrivacyServiceContractError,
  PrivacyServiceUnavailableError
} from "./privacy-service-client.js";
import { PRIVACY_CLASSIFICATION_STREAM_TYPE } from "./privacy-classification-transport.js";

const hash = "a".repeat(64);

const responseFor = (text: string, path = "/content/text") =>
  new Response(
    JSON.stringify({
      schemaVersion: 1,
      inputContractVersion: PRIVACY_CLASSIFICATION_CONTRACT_VERSION,
      classifier: {
        classifierHash: hash,
        modelKey: "openai/privacy-filter",
        modelRevision: "pinned"
      },
      fields: [
        {
          path,
          inputSha256:
            text === "Ada"
              ? "99a563ab2f6e21e96998f9fddd2a2bab82b70ac019579502b8d7fc0032ff62bb"
              : hash,
          inputByteLength: Buffer.byteLength(text),
          maskedText: text,
          spans: [],
          decodedTextMatchesInput: true
        }
      ]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );

describe("Privacy Service client", () => {
  it("keeps a long request alive only while bounded inference progress advances", async () => {
    vi.useFakeTimers();
    try {
      let output!: ReadableStreamDefaultController<Uint8Array>;
      const body: unknown = await responseFor("Ada").json();
      const client = createPrivacyServiceClient({
        baseUrl: "http://127.0.0.1:8092",
        token: "token",
        timeoutMs: 100,
        fetchImpl: vi.fn(
          async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  output = controller;
                }
              }),
              {
                headers: { "content-type": PRIVACY_CLASSIFICATION_STREAM_TYPE }
              }
            )
        )
      });
      const result = client.classify([{ path: "/content/text", text: "Ada" }]);
      await vi.advanceTimersByTimeAsync(0);
      for (let unit = 1; unit <= 3; unit += 1) {
        await vi.advanceTimersByTimeAsync(90);
        output.enqueue(
          new TextEncoder().encode(
            JSON.stringify({ type: "progress", completedUnits: unit }) + "\n"
          )
        );
        await vi.advanceTimersByTimeAsync(0);
      }
      output.enqueue(
        new TextEncoder().encode(
          JSON.stringify({
            type: "result",
            status: 200,
            retryAfter: false,
            body
          }) + "\n"
        )
      );
      output.close();
      await expect(result).resolves.toMatchObject({
        classifier: { classifierHash: hash }
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a stalled progress stream without immediately submitting another request", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        async () =>
          new Response(new ReadableStream(), {
            headers: { "content-type": PRIVACY_CLASSIFICATION_STREAM_TYPE }
          })
      );
      const client = createPrivacyServiceClient({
        baseUrl: "http://127.0.0.1:8092",
        token: "token",
        timeoutMs: 100,
        fetchImpl
      });
      const result = expect(
        client.classify([{ path: "/content/text", text: "Ada" }])
      ).rejects.toBeInstanceOf(PrivacyServiceUnavailableError);
      await vi.advanceTimersByTimeAsync(101);
      await result;
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([{ units: [1, 1] }, { units: [99] }, { units: [1] }])(
    "rejects repeated, excessive, or incomplete progress $units",
    async ({ units }) => {
      const fetchImpl = vi.fn(
        async () =>
          new Response(
            units
              .map(
                (completedUnits) =>
                  JSON.stringify({ type: "progress", completedUnits }) + "\n"
              )
              .join(""),
            { headers: { "content-type": PRIVACY_CLASSIFICATION_STREAM_TYPE } }
          )
      );
      const client = createPrivacyServiceClient({
        baseUrl: "http://127.0.0.1:8092",
        token: "token",
        fetchImpl
      });
      await expect(
        client.classify([{ path: "/content/text", text: "Ada" }])
      ).rejects.toBeInstanceOf(PrivacyServiceContractError);
      expect(fetchImpl).toHaveBeenCalledOnce();
    }
  );
  it.each(["timeout", "capacity"])(
    "defers %s to durable retry without immediate resubmission",
    async (failure) => {
      const fetchImpl = vi.fn(async () => {
        if (failure === "timeout")
          throw new DOMException("timed out", "TimeoutError");
        return new Response(null, {
          status: 503,
          headers: { "retry-after": "1" }
        });
      });
      const client = createPrivacyServiceClient({
        baseUrl: "http://127.0.0.1:8092",
        token: "token",
        fetchImpl
      });
      await expect(
        client.classify([{ path: "text", text: "hello" }])
      ).rejects.toBeInstanceOf(PrivacyServiceUnavailableError);
      expect(fetchImpl).toHaveBeenCalledOnce();
    }
  );
  it.each([1, PRIVACY_MAX_CONCURRENT_REQUESTS, 0, 3])(
    "validates authenticated profile capacity %s",
    async (capacity) => {
      const client = createPrivacyServiceClient({
        baseUrl: "http://127.0.0.1:8092",
        token: "token",
        fetchImpl: vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                schemaVersion: 1,
                inputContractVersion: PRIVACY_CLASSIFICATION_CONTRACT_VERSION,
                tokenizerSha256: hash,
                tokenizerNormalization: "none",
                maximumFieldsPerRequest:
                  PRIVACY_CLASSIFICATION_REQUEST_FIELD_LIMIT,
                maximumFieldBytes: PRIVACY_CLASSIFICATION_MAX_FIELD_BYTES,
                maximumRequestFieldBytes:
                  PRIVACY_CLASSIFICATION_MAX_REQUEST_FIELD_BYTES,
                maximumRequestBodyBytes:
                  PRIVACY_CLASSIFICATION_MAX_REQUEST_BODY_BYTES,
                windowCoreTokens: PRIVACY_WINDOW_CORE_TOKENS,
                windowContextTokens: PRIVACY_WINDOW_CONTEXT_TOKENS,
                windowMaximumTokens: PRIVACY_WINDOW_MAX_TOKENS,
                maximumFieldTokens: PRIVACY_MAX_FIELD_TOKENS,
                maximumSemanticPreviewFields:
                  SHARED_MEMORY_SEMANTIC_PREVIEW_MAX_FIELDS,
                maximumSemanticPreviewBytes:
                  SHARED_MEMORY_SEMANTIC_PREVIEW_MAX_BYTES,
                maximumSemanticPreviewEncodedBytes:
                  SHARED_MEMORY_SEMANTIC_PREVIEW_MAX_ENCODED_BYTES,
                maximumConcurrentRequests: capacity
              }),
              { status: 200 }
            )
        ) as unknown as typeof fetch
      });
      if (capacity === 0 || capacity === 3) {
        await expect(client.capabilities()).rejects.toThrow();
        return;
      }
      await expect(client.capabilities()).resolves.toMatchObject({
        maximumConcurrentRequests: capacity,
        maximumFieldsPerRequest: 128,
        maximumFieldBytes: 262_144
      });
    }
  );

  it("authenticates and verifies response binding", async () => {
    const fetchImpl = vi.fn(
      async (
        _url: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1]
      ) => {
        expect(new Headers(init?.headers).get("x-koed-privacy-token")).toBe(
          "token"
        );
        return responseFor("Ada");
      }
    ) as unknown as typeof fetch;
    const client = createPrivacyServiceClient({
      baseUrl: "http://127.0.0.1:8092",
      token: "token",
      fetchImpl
    });
    await expect(
      client.classify([{ path: "/content/text", text: "Ada" }])
    ).resolves.toMatchObject({ classifier: { classifierHash: hash } });
  });

  it("fails closed when the service binds a different path", async () => {
    const client = createPrivacyServiceClient({
      baseUrl: "http://127.0.0.1:8092",
      token: "token",
      fetchImpl: vi.fn(async () =>
        responseFor("Ada", "/wrong")
      ) as unknown as typeof fetch
    });
    await expect(
      client.classify([{ path: "/content/text", text: "Ada" }])
    ).rejects.toBeInstanceOf(PrivacyServiceContractError);
  });

  it("retries transient failures but not invalid contracts", async () => {
    const transient = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(responseFor("Ada")) as unknown as typeof fetch;
    await createPrivacyServiceClient({
      baseUrl: "http://127.0.0.1:8092",
      token: "token",
      fetchImpl: transient
    }).classify([{ path: "/content/text", text: "Ada" }]);
    expect(transient).toHaveBeenCalledTimes(2);

    const unavailable = createPrivacyServiceClient({
      baseUrl: "http://127.0.0.1:8092",
      token: "token",
      maxAttempts: 1,
      fetchImpl: vi.fn(
        async () => new Response(null, { status: 503 })
      ) as unknown as typeof fetch
    });
    await expect(
      unavailable.classify([{ path: "/content/text", text: "Ada" }])
    ).rejects.toBeInstanceOf(PrivacyServiceUnavailableError);
  });
});
