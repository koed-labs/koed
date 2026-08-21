import { describe, expect, it, vi } from "vitest";
import { PRIVACY_CLASSIFICATION_CONTRACT_VERSION } from "./privacy-filter-contract.js";
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
