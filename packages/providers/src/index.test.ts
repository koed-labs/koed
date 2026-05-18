import { describe, expect, it, vi } from "vitest";
import {
  FakeDeterministicProvider,
  OpenAICompatibleProvider,
  ProviderCallError,
  createProvider,
  isTransientProviderError
} from "./index.js";

const jsonBody = <T,>(value: BodyInit | null | undefined): T =>
  JSON.parse(String(value)) as T;

describe("model providers", () => {
  it("uses the fake deterministic provider in tests", async () => {
    const provider = new FakeDeterministicProvider({ embeddingDimensions: 4 });

    await expect(provider.embed(["same", "same"])).resolves.toEqual([
      expect.arrayContaining([expect.any(Number)]),
      expect.arrayContaining([expect.any(Number)])
    ]);
    expect((await provider.embed(["same"]))[0]).toEqual(
      (await provider.embed(["same"]))[0]
    );
    await expect(
      provider.answer({ question: "q", evidence: [] })
    ).resolves.toContain("q");
  });

  it("calls OpenAI-compatible embedding and chat endpoints", async () => {
    const fetchImpl = vi.fn(
      async (url: URL | RequestInfo, init?: RequestInit) => {
        const body = jsonBody<{ model: string; input?: string[] }>(init?.body);
        const urlText = String(url);
        if (urlText.endsWith("/embeddings")) {
          expect(body.model).toBe("embed-model");
          expect(body.input).toEqual(["hello"]);
          return Response.json({ data: [{ embedding: [0.1, 0.2] }] });
        }
        expect(urlText.endsWith("/chat/completions")).toBe(true);
        expect(body.model).toBe("answer-model");
        return Response.json({
          choices: [{ message: { content: "answer text" } }]
        });
      }
    );
    const provider = new OpenAICompatibleProvider({
      provider: "openai-compatible",
      apiKey: "secret",
      baseUrl: "https://models.example.test/v1",
      embeddingDimensions: 2,
      models: {
        embeddingModel: "embed-model",
        summaryModel: "summary-model",
        answerModel: "answer-model"
      },
      fetchImpl
    });

    await expect(provider.embed(["hello"])).resolves.toEqual([[0.1, 0.2]]);
    await expect(provider.answer("Use evidence")).resolves.toBe("answer text");
    const firstCall = fetchImpl.mock.calls[0];
    if (!firstCall) {
      throw new Error("Expected embedding request");
    }
    const [url, init] = firstCall;
    expect(url).toBe("https://models.example.test/v1/embeddings");
    expect(init?.headers).toMatchObject({ authorization: "Bearer secret" });
  });

  it("reports useful transient provider errors", async () => {
    const provider = new OpenAICompatibleProvider({
      apiKey: "secret",
      fetchImpl: vi.fn(
        async () => new Response("rate limited", { status: 429 })
      )
    });

    await expect(provider.embed(["hello"])).rejects.toThrow(
      "openai-compatible embed failed: rate limited"
    );
    try {
      await provider.embed(["hello"]);
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderCallError);
      expect(isTransientProviderError(error)).toBe(true);
    }
  });

  it("does not hardcode OpenAI as the only provider", () => {
    expect(
      createProvider({
        provider: "fake",
        embeddingDimensions: 3,
        enabled: true,
        models: {
          embeddingModel: "fake-embedding",
          summaryModel: "fake-summary",
          answerModel: "fake-answer"
        }
      })
    ).toBeInstanceOf(FakeDeterministicProvider);
  });
});
