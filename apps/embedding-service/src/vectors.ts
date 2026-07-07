export const normalizeVector = (vector: number[]): number[] => {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) {
    throw new Error("model returned a zero vector");
  }
  return vector.map((value) => value / norm);
};

const floatVector = (value: unknown): number[] => {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "number" && Number.isFinite(item))
  ) {
    throw new Error("model returned an invalid embedding vector");
  }
  return value.map(Number);
};

export const extractEmbeddingVectors = (result: unknown): number[][] => {
  if (typeof result !== "object" || result === null) {
    throw new Error("model returned an invalid embedding response");
  }
  const data = (result as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new Error("model returned an invalid embedding response");
  }
  return data.map((item) => {
    if (typeof item !== "object" || item === null) {
      throw new Error("model returned an invalid embedding response");
    }
    return floatVector((item as { embedding?: unknown }).embedding);
  });
};

export const normalizeVectors = (vectors: number[][]): number[][] =>
  vectors.map(normalizeVector);
