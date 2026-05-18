import type {
  EmbeddingRequest,
  EmbeddingResult,
  MemorySearchResult
} from "@codex-memory/core";

export type Vector = number[];

export interface ProviderModels {
  embeddingModel: string;
  summaryModel: string;
  answerModel: string;
}

export interface ProviderConfig {
  provider: string;
  apiKey?: string;
  baseUrl?: string;
  embeddingDimensions: number;
  enabled: boolean;
  models: ProviderModels;
}

export interface SummarizePrompt {
  content: string;
  system?: string;
}

export interface AnswerPrompt {
  question: string;
  evidence: MemorySearchResult[];
  system?: string;
}

export interface RerankCandidate {
  id: string;
  text: string;
  score?: number;
}

export interface RerankResult {
  id: string;
  score: number;
}

export interface MemoryModelProvider {
  name: string;
  config: ProviderConfig;
  embed(texts: string[]): Promise<Vector[]>;
  summarize(prompt: SummarizePrompt | string): Promise<string>;
  answer(prompt: AnswerPrompt | string): Promise<string>;
  rerank?(
    query: string,
    candidates: RerankCandidate[]
  ): Promise<RerankResult[]>;
}

export interface ChatRequest {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  model?: string;
}

export interface ChatResult {
  text: string;
  model: string;
}

export interface ModelProvider {
  name: string;
  embed(request: EmbeddingRequest): Promise<EmbeddingResult>;
  chat(request: ChatRequest): Promise<ChatResult>;
}

export class ProviderCallError extends Error {
  readonly provider: string;
  readonly operation: "embed" | "summarize" | "answer" | "rerank";
  readonly status?: number;
  readonly transient: boolean;

  constructor(input: {
    provider: string;
    operation: ProviderCallError["operation"];
    message: string;
    status?: number;
    transient?: boolean;
  }) {
    super(`${input.provider} ${input.operation} failed: ${input.message}`);
    this.name = "ProviderCallError";
    this.provider = input.provider;
    this.operation = input.operation;
    this.status = input.status;
    this.transient = input.transient ?? false;
  }
}

const defaultConfig = (
  overrides: Partial<ProviderConfig> = {}
): ProviderConfig => ({
  provider: overrides.provider ?? "fake",
  apiKey: overrides.apiKey,
  baseUrl: overrides.baseUrl,
  embeddingDimensions: overrides.embeddingDimensions ?? 3,
  enabled: overrides.enabled ?? true,
  models: {
    embeddingModel: overrides.models?.embeddingModel ?? "fake-embedding",
    summaryModel: overrides.models?.summaryModel ?? "fake-summary",
    answerModel: overrides.models?.answerModel ?? "fake-answer"
  }
});

const hashText = (text: string): number =>
  [...text].reduce(
    (sum, char) => (sum * 31 + char.charCodeAt(0)) % 1_000_003,
    17
  );

const fakeVector = (text: string, dimensions: number): Vector => {
  const seed = hashText(text);
  return Array.from(
    { length: dimensions },
    (_, index) => ((seed + index * 97) % 997) / 997
  );
};

const normalizePrompt = (prompt: SummarizePrompt | string): string =>
  typeof prompt === "string" ? prompt : prompt.content;

const evidenceToText = (prompt: AnswerPrompt | string): string => {
  if (typeof prompt === "string") {
    return prompt;
  }

  return [
    prompt.question,
    ...prompt.evidence.map(
      (item, index) =>
        `[${index + 1}] ${item.summaryText} (${item.citation.nodeId})`
    )
  ].join("\n");
};

export class FakeDeterministicProvider implements MemoryModelProvider {
  name = "fake";
  config: ProviderConfig;

  constructor(config: Partial<ProviderConfig> = {}) {
    this.config = defaultConfig(config);
  }

  embed(texts: string[]): Promise<Vector[]> {
    return Promise.resolve(
      texts.map((text) => fakeVector(text, this.config.embeddingDimensions))
    );
  }

  summarize(prompt: SummarizePrompt | string): Promise<string> {
    const text = normalizePrompt(prompt).trim();
    return Promise.resolve(
      text.length <= 240 ? text : `${text.slice(0, 237)}...`
    );
  }

  answer(prompt: AnswerPrompt | string): Promise<string> {
    return Promise.resolve(evidenceToText(prompt));
  }

  rerank(
    _query: string,
    candidates: RerankCandidate[]
  ): Promise<RerankResult[]> {
    return Promise.resolve(
      candidates.map((candidate, index) => ({
        id: candidate.id,
        score: candidate.score ?? 1 / (index + 1)
      }))
    );
  }
}

export class DeterministicProvider implements ModelProvider {
  name = "deterministic";
  config: ProviderConfig;

  constructor(config: Partial<ProviderConfig> = {}) {
    this.config = defaultConfig({ ...config, provider: "deterministic" });
  }

  embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    return Promise.resolve({
      model: request.model ?? this.config.models.embeddingModel,
      embedding: fakeVector(request.input, this.config.embeddingDimensions)
    });
  }

  chat(request: ChatRequest): Promise<ChatResult> {
    const lastUserMessage = [...request.messages]
      .reverse()
      .find((message) => message.role === "user");
    return Promise.resolve({
      model: request.model ?? this.config.models.answerModel,
      text: lastUserMessage?.content ?? ""
    });
  }
}

