import {
  formatEmbeddingRetrievalQuery,
  resolveSupportedEmbeddingModelConfig,
  teamSemanticEmbeddingGeneration
} from "@koed/shared";

export class TeamSemanticEmbeddingError extends Error {
  readonly statusCode: 502 | 503;
  readonly code:
    | "team_embedding_invalid_response"
    | "team_embedding_unavailable";

  constructor(
    code: TeamSemanticEmbeddingError["code"],
    statusCode: TeamSemanticEmbeddingError["statusCode"]
  ) {
    super(
      code === "team_embedding_unavailable"
        ? "Team semantic embedding is temporarily unavailable"
        : "Team semantic embedding returned an invalid response"
    );
    this.name = "TeamSemanticEmbeddingError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface TeamSemanticQueryEmbedding {
  model: string;
  dimensions: 384 | 1024 | 1536 | 3072;
  version: string;
  vector: number[];
}

export const embedTeamSemanticQuery = async (
  query: string,
  fetchFn: typeof fetch = fetch
): Promise<TeamSemanticQueryEmbedding> => {
  const configured = resolveSupportedEmbeddingModelConfig(
    process.env.EMBEDDING_MODEL
  );
  const instructionEnabled =
    configured.key.startsWith("qwen3-") &&
    process.env.EMBEDDING_QUERY_INSTRUCTION_ENABLED !== "false";
  const text = formatEmbeddingRetrievalQuery(query, {
    instruction: process.env.EMBEDDING_QUERY_INSTRUCTION,
    enabled: instructionEnabled
  });
  const baseUrl = (
    process.env.EMBEDDING_SERVICE_URL ?? "http://embedding-service:8000"
  ).replace(/\/+$/, "");
  const token = process.env.EMBEDDING_SERVICE_TOKEN?.trim();
  let response: Response;
  try {
    response = await fetchFn(`${baseUrl}/embed`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-koed-embedding-priority": "interactive",
        ...(token ? { "x-koed-embedding-token": token } : {})
      },
      body: JSON.stringify({ texts: [text] })
    });
  } catch {
    throw new TeamSemanticEmbeddingError("team_embedding_unavailable", 503);
  }
  const rawPayload: unknown = await response.json().catch(() => ({}));
  const payload =
    typeof rawPayload === "object" &&
    rawPayload !== null &&
    !Array.isArray(rawPayload)
      ? (rawPayload as Record<string, unknown>)
      : {};
  if (!response.ok) {
    throw new TeamSemanticEmbeddingError(
      response.status === 429 || response.status >= 500
        ? "team_embedding_unavailable"
        : "team_embedding_invalid_response",
      response.status === 429 || response.status >= 500 ? 503 : 502
    );
  }
  const vector: unknown = Array.isArray(payload.vectors)
    ? payload.vectors[0]
    : undefined;
  if (
    payload.model !== configured.key ||
    payload.dimensions !== configured.dimensions ||
    !Array.isArray(vector) ||
    vector.length !== configured.dimensions ||
    !vector.every(
      (value) => typeof value === "number" && Number.isFinite(value)
    )
  ) {
    throw new TeamSemanticEmbeddingError(
      "team_embedding_invalid_response",
      502
    );
  }
  return {
    model: configured.key,
    dimensions: configured.dimensions as 384 | 1024 | 1536 | 3072,
    version: teamSemanticEmbeddingGeneration({
      model: configured.key,
      tokenizer: configured.tokenizer,
      inputTransform: configured.inputTransform,
      pooling: configured.pooling,
      normalization: configured.normalization
    }),
    vector: vector as number[]
  };
};
