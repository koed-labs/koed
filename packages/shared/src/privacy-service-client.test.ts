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
  it("accepts only the exact authenticated capacity contract", async () => {
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
              maximumConcurrentRequests: PRIVACY_MAX_CONCURRENT_REQUESTS
            }),
            { status: 200 }
          )
      ) as unknown as typeof fetch
    });
    await expect(client.capabilities()).resolves.toMatchObject({
      maximumFieldsPerRequest: 128,
      maximumFieldBytes: 262_144
    });
  });

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