export interface OpenAICompatibleProviderOptions extends Partial<ProviderConfig> {
  fetchImpl?: typeof fetch;
}

export class OpenAICompatibleProvider implements MemoryModelProvider {
  name: string;
  config: ProviderConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAICompatibleProviderOptions = {}) {
    this.config = defaultConfig({
      provider: options.provider ?? "openai-compatible",
      apiKey: options.apiKey,
      baseUrl: options.baseUrl ?? "https://api.openai.com/v1",
      embeddingDimensions: options.embeddingDimensions ?? 1536,
      enabled: options.enabled ?? true,
      models: {
        embeddingModel:
          options.models?.embeddingModel ?? "text-embedding-3-small",
        summaryModel: options.models?.summaryModel ?? "gpt-5.5",
        answerModel: options.models?.answerModel ?? "gpt-5.5"
      }
    });
    this.name = this.config.provider;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async embed(texts: string[]): Promise<Vector[]> {
    const body = await this.callJson<{ data?: Array<{ embedding?: unknown }> }>(
      "embed",
      "/embeddings",
      {
        model: this.config.models.embeddingModel,
        input: texts,
        dimensions: this.config.embeddingDimensions
      }
    );

    const vectors = body.data?.map((item) => item.embedding);
    if (
      !vectors ||
      vectors.length !== texts.length ||
      vectors.some((vector) => !Array.isArray(vector))
    ) {
      throw new ProviderCallError({
        provider: this.name,
        operation: "embed",
        message: "response did not contain one embedding vector per input"
      });
    }

    return vectors.map((vector) => vector as Vector);
  }

  async summarize(prompt: SummarizePrompt | string): Promise<string> {
    return this.chatCompletion("summarize", this.config.models.summaryModel, [
      {
        role: "system",
        content:
          typeof prompt === "string"
            ? "Summarize the supplied Codex memory content without inventing facts."
            : (prompt.system ??
              "Summarize the supplied Codex memory content without inventing facts.")
      },
      { role: "user", content: normalizePrompt(prompt) }
    ]);
  }

  async answer(prompt: AnswerPrompt | string): Promise<string> {
    if (typeof prompt === "string") {
      return this.chatCompletion("answer", this.config.models.answerModel, [
        {
          role: "system",
          content: "Answer using only the supplied memory evidence."
        },
        { role: "user", content: prompt }
      ]);
    }

    return this.chatCompletion("answer", this.config.models.answerModel, [
      {
        role: "system",
        content:
          prompt.system ??
          "Answer the question using only the supplied Codex memory evidence. Include concise citations using the shown source ids."
      },
      { role: "user", content: evidenceToText(prompt) }
    ]);
  }

  private async chatCompletion(
    operation: "summarize" | "answer",
    model: string,
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>
  ): Promise<string> {
    const body = await this.callJson<{
      choices?: Array<{ message?: { content?: unknown }; text?: unknown }>;
    }>(operation, "/chat/completions", { model, messages });
    const text = body.choices?.[0]?.message?.content ?? body.choices?.[0]?.text;
    if (typeof text !== "string" || text.trim() === "") {
      throw new ProviderCallError({
        provider: this.name,
        operation,
        message: "response did not contain answer text"
      });
    }
    return text;
  }

  private async callJson<T>(
    operation: ProviderCallError["operation"],
    path: string,
    body: unknown
  ): Promise<T> {
    if (!this.config.enabled) {
      throw new ProviderCallError({
        provider: this.name,
        operation,
        message: "provider config is disabled"
      });
    }
    if (!this.config.apiKey) {
      throw new ProviderCallError({
        provider: this.name,
        operation,
        message: "missing API key"
      });
    }

    const baseUrl = (
      this.config.baseUrl ?? "https://api.openai.com/v1"
    ).replace(/\/+$/, "");
    let response: Response;
    try {
      response = await this.fetchImpl(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(body)
      });
    } catch (error) {
      throw new ProviderCallError({
        provider: this.name,
        operation,
        message: error instanceof Error ? error.message : String(error),
        transient: true
      });
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const message = text.slice(0, 500) || `HTTP ${response.status}`;
      throw new ProviderCallError({
        provider: this.name,
        operation,
        status: response.status,
        message,
        transient:
          response.status === 408 ||
          response.status === 409 ||
          response.status === 429 ||
          response.status >= 500
      });
    }

    return (await response.json()) as T;
  }
}

export const createProvider = (config: ProviderConfig): MemoryModelProvider => {
  const provider = config.provider.toLowerCase();
  if (provider === "fake" || provider === "deterministic") {
    return new FakeDeterministicProvider(config);
  }
  if (provider === "openai" || provider === "openai-compatible") {
    return new OpenAICompatibleProvider({
      ...config,
      provider: provider === "openai" ? "openai" : config.provider,
      baseUrl: config.baseUrl ?? "https://api.openai.com/v1"
    });
  }

  throw new ProviderCallError({
    provider: config.provider,
    operation: "answer",
    message: `unsupported provider "${config.provider}"`
  });
};

export const isTransientProviderError = (error: unknown): boolean =>
  error instanceof ProviderCallError
    ? error.transient
    : error instanceof TypeError;
